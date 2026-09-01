// System-monitor pane data source. We keep one System/Networks around as managed
// state and refresh it each poll, so CPU% and network byte-deltas are meaningful
// between calls (a fresh System every call would read 0% CPU).
use serde::Serialize;
use std::sync::Mutex;
use std::time::Instant;
use sysinfo::{Components, Networks, System};

pub struct SysMon(Mutex<Inner>);

struct Inner {
    sys: System,
    nets: Networks,
    comps: Components,
    last: Instant,
    nvml: Option<nvml_wrapper::Nvml>,
}

impl SysMon {
    pub fn new() -> Self {
        let mut sys = System::new();
        sys.refresh_cpu_all();
        sys.refresh_memory();
        SysMon(Mutex::new(Inner {
            sys,
            nets: Networks::new_with_refreshed_list(),
            comps: Components::new_with_refreshed_list(),
            last: Instant::now(),
            // None on any machine without an NVIDIA driver — GPU section just hides.
            nvml: nvml_wrapper::Nvml::init().ok(),
        }))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Gpu {
    name: String,
    util: u32,       // %
    mem_used: u64,   // bytes
    mem_total: u64,  // bytes
    temp: Option<u32>, // °C
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    cpu: f32,          // global %
    cores: Vec<f32>,   // per-core %
    mem_used: u64,
    mem_total: u64,
    swap_used: u64,
    swap_total: u64,
    net_rx: u64,       // bytes/sec since last poll
    net_tx: u64,
    temp: Option<f32>, // hottest component, °C
    gpus: Vec<Gpu>,
}

#[tauri::command]
pub fn sysinfo_snapshot(mon: tauri::State<SysMon>) -> Metrics {
    let mut i = mon.0.lock().unwrap();

    i.sys.refresh_cpu_all();
    i.sys.refresh_memory();
    i.nets.refresh(true);
    i.comps.refresh(true);

    let secs = i.last.elapsed().as_secs_f64().max(0.001);
    i.last = Instant::now();

    let (rx, tx) = i.nets.iter().fold((0u64, 0u64), |(r, t), (_, d)| {
        (r + d.received(), t + d.transmitted())
    });

    let temp = i
        .comps
        .iter()
        .filter_map(|c| c.temperature())
        .fold(None, |max: Option<f32>, t| Some(max.map_or(t, |m| m.max(t))));

    let gpus = i
        .nvml
        .as_ref()
        .map(gpus_from_nvml)
        .unwrap_or_default();

    Metrics {
        cpu: i.sys.global_cpu_usage(),
        cores: i.sys.cpus().iter().map(|c| c.cpu_usage()).collect(),
        mem_used: i.sys.used_memory(),
        mem_total: i.sys.total_memory(),
        swap_used: i.sys.used_swap(),
        swap_total: i.sys.total_swap(),
        net_rx: (rx as f64 / secs) as u64,
        net_tx: (tx as f64 / secs) as u64,
        temp,
        gpus,
    }
}

fn gpus_from_nvml(nvml: &nvml_wrapper::Nvml) -> Vec<Gpu> {
    use nvml_wrapper::enum_wrappers::device::TemperatureSensor;
    let count = nvml.device_count().unwrap_or(0);
    (0..count)
        .filter_map(|idx| {
            let d = nvml.device_by_index(idx).ok()?;
            let mem = d.memory_info().ok();
            Some(Gpu {
                name: d.name().unwrap_or_default(),
                util: d.utilization_rates().map(|u| u.gpu).unwrap_or(0),
                mem_used: mem.as_ref().map(|m| m.used).unwrap_or(0),
                mem_total: mem.as_ref().map(|m| m.total).unwrap_or(0),
                temp: d.temperature(TemperatureSensor::Gpu).ok(),
            })
        })
        .collect()
}
