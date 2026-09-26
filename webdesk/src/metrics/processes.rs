//! Per-process and per-application resource accounting.
//!
//! "应用程序" is derived from the systemd cgroup of each PID
//! (`/proc/<pid>/cgroup`), which is exactly how an appliance user thinks about
//! load: the DepDek shell, its Node sidecar, Ollama, a browser… Each group sums
//! the CPU/memory of the processes inside it, and falls back to the executable
//! name when a process has no useful cgroup (containers, foreign kernels).

use std::collections::HashMap;
use std::fs;

use serde::{Deserialize, Serialize};
use sysinfo::Process;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessUsage {
    pub pid: u32,
    pub name: String,
    pub exe: Option<String>,
    pub cmd: String,
    /// Percent of a single core (may exceed 100 on multi-core hosts).
    pub cpu_pct: f32,
    /// Percent of the whole machine, i.e. `cpu_pct / cores`.
    pub cpu_pct_total: f32,
    pub mem_bytes: u64,
    pub virtual_bytes: u64,
    pub status: String,
    pub run_time_secs: u64,
    pub disk_read_bytes: u64,
    pub disk_write_bytes: u64,
    /// cgroup-derived application key ("app" fallback: executable name).
    pub app_key: String,
    /// Human readable application label.
    pub app_label: String,
    /// True when the key came from a systemd unit instead of the binary name.
    pub app_from_unit: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppUsage {
    pub key: String,
    pub label: String,
    pub from_unit: bool,
    pub processes: usize,
    pub cpu_pct: f32,
    pub cpu_pct_total: f32,
    pub mem_bytes: u64,
    pub disk_read_bytes: u64,
    pub disk_write_bytes: u64,
    /// PIDs sorted by memory, capped for the UI.
    pub top_pids: Vec<u32>,
}

/// Cgroup units that only describe the login session, not an application.
const GENERIC_UNITS: [&str; 6] = [
    "app.slice",
    "user.slice",
    "system.slice",
    "init.scope",
    "session.slice",
    "background.slice",
];

/// Read the systemd **service** unit of a PID, if it has one.
///
/// Only `.service` units are accepted: desktop applications run inside
/// transient `app-*.scope` / `dsh-subprocess-*.scope` units whose names say
/// nothing useful about the application, so those fall back to the executable
/// (and to the command line heuristics in [`command_key`]).
pub fn cgroup_unit(pid: u32) -> Option<String> {
    let raw = fs::read_to_string(format!("/proc/{pid}/cgroup")).ok()?;
    // Format: "<hierarchy>:<controllers>:<path>" (cgroup v2 uses "0::<path>").
    for line in raw.lines() {
        let mut parts = line.splitn(3, ':');
        let (_hierarchy, _controllers, path) = (parts.next()?, parts.next()?, parts.next()?);
        let path = path.trim();
        if path.is_empty() || path == "/" {
            continue;
        }
        let leaf = path.rsplit('/').find(|segment| !segment.is_empty())?;
        let unit = leaf.trim_end_matches(".service");
        if unit.is_empty() || GENERIC_UNITS.contains(&leaf) || GENERIC_UNITS.contains(&unit) {
            continue;
        }
        if !leaf.ends_with(".service") {
            continue;
        }
        return Some(unit.to_string());
    }
    None
}

/// Recognise applications that share a runtime binary (all Node processes would
/// otherwise be one bucket).
pub fn command_key(exe: &str, cmd: &str) -> Option<&'static str> {
    let exe = exe.to_ascii_lowercase();
    let cmd = cmd.to_ascii_lowercase();
    let is_node = exe == "node" || exe.starts_with("node") || exe == "npm" || cmd.contains("node ");
    if is_node && (cmd.contains("sidecar") || cmd.contains("agent-workbench")) {
        return Some("depdek-sidecar");
    }
    if cmd.contains("ollama") || exe.starts_with("ollama") {
        return Some("ollama");
    }
    if cmd.contains("depdek-webdesk") || exe.starts_with("depdek-webdesk") {
        return Some("depdek-webdesk");
    }
    None
}

/// Readable label for a cgroup unit or executable name.
pub fn app_label(key: &str) -> String {
    let lowered = key.to_ascii_lowercase();
    let known = [
        ("agent-workbench", "DepDek 主程序"),
        // Specific keys must precede the generic "depdek" entry.
        ("depdek-sidecar", "DepDek Sidecar"),
        ("depdek-webdesk", "DepDek Webdesk"),
        ("depdek", "DepDek"),
        ("sidecar", "DepDek Sidecar"),
        ("ollama", "Ollama 模型服务"),
        ("node", "Node 运行时"),
        ("firefox", "Firefox"),
        ("chrome", "Chrome"),
        ("chromium", "Chromium"),
        ("gnome-shell", "GNOME Shell"),
        ("gnome-terminal", "终端"),
        ("pipewire", "PipeWire 音频"),
        ("pulseaudio", "PulseAudio"),
        ("systemd", "systemd"),
        ("packagekit", "PackageKit"),
        ("tracker-miner", "Tracker 索引"),
        ("dockerd", "Docker"),
        ("containerd", "containerd"),
        ("sshd", "SSH 服务"),
        ("cups", "打印服务"),
        ("smbd", "Samba 共享"),
        ("nginx", "Nginx"),
        ("postgres", "PostgreSQL"),
        ("mysqld", "MySQL"),
        ("python3", "Python"),
    ];
    for (needle, label) in known {
        if lowered.contains(needle) {
            return label.to_string();
        }
    }
    // "gnome-terminal-server" -> "Gnome Terminal Server"
    let text = key.replace(['-', '_', '.'], " ");
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return "未知".into();
    }
    text.split(' ')
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn executable_name(process: &Process) -> Option<String> {
    process
        .exe()
        .and_then(|path| path.file_name())
        .map(|name| name.to_string_lossy().to_string())
        .or_else(|| {
            let name = process.name().to_string_lossy().to_string();
            if name.is_empty() {
                None
            } else {
                Some(name)
            }
        })
}

/// Snapshot one process, resolving its application group.
pub fn describe(process: &Process, cores: usize) -> ProcessUsage {
    let pid = process.pid().as_u32();
    let exe = executable_name(process);
    let name = process.name().to_string_lossy().to_string();
    let cmd = process
        .cmd()
        .iter()
        .map(|part| part.to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join(" ");
    let cpu_pct = process.cpu_usage();
    let cores = cores.max(1) as f32;
    let exe_key = exe.clone().unwrap_or_else(|| {
        if name.is_empty() {
            format!("pid-{pid}")
        } else {
            name.clone()
        }
    });
    let (app_key, from_unit) = match cgroup_unit(pid) {
        Some(unit) => (unit, true),
        None => match command_key(exe_key.as_str(), &cmd) {
            Some(key) => (key.to_string(), false),
            None => (exe_key, false),
        },
    };
    let disk = process.disk_usage();
    ProcessUsage {
        pid,
        name: if name.is_empty() {
            app_key.clone()
        } else {
            name
        },
        exe,
        cmd,
        cpu_pct,
        cpu_pct_total: cpu_pct / cores,
        mem_bytes: process.memory(),
        virtual_bytes: process.virtual_memory(),
        status: format!("{:?}", process.status()),
        run_time_secs: process.run_time(),
        disk_read_bytes: disk.read_bytes,
        disk_write_bytes: disk.written_bytes,
        app_label: app_label(&app_key),
        app_key,
        app_from_unit: from_unit,
    }
}

/// Group processes into applications, biggest CPU/memory consumer first.
pub fn aggregate(processes: &[ProcessUsage], cores: usize, limit: usize) -> Vec<AppUsage> {
    let mut buckets: HashMap<&str, AppUsage> = HashMap::new();
    for process in processes {
        let entry = buckets
            .entry(process.app_key.as_str())
            .or_insert_with(|| AppUsage {
                key: process.app_key.clone(),
                label: process.app_label.clone(),
                from_unit: process.app_from_unit,
                processes: 0,
                cpu_pct: 0.0,
                cpu_pct_total: 0.0,
                mem_bytes: 0,
                disk_read_bytes: 0,
                disk_write_bytes: 0,
                top_pids: Vec::new(),
            });
        entry.processes += 1;
        entry.cpu_pct += process.cpu_pct;
        entry.mem_bytes += process.mem_bytes;
        entry.disk_read_bytes += process.disk_read_bytes;
        entry.disk_write_bytes += process.disk_write_bytes;
        entry.top_pids.push(process.pid);
        // A unit-derived group wins over a binary-name group with the same key.
        entry.from_unit |= process.app_from_unit;
    }

    let cores = cores.max(1) as f32;
    let mut apps: Vec<AppUsage> = buckets
        .into_values()
        .map(|mut app| {
            app.cpu_pct_total = app.cpu_pct / cores;
            app.top_pids.sort_unstable();
            app.top_pids.truncate(5);
            app
        })
        .collect();
    apps.sort_by(|a, b| {
        b.cpu_pct
            .partial_cmp(&a.cpu_pct)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.mem_bytes.cmp(&a.mem_bytes))
    });
    if limit > 0 {
        apps.truncate(limit);
    }
    apps
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(pid: u32, key: &str, cpu: f32, mem: u64, from_unit: bool) -> ProcessUsage {
        ProcessUsage {
            pid,
            name: key.into(),
            exe: Some(key.into()),
            cmd: String::new(),
            cpu_pct: cpu,
            cpu_pct_total: cpu / 4.0,
            mem_bytes: mem,
            virtual_bytes: mem,
            status: "Run".into(),
            run_time_secs: 1,
            disk_read_bytes: 0,
            disk_write_bytes: 0,
            app_key: key.into(),
            app_label: app_label(key),
            app_from_unit: from_unit,
        }
    }

    #[test]
    fn aggregates_by_application_and_sorts_by_cpu() {
        let processes = vec![
            usage(1, "depdek-webdesk", 10.0, 100, true),
            usage(2, "depdek-webdesk", 30.0, 200, true),
            usage(3, "firefox", 5.0, 900, false),
        ];
        let apps = aggregate(&processes, 4, 10);
        assert_eq!(apps.len(), 2);
        assert_eq!(apps[0].key, "depdek-webdesk");
        assert_eq!(apps[0].processes, 2);
        assert_eq!(apps[0].cpu_pct, 40.0);
        assert!((apps[0].cpu_pct_total - 10.0).abs() < f32::EPSILON);
        assert_eq!(apps[0].mem_bytes, 300);
        assert_eq!(apps[0].label, "DepDek Webdesk");
        assert_eq!(apps[1].label, "Firefox");
        assert_eq!(apps[1].mem_bytes, 900);
    }

    #[test]
    fn limits_and_keeps_top_pids() {
        let processes: Vec<ProcessUsage> = (0..8)
            .map(|index| usage(index + 1, "one-app", index as f32, 1, false))
            .collect();
        let apps = aggregate(&processes, 1, 1);
        assert_eq!(apps.len(), 1);
        assert_eq!(apps[0].processes, 8);
        assert_eq!(apps[0].top_pids.len(), 5, "top_pids 截断到 5 个");

        // Two applications, limit 1: the busier one wins.
        let mixed = vec![
            usage(1, "idle-app", 1.0, 10, true),
            usage(2, "busy-app", 10.0, 10, true),
            usage(3, "busy-app", 12.0, 10, true),
        ];
        let apps = aggregate(&mixed, 1, 1);
        assert_eq!(apps.len(), 1);
        assert_eq!(apps[0].key, "busy-app");
        assert_eq!(apps[0].processes, 2);
    }

    #[test]
    fn labels_known_components_and_prettifies_unknown_ones() {
        assert_eq!(app_label("agent-workbench"), "DepDek 主程序");
        assert_eq!(app_label("depdek-sidecar"), "DepDek Sidecar");
        assert_eq!(app_label("gnome-terminal-server"), "终端");
        assert_eq!(app_label("some-random_unit"), "Some Random Unit");
        assert_eq!(app_label(""), "未知");
    }

    #[test]
    fn command_key_separates_node_based_services() {
        assert_eq!(
            command_key("node", "node sidecar.mjs --stdio"),
            Some("depdek-sidecar")
        );
        assert_eq!(command_key("ollama", "ollama serve"), Some("ollama"));
        assert_eq!(
            command_key("depdek-webdesk", "depdek-webdesk serve"),
            Some("depdek-webdesk")
        );
        assert_eq!(command_key("node", "node esbuild.mjs"), None);
        assert_eq!(command_key("firefox", "/usr/lib/firefox/firefox"), None);
    }

    #[test]
    fn cgroup_of_own_process_is_readable_or_absent() {
        // The sandbox may hide /proc; both outcomes must be handled.
        let pid = std::process::id();
        if let Some(unit) = cgroup_unit(pid) {
            assert!(!unit.is_empty());
            assert!(!unit.ends_with(".scope"), "只接受 .service 单元：{unit}");
        }
    }
}
