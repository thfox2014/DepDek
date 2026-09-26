/**
 * Browser preview data for the webdesk UI (`?demo=1`).
 *
 * Mirrors the shape of the real API so the desktop, the performance widget and
 * every app view can be reviewed without a running service — the same approach
 * the Tauri app uses for its browser UX preview.
 */

import type {
  AppList,
  AppUsage,
  AuditTail,
  ProcessList,
  ProcessUsage,
  Sample,
  Series,
  SessionInfo,
  Summary,
} from "./api";

const VERSION = "0.2.0";
const CORES = 4;
const TOTAL_MEMORY = 15.6 * 1024 ** 3;
const INTERVAL_MS = 2000;
const HISTORY = 300;

/** Deterministic PRNG so screenshots are stable between runs. */
function makeRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

const random = makeRandom(20260927);

function sampleAt(index: number, total: number): Sample {
  const phase = (index / 40) * Math.PI * 2;
  const cpu = 22 + Math.sin(phase) * 11 + random() * 9;
  const mem = 46 + Math.sin(phase / 3) * 6 + random() * 3;
  const rx = 180_000 + Math.abs(Math.sin(phase / 2)) * 900_000 + random() * 220_000;
  const tx = 90_000 + Math.abs(Math.cos(phase / 2)) * 460_000 + random() * 120_000;
  const read = random() * 6_000_000;
  const write = random() * 2_400_000;
  return {
    ts_ms: Date.now() - (total - index) * INTERVAL_MS,
    cpu_pct: Number(cpu.toFixed(1)),
    per_core_pct: Array.from({ length: CORES }, (_, core) =>
      Number(Math.min(100, Math.max(2, cpu + Math.sin(phase + core) * 14 + random() * 7)).toFixed(1)),
    ),
    mem_pct: Number(mem.toFixed(1)),
    mem_used_bytes: Math.round((mem / 100) * TOTAL_MEMORY),
    swap_pct: Number((6 + random() * 4).toFixed(1)),
    load1: Number((cpu / 100 * CORES).toFixed(2)),
    net_rx_bps: rx,
    net_tx_bps: tx,
    disk_read_bps: read,
    disk_write_bps: write,
    process_count: 212 + Math.round(random() * 8),
  };
}

function history(window: number): Sample[] {
  const total = Math.max(window, 60);
  return Array.from({ length: total }, (_, index) => sampleAt(index, total)).slice(-window);
}

const APPS: AppUsage[] = [
  {
    key: "depdek.desktop",
    label: "DepDek 主程序",
    from_unit: true,
    processes: 3,
    cpu_pct: 34.5,
    cpu_pct_total: 8.6,
    mem_bytes: 1.42 * 1024 ** 3,
    disk_read_bytes: 12_400_000,
    disk_write_bytes: 4_100_000,
    top_pids: [1180, 1194, 1220],
  },
  {
    key: "ollama.service",
    label: "Ollama 模型服务",
    from_unit: true,
    processes: 2,
    cpu_pct: 61.2,
    cpu_pct_total: 15.3,
    mem_bytes: 4.8 * 1024 ** 3,
    disk_read_bytes: 88_000_000,
    disk_write_bytes: 1_200_000,
    top_pids: [2043, 2051],
  },
  {
    key: "depdek.sidecar",
    label: "DepDek Sidecar",
    from_unit: true,
    processes: 1,
    cpu_pct: 9.4,
    cpu_pct_total: 2.4,
    mem_bytes: 268 * 1024 ** 2,
    disk_read_bytes: 640_000,
    disk_write_bytes: 320_000,
    top_pids: [1305],
  },
  {
    key: "firefox",
    label: "Firefox",
    from_unit: false,
    processes: 6,
    cpu_pct: 18.7,
    cpu_pct_total: 4.7,
    mem_bytes: 1.86 * 1024 ** 3,
    disk_read_bytes: 2_100_000,
    disk_write_bytes: 980_000,
    top_pids: [3120, 3144, 3180, 3199, 3210],
  },
  {
    key: "gnome-shell",
    label: "GNOME Shell",
    from_unit: true,
    processes: 1,
    cpu_pct: 7.8,
    cpu_pct_total: 2.0,
    mem_bytes: 412 * 1024 ** 2,
    disk_read_bytes: 120_000,
    disk_write_bytes: 80_000,
    top_pids: [1811],
  },
  {
    key: "vite",
    label: "Vite 开发服务",
    from_unit: false,
    processes: 2,
    cpu_pct: 4.1,
    cpu_pct_total: 1.0,
    mem_bytes: 196 * 1024 ** 2,
    disk_read_bytes: 40_000,
    disk_write_bytes: 24_000,
    top_pids: [4012, 4020],
  },
];

function processRows(): ProcessUsage[] {
  const rows: Array<[number, string, string, number, number, string]> = [
    [2043, "ollama", "ollama serve", 48.2, 3.6 * 1024 ** 3, "ollama.service"],
    [1180, "agent-workbench", "/usr/bin/agent-workbench", 21.4, 940 * 1024 ** 2, "depdek.desktop"],
    [2051, "ollama-runner", "/usr/lib/ollama/runners/cpu", 13.0, 1.2 * 1024 ** 3, "ollama.service"],
    [3120, "firefox", "/usr/lib/firefox/firefox", 12.6, 1.1 * 1024 ** 3, "firefox"],
    [1305, "node", "node sidecar.mjs", 9.4, 268 * 1024 ** 2, "depdek.sidecar"],
    [1811, "gnome-shell", "/usr/bin/gnome-shell", 7.8, 412 * 1024 ** 2, "gnome-shell"],
    [1194, "WebKitWebProcess", "/usr/lib/.../WebKitWebProcess", 6.9, 384 * 1024 ** 2, "depdek.desktop"],
    [4012, "node", "vite --port 5280", 3.8, 168 * 1024 ** 2, "vite"],
    [1720, "pipewire", "/usr/bin/pipewire", 2.1, 48 * 1024 ** 2, "pipewire"],
    [1655, "systemd-journald", "/usr/lib/systemd/systemd-journald", 1.4, 92 * 1024 ** 2, "systemd"],
    [1420, "dbus-daemon", "/usr/bin/dbus-daemon", 0.6, 12 * 1024 ** 2, "dbus"],
    [1330, "tracker-miner-fs-3", "/usr/libexec/tracker-miner-fs-3", 0.4, 74 * 1024 ** 2, "tracker-miner"],
  ];
  return rows.map(([pid, name, cmd, cpu, mem, app]) => ({
    pid,
    name,
    exe: cmd.split(" ")[0],
    cmd,
    cpu_pct: cpu,
    cpu_pct_total: Number((cpu / CORES).toFixed(2)),
    mem_bytes: mem,
    virtual_bytes: mem * 3,
    status: "Run",
    run_time_secs: 3600 + pid,
    disk_read_bytes: Math.round(random() * 4_000_000),
    disk_write_bytes: Math.round(random() * 900_000),
    app_key: app,
    app_label: APPS.find((entry) => entry.key === app)?.label ?? app,
    app_from_unit: !app.includes("."),
  }));
}

function summary(): Summary {
  const samples = history(2);
  const latest = samples[samples.length - 1];
  return {
    version: VERSION,
    uptime_secs: 4 * 86400 + 7 * 3600 + 1_240,
    sampled_at_ms: latest.ts_ms,
    sample_count: 12_480,
    interval_ms: INTERVAL_MS,
    host: {
      hostname: "depdek-nas",
      os_name: "Debian GNU/Linux",
      os_version: "13 (trixie)",
      kernel: "6.12.9-amd64",
      uptime_secs: 4 * 86400 + 7 * 3600 + 1_240,
      cores_logical: CORES,
      cores_physical: 4,
      cpu_brand: "Intel(R) N100",
      cpu_frequency_mhz: 800,
      sampled_at_ms: latest.ts_ms,
    },
    cpu: {
      usage_pct: latest.cpu_pct,
      per_core: latest.per_core_pct.map((usage, index) => ({
        index,
        usage_pct: usage,
        frequency_mhz: 800 + index * 120,
      })),
      load1: latest.load1,
      load5: 0.94,
      load15: 0.81,
    },
    memory: {
      total_bytes: TOTAL_MEMORY,
      used_bytes: latest.mem_used_bytes,
      available_bytes: TOTAL_MEMORY - latest.mem_used_bytes,
      used_pct: latest.mem_pct,
      swap_total_bytes: 4 * 1024 ** 3,
      swap_used_bytes: 0.28 * 1024 ** 3,
      swap_used_pct: 7,
    },
    disks: [
      {
        name: "/dev/nvme0n1p2",
        file_system: "ext4",
        mount_point: "/",
        kind: "SSD",
        removable: false,
        total_bytes: 180 * 1024 ** 3,
        available_bytes: 118 * 1024 ** 3,
        used_bytes: 62 * 1024 ** 3,
        used_pct: 34.4,
      },
      {
        name: "/dev/sda1",
        file_system: "ext4",
        mount_point: "/home",
        kind: "HDD",
        removable: false,
        total_bytes: 3.6 * 1024 ** 4,
        available_bytes: 2.1 * 1024 ** 4,
        used_bytes: 1.5 * 1024 ** 4,
        used_pct: 41.7,
      },
      {
        name: "/dev/sdb1",
        file_system: "ext4",
        mount_point: "/mnt/backup",
        kind: "HDD",
        removable: true,
        total_bytes: 1.8 * 1024 ** 4,
        available_bytes: 1.1 * 1024 ** 4,
        used_bytes: 0.7 * 1024 ** 4,
        used_pct: 38.9,
      },
    ],
    disk_io: {
      read_bytes_per_sec: latest.disk_read_bps,
      write_bytes_per_sec: latest.disk_write_bps,
    },
    networks: [
      {
        name: "eno1",
        received_bytes: 148 * 1024 ** 3,
        transmitted_bytes: 42 * 1024 ** 3,
        rx_bytes_per_sec: latest.net_rx_bps,
        tx_bytes_per_sec: latest.net_tx_bps,
        errors: 0,
      },
      {
        name: "wlp2s0",
        received_bytes: 8.4 * 1024 ** 3,
        transmitted_bytes: 1.2 * 1024 ** 3,
        rx_bytes_per_sec: 42_000,
        tx_bytes_per_sec: 12_000,
        errors: 3,
      },
    ],
    apps: APPS,
    process_count: 218,
  };
}

function series(window: number): Series {
  const samples = history(Math.min(window, HISTORY));
  return {
    interval_ms: INTERVAL_MS,
    sampled_at_ms: samples[samples.length - 1]?.ts_ms ?? Date.now(),
    sample_count: 12_480,
    samples,
  };
}

export const demoApi = {
  async session(): Promise<SessionInfo> {
    return {
      authenticated: true,
      user: "预览用户",
      csrf: "demo",
      version: VERSION,
      insecure_no_auth: false,
      tls: false,
      session_ttl_secs: 43_200,
    };
  },
  async login(): Promise<SessionInfo> {
    return this.session();
  },
  async logout(): Promise<{ authenticated: boolean }> {
    return { authenticated: false };
  },
  async summary(): Promise<Summary> {
    return summary();
  },
  async series(window: number): Promise<Series> {
    return series(window);
  },
  async processes(sort: string, limit: number): Promise<ProcessList> {
    const rows = processRows();
    const key = sort === "mem" ? "mem_bytes" : sort === "disk" ? "disk" : "cpu_pct";
    rows.sort((a, b) => {
      if (key === "mem_bytes") return b.mem_bytes - a.mem_bytes;
      if (key === "disk") return b.disk_read_bytes + b.disk_write_bytes - (a.disk_read_bytes + a.disk_write_bytes);
      return b.cpu_pct - a.cpu_pct;
    });
    return { sampled_at_ms: Date.now(), cores: CORES, total: 218, processes: rows.slice(0, limit) };
  },
  async apps(limit: number): Promise<AppList> {
    return {
      sampled_at_ms: Date.now(),
      cores: CORES,
      total_memory_bytes: TOTAL_MEMORY,
      apps: APPS.slice(0, limit),
    };
  },
  async audit(limit: number): Promise<AuditTail> {
    const entries = [
      { action: "service.start", actor: "system", ok: true },
      { action: "login.success", actor: "admin", ok: true },
      { action: "login.failure", actor: "anon", ok: false },
      { action: "session.logout", actor: "admin", ok: true },
      { action: "login.blocked", actor: "anon", ok: false },
    ].map((entry, index) => ({
      ts: new Date(Date.now() - index * 90_000).toISOString(),
      actor: entry.actor,
      ip: entry.actor === "anon" ? "192.168.1.44" : "192.168.1.10",
      ok: entry.ok,
      action: entry.action,
      detail: entry.ok ? {} : { reason: "bad-password" },
    }));
    return { path: "/var/lib/depdek-webdesk/webdesk-audit.jsonl", entries: entries.slice(0, limit) };
  },
};
