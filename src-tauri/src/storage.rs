//! Read-only host storage information for the DepDek storage manager.

use serde::{Deserialize, Serialize};
use sysinfo::Disks;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageVolume {
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageSnapshot {
    pub sampled_at_ms: i64,
    pub volumes: Vec<StorageVolume>,
}

pub fn snapshot() -> StorageSnapshot {
    let disks = Disks::new_with_refreshed_list();
    let volumes = disks
        .list()
        .iter()
        .filter(|disk| disk.total_space() > 0)
        .map(|disk| {
            let total = disk.total_space();
            let available = disk.available_space();
            let used = total.saturating_sub(available);
            StorageVolume {
                name: disk.name().to_string_lossy().into_owned(),
                file_system: disk.file_system().to_string_lossy().into_owned(),
                mount_point: disk.mount_point().to_string_lossy().into_owned(),
                kind: format!("{:?}", disk.kind()),
                removable: disk.is_removable(),
                total_bytes: total,
                available_bytes: available,
                used_bytes: used,
                used_pct: if total == 0 {
                    0.0
                } else {
                    (used as f64 / total as f64 * 100.0) as f32
                },
            }
        })
        .collect();

    StorageSnapshot {
        sampled_at_ms: (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64,
        volumes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_contains_consistent_capacity_values() {
        let snapshot = snapshot();
        for volume in snapshot.volumes {
            assert!(volume.total_bytes > 0);
            assert!(volume.available_bytes <= volume.total_bytes);
            assert_eq!(
                volume.used_bytes,
                volume.total_bytes - volume.available_bytes
            );
            assert!((0.0..=100.0).contains(&volume.used_pct));
        }
    }
}
