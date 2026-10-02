//! Metrics collection: a background sampler that keeps a short in-memory
//! history plus the latest process/application snapshot.
//!
//! The sampler owns the `sysinfo` handles (they are stateful: CPU percentages
//! come from the delta between two refreshes) and publishes immutable snapshots
//! to the HTTP layer through an `RwLock`.

pub mod host;
pub mod processes;

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sysinfo::{Disks, Networks, ProcessesToUpdate, System, MINIMUM_CPU_UPDATE_INTERVAL};

pub use host::{CpuSummary, DiskSummary, DiskThroughput, HostInfo, MemorySummary, NetworkSummary};
pub use processes::{AppUsage, ProcessUsage};

/// How many applications the sampler keeps in the snapshot.
const APP_LIMIT: usize = 24;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Sample {
    pub ts_ms: u64,
    pub cpu_pct: f32,
    pub per_core_pct: Vec<f32>,
    pub mem_pct: f32,
    pub mem_used_bytes: u64,
    pub swap_pct: f32,
    pub load1: f64,
    pub net_rx_bps: f64,
    pub net_tx_bps: f64,
    pub disk_read_bps: f64,
    pub disk_write_bps: f64,
    pub process_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortKey {
    Cpu,
    Memory,
    Disk,
}

impl SortKey {
    pub fn parse(raw: Option<&str>) -> Self {
        match raw.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
            Some("mem") | Some("memory") => SortKey::Memory,
            Some("disk") | Some("io") => SortKey::Disk,
            _ => SortKey::Cpu,
        }
    }
}

/// Latest published snapshot. Serialised straight into API responses.
#[derive(Debug, Default, Serialize)]
pub struct Metrics {
    pub host: HostInfo,
    pub cpu: CpuSummary,
    pub memory: MemorySummary,
    pub disks: Vec<DiskSummary>,
    pub networks: Vec<NetworkSummary>,
    pub disk_io: DiskThroughput,
    pub processes: Vec<ProcessUsage>,
    pub apps: Vec<AppUsage>,
    pub history: VecDeque<Sample>,
    pub sampled_at_ms: u64,
    pub sample_count: u64,
    pub interval_ms: u64,
}

impl Metrics {
    /// Newest-last window over the ring buffer.
    pub fn series(&self, window: usize) -> Vec<Sample> {
        let skip = self.history.len().saturating_sub(window);
        self.history.iter().skip(skip).cloned().collect()
    }

    pub fn top_processes(&self, sort: SortKey, limit: usize) -> Vec<ProcessUsage> {
        let mut processes = self.processes.clone();
        processes.sort_by(|a, b| match sort {
            SortKey::Cpu => b
                .cpu_pct
                .partial_cmp(&a.cpu_pct)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| b.mem_bytes.cmp(&a.mem_bytes)),
            SortKey::Memory => b.mem_bytes.cmp(&a.mem_bytes).then_with(|| {
                b.cpu_pct
                    .partial_cmp(&a.cpu_pct)
                    .unwrap_or(std::cmp::Ordering::Equal)
            }),
            SortKey::Disk => (b.disk_read_bytes + b.disk_write_bytes)
                .cmp(&(a.disk_read_bytes + a.disk_write_bytes))
                .then_with(|| {
                    b.cpu_pct
                        .partial_cmp(&a.cpu_pct)
                        .unwrap_or(std::cmp::Ordering::Equal)
                }),
        });
        if limit > 0 {
            processes.truncate(limit);
        }
        processes
    }
}

/// Stateful sampler. One instance owns the `sysinfo` handles.
pub struct Collector {
    sys: System,
    disks: Disks,
    networks: Networks,
    previous_net: HashMap<String, (u64, u64)>,
    previous_disk: HashMap<String, (u64, u64)>,
    previous_at_ms: u64,
    cores: usize,
}

impl Collector {
    pub fn new() -> Self {
        let mut sys = System::new_all();
        sys.refresh_cpu_all();
        sys.refresh_memory();
        // CPU percentages are deltas; a single refresh always reports 0.
        std::thread::sleep(MINIMUM_CPU_UPDATE_INTERVAL);
        sys.refresh_cpu_all();

        let disks = Disks::new_with_refreshed_list();
        let networks = Networks::new_with_refreshed_list();
        let previous_net = host::network_totals(&networks);
        let previous_disk = host::disk_throughput();
        let cores = sys.cpus().len().max(1);
        Self {
            sys,
            disks,
            networks,
            previous_net,
            previous_disk,
            previous_at_ms: crate::util::now_ms(),
            cores,
        }
    }

    /// Refresh everything and publish a new snapshot.
    pub fn sample(&mut self, metrics: &mut Metrics, history: usize, interval_ms: u64) {
        self.sys.refresh_cpu_all();
        self.sys.refresh_memory();
        self.sys.refresh_processes(ProcessesToUpdate::All, true);
        self.disks.refresh(true);
        self.networks.refresh(true);

        let now = crate::util::now_ms();
        let elapsed_ms = now.saturating_sub(self.previous_at_ms).max(1);

        let cpu = host::cpu_summary(&self.sys);
        let memory = host::memory_summary(&self.sys);
        let networks = host::networks(&self.networks, &self.previous_net, elapsed_ms);
        let disk_totals = host::disk_throughput();

        let net_rx_bps: f64 = networks
            .iter()
            .map(|interface| interface.rx_bytes_per_sec)
            .sum();
        let net_tx_bps: f64 = networks
            .iter()
            .map(|interface| interface.tx_bytes_per_sec)
            .sum();

        let mut disk_read = 0u64;
        let mut disk_write = 0u64;
        for (device, (read, written)) in &disk_totals {
            let (prev_read, prev_write) = self
                .previous_disk
                .get(device)
                .copied()
                .unwrap_or((*read, *written));
            disk_read = disk_read.saturating_add(read.saturating_sub(prev_read));
            disk_write = disk_write.saturating_add(written.saturating_sub(prev_write));
        }
        let seconds = elapsed_ms as f64 / 1000.0;
        let disk_io = DiskThroughput {
            read_bytes_per_sec: disk_read as f64 / seconds,
            write_bytes_per_sec: disk_write as f64 / seconds,
        };

        let processes: Vec<ProcessUsage> = self
            .sys
            .processes()
            .values()
            .map(|process| processes::describe(process, self.cores))
            .collect();
        let apps = processes::aggregate(&processes, self.cores, APP_LIMIT);

        let sample = Sample {
            ts_ms: now,
            cpu_pct: cpu.usage_pct,
            per_core_pct: cpu.per_core.iter().map(|core| core.usage_pct).collect(),
            mem_pct: memory.used_pct,
            mem_used_bytes: memory.used_bytes,
            swap_pct: memory.swap_used_pct,
            load1: cpu.load1,
            net_rx_bps,
            net_tx_bps,
            disk_read_bps: disk_io.read_bytes_per_sec,
            disk_write_bps: disk_io.write_bytes_per_sec,
            process_count: processes.len(),
        };

        metrics.host = host::host_info(&self.sys);
        metrics.cpu = cpu;
        metrics.memory = memory;
        metrics.disks = host::disks(&self.disks);
        metrics.networks = networks;
        metrics.disk_io = disk_io;
        metrics.processes = processes;
        metrics.apps = apps;
        metrics.history.push_back(sample);
        while metrics.history.len() > history.max(1) {
            metrics.history.pop_front();
        }
        metrics.sampled_at_ms = now;
        metrics.sample_count += 1;
        metrics.interval_ms = interval_ms;

        self.previous_net = host::network_totals(&self.networks);
        self.previous_disk = disk_totals;
        self.previous_at_ms = now;
    }
}

impl Default for Collector {
    fn default() -> Self {
        Self::new()
    }
}

/// Background sampler handle.
pub struct Sampler {
    shared: Arc<RwLock<Metrics>>,
    interval: Duration,
    history: usize,
}

impl Sampler {
    pub fn new(interval_ms: u64, history: usize) -> Self {
        Self {
            shared: Arc::new(RwLock::new(Metrics {
                interval_ms,
                ..Metrics::default()
            })),
            interval: Duration::from_millis(interval_ms.max(500)),
            history: history.max(1),
        }
    }

    pub fn shared(&self) -> Arc<RwLock<Metrics>> {
        Arc::clone(&self.shared)
    }

    /// Take one sample immediately (used by tests and the startup path).
    pub fn sample_once(&self) {
        let mut collector = Collector::new();
        let mut guard = self.shared.write().expect("metrics lock");
        collector.sample(&mut guard, self.history, self.interval.as_millis() as u64);
    }

    /// Spawn the sampling loop.
    pub fn spawn(self) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let collector = std::sync::Arc::new(std::sync::Mutex::new(
                tokio::task::spawn_blocking(Collector::new)
                    .await
                    .expect("collector init"),
            ));
            let mut ticker = tokio::time::interval(self.interval);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                ticker.tick().await;
                let interval_ms = self.interval.as_millis() as u64;
                let shared = Arc::clone(&self.shared);
                let collector = std::sync::Arc::clone(&collector);
                let history = self.history;
                let sampled = tokio::task::spawn_blocking(move || {
                    let mut collector = collector.lock().expect("collector mutex");
                    let mut guard = shared.write().expect("metrics lock");
                    collector.sample(&mut guard, history, interval_ms);
                })
                .await;
                if sampled.is_err() {
                    eprintln!("[webdesk] 采样任务退出");
                    break;
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_reports_plausible_live_values() {
        let mut collector = Collector::new();
        let mut metrics = Metrics::default();
        std::thread::sleep(Duration::from_millis(300));
        collector.sample(&mut metrics, 10, 2_000);

        assert!(metrics.host.cores_logical >= 1);
        assert!(metrics.memory.total_bytes > 0);
        assert!(metrics.memory.used_bytes <= metrics.memory.total_bytes);
        assert!(
            (0.0..=100.0).contains(&metrics.cpu.usage_pct),
            "cpu={}",
            metrics.cpu.usage_pct
        );
        assert!((0.0..=100.0).contains(&metrics.memory.used_pct));
        assert!(!metrics.history.is_empty());
        assert_eq!(metrics.sample_count, 1);
        // The sampler must always see at least itself.
        assert!(!metrics.processes.is_empty());
        assert!(!metrics.apps.is_empty());
        assert!(metrics
            .processes
            .iter()
            .all(|process| process.cpu_pct >= 0.0));
        assert!(metrics
            .processes
            .iter()
            .any(|process| process.mem_bytes > 0));
    }

    #[test]
    fn history_is_a_bounded_ring_buffer() {
        let mut collector = Collector::new();
        let mut metrics = Metrics::default();
        for _ in 0..3 {
            std::thread::sleep(Duration::from_millis(50));
            collector.sample(&mut metrics, 2, 2_000);
        }
        assert_eq!(metrics.history.len(), 2, "history 上限生效");
        assert_eq!(metrics.sample_count, 3);
        let series = metrics.series(10);
        assert_eq!(series.len(), 2);
        assert!(series[0].ts_ms <= series[1].ts_ms, "按时间升序返回");
    }

    #[test]
    fn top_processes_respects_sort_key() {
        let mut metrics = Metrics::default();
        metrics.processes = vec![
            test_process(1, 5.0, 900),
            test_process(2, 80.0, 10),
            test_process(3, 1.0, 5_000),
        ];
        assert_eq!(metrics.top_processes(SortKey::Cpu, 1)[0].pid, 2);
        assert_eq!(metrics.top_processes(SortKey::Memory, 1)[0].pid, 3);
        assert_eq!(
            metrics
                .top_processes(SortKey::parse(Some("memory")), 2)
                .len(),
            2
        );
        assert_eq!(SortKey::parse(Some("disk")), SortKey::Disk);
        assert_eq!(SortKey::parse(None), SortKey::Cpu);
    }

    fn test_process(pid: u32, cpu: f32, mem: u64) -> ProcessUsage {
        ProcessUsage {
            pid,
            name: format!("p{pid}"),
            exe: None,
            cmd: String::new(),
            cpu_pct: cpu,
            cpu_pct_total: cpu,
            mem_bytes: mem,
            virtual_bytes: mem,
            status: "Run".into(),
            run_time_secs: 0,
            disk_read_bytes: 0,
            disk_write_bytes: 0,
            app_key: format!("app{pid}"),
            app_label: format!("App {pid}"),
            app_from_unit: false,
        }
    }
}
