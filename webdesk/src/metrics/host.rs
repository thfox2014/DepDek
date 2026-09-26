//! Host-level facts: CPU, memory, disks, network interfaces.
//!
//! Everything here is read-only and derived from `/proc` via `sysinfo` plus
//! `/proc/diskstats` for per-second disk throughput (sysinfo does not expose
//! device IO counters).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use sysinfo::{Disks, Networks, System};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HostInfo {
    pub hostname: String,
    pub os_name: String,
    pub os_version: String,
    pub kernel: String,
    pub uptime_secs: u64,
    pub cores_logical: usize,
    pub cores_physical: usize,
    pub cpu_brand: String,
    pub cpu_frequency_mhz: u64,
    pub sampled_at_ms: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MemorySummary {
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub available_bytes: u64,
    pub used_pct: f32,
    pub swap_total_bytes: u64,
    pub swap_used_bytes: u64,
    pub swap_used_pct: f32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CoreUsage {
    pub index: usize,
    pub usage_pct: f32,
    pub frequency_mhz: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CpuSummary {
    pub usage_pct: f32,
    pub per_core: Vec<CoreUsage>,
    pub load1: f64,
    pub load5: f64,
    pub load15: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DiskSummary {
    pub name: String,
    pub file_system: String,
    pub mount_point: String,
    pub kind: String,
    pub removable: bool,
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub used_bytes: u64,
    pub used_pct: f32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DiskThroughput {
    pub read_bytes_per_sec: f64,
    pub write_bytes_per_sec: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NetworkSummary {
    pub name: String,
    pub received_bytes: u64,
    pub transmitted_bytes: u64,
    pub rx_bytes_per_sec: f64,
    pub tx_bytes_per_sec: f64,
    pub errors: u64,
}

pub fn host_info(sys: &System) -> HostInfo {
    let cpu = sys.cpus().first();
    HostInfo {
        hostname: System::host_name().unwrap_or_else(|| "unknown".into()),
        os_name: System::name().unwrap_or_else(|| "Linux".into()),
        os_version: System::os_version().unwrap_or_else(|| "unknown".into()),
        kernel: System::kernel_version().unwrap_or_else(|| "unknown".into()),
        uptime_secs: System::uptime(),
        cores_logical: sys.cpus().len(),
        cores_physical: System::physical_core_count().unwrap_or_else(|| sys.cpus().len()),
        cpu_brand: cpu.map(|cpu| cpu.brand().trim().to_string()).unwrap_or_default(),
        cpu_frequency_mhz: cpu.map(|cpu| cpu.frequency()).unwrap_or_default(),
        sampled_at_ms: crate::util::now_ms(),
    }
}

pub fn memory_summary(sys: &System) -> MemorySummary {
    let total = sys.total_memory();
    let used = sys.used_memory();
    let swap_total = sys.total_swap();
    let swap_used = sys.used_swap();
    MemorySummary {
        total_bytes: total,
        used_bytes: used,
        available_bytes: sys.available_memory(),
        used_pct: percent(used, total),
        swap_total_bytes: swap_total,
        swap_used_bytes: swap_used,
        swap_used_pct: percent(swap_used, swap_total),
    }
}

pub fn cpu_summary(sys: &System) -> CpuSummary {
    let load = System::load_average();
    CpuSummary {
        usage_pct: sys.global_cpu_usage(),
        per_core: sys
            .cpus()
            .iter()
            .enumerate()
            .map(|(index, cpu)| CoreUsage {
                index,
                usage_pct: cpu.cpu_usage(),
                frequency_mhz: cpu.frequency(),
            })
            .collect(),
        load1: load.one,
        load5: load.five,
        load15: load.fifteen,
    }
}

pub fn disks(disks: &Disks) -> Vec<DiskSummary> {
    disks
        .list()
        .iter()
        .filter(|disk| disk.total_space() > 0)
        .map(|disk| {
            let total = disk.total_space();
            let available = disk.available_space();
            let used = total.saturating_sub(available);
            DiskSummary {
                name: disk.name().to_string_lossy().to_string(),
                file_system: disk.file_system().to_string_lossy().to_string(),
                mount_point: disk.mount_point().to_string_lossy().to_string(),
                kind: format!("{:?}", disk.kind()),
                removable: disk.is_removable(),
                total_bytes: total,
                available_bytes: available,
                used_bytes: used,
                used_pct: percent(used, total),
            }
        })
        .collect()
}

/// Byte-per-second rates per interface, given the previous totals.
pub fn networks(networks: &Networks, previous: &HashMap<String, (u64, u64)>, elapsed_ms: u64) -> Vec<NetworkSummary> {
    let seconds = (elapsed_ms as f64 / 1000.0).max(0.001);
    let mut result: Vec<NetworkSummary> = networks
        .list()
        .iter()
        .map(|(name, data)| {
            let received = data.total_received();
            let transmitted = data.total_transmitted();
            let (prev_rx, prev_tx) = previous.get(name).copied().unwrap_or((received, transmitted));
            NetworkSummary {
                name: name.clone(),
                received_bytes: received,
                transmitted_bytes: transmitted,
                rx_bytes_per_sec: received.saturating_sub(prev_rx) as f64 / seconds,
                tx_bytes_per_sec: transmitted.saturating_sub(prev_tx) as f64 / seconds,
                errors: data.total_errors_on_received().saturating_add(data.total_errors_on_transmitted()),
            }
        })
        .filter(|interface| interface.received_bytes > 0 || interface.transmitted_bytes > 0)
        .collect();
    result.sort_by(|a, b| a.name.cmp(&b.name));
    result
}

pub fn network_totals(networks: &Networks) -> HashMap<String, (u64, u64)> {
    networks
        .list()
        .iter()
        .map(|(name, data)| (name.clone(), (data.total_received(), data.total_transmitted())))
        .collect()
}

/// Aggregate whole-disk throughput from `/proc/diskstats` (sectors are 512B).
///
/// Only whole devices are counted (`sda`, `nvme0n1`, `vda`, …); partitions and
/// loop/ram devices are skipped so the number matches "磁盘 IO" as users expect.
pub fn disk_throughput() -> HashMap<String, (u64, u64)> {
    let mut result = HashMap::new();
    let Ok(raw) = std::fs::read_to_string("/proc/diskstats") else {
        return result;
    };
    for line in raw.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 10 {
            continue;
        }
        let name = fields[2];
        if is_partition_or_virtual(name) {
            continue;
        }
        let read_sectors: u64 = fields[5].parse().unwrap_or(0);
        let written_sectors: u64 = fields[9].parse().unwrap_or(0);
        result.insert(name.to_string(), (read_sectors * 512, written_sectors * 512));
    }
    result
}

fn is_partition_or_virtual(name: &str) -> bool {
    if name.starts_with("loop") || name.starts_with("ram") || name.starts_with("zram") {
        return true;
    }
    if name.starts_with("nvme") || name.starts_with("mmcblk") {
        // nvme0n1 / nvme0n1p2, mmcblk0 / mmcblk0p1
        return name.contains('p') && name.rsplit('p').next().is_some_and(|tail| tail.chars().all(|c| c.is_ascii_digit()));
    }
    // sda / sda1, vda / vda2, hda / hda3
    let tail_digits = name.chars().rev().take_while(|c| c.is_ascii_digit()).count();
    tail_digits > 0
}

pub fn percent(part: u64, total: u64) -> f32 {
    if total == 0 {
        return 0.0;
    }
    (part as f64 / total as f64 * 100.0) as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_handles_zero_and_normal_cases() {
        assert_eq!(percent(0, 0), 0.0);
        assert!((percent(1, 4) - 25.0).abs() < f32::EPSILON);
    }

    #[test]
    fn partition_detection_matches_common_device_names() {
        assert!(!is_partition_or_virtual("sda"));
        assert!(is_partition_or_virtual("sda1"));
        assert!(!is_partition_or_virtual("nvme0n1"));
        assert!(is_partition_or_virtual("nvme0n1p2"));
        assert!(is_partition_or_virtual("loop0"));
        assert!(is_partition_or_virtual("zram0"));
        assert!(!is_partition_or_virtual("vda"));
        assert!(is_partition_or_virtual("vda2"));
    }

    #[test]
    fn collects_live_host_facts() {
        let mut sys = System::new_all();
        sys.refresh_cpu_all();
        sys.refresh_memory();
        let info = host_info(&sys);
        assert!(info.cores_logical >= 1);
        assert!(!info.hostname.is_empty());
        let memory = memory_summary(&sys);
        assert!(memory.total_bytes > 0);
        assert!(memory.used_bytes <= memory.total_bytes);
        assert!((0.0..=100.0).contains(&memory.used_pct));
        let cpu = cpu_summary(&sys);
        assert!(cpu.per_core.len() >= 1);
        assert!((0.0..=100.0).contains(&cpu.usage_pct));
    }
}
