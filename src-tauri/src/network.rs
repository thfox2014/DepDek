//! Bounded connectivity check and fixed OS Wi-Fi settings launcher.
//! Authorization and auditing belong to Vault's welcome module, not this module.
use serde::Serialize;
use crate::bitbay_public_api::Endpoint;
use std::io::Read;
use std::net::IpAddr;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const RESPONSE_LIMIT: u64 = 1024;
const CACHE_TTL: Duration = Duration::from_secs(5);
static CONNECTIVITY_CACHE: Mutex<Option<(Instant, Connectivity)>> = Mutex::new(None);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Connectivity { Online, Offline, Limited }

#[derive(Serialize)]
pub struct NetworkInterface { pub name: String, pub addresses: Vec<String> }
#[derive(Serialize)]
pub struct NetworkStatus {
    pub platform: &'static str,
    pub interfaces: Vec<NetworkInterface>,
    pub settings_available: bool,
    pub connectivity: Connectivity,
}

fn settings_command() -> Option<(&'static str, &'static [&'static str])> {
    #[cfg(target_os = "macos")]
    return Some(("/usr/bin/open", &["-b", "com.apple.systempreferences", "x-apple.systempreferences:com.apple.wifi-settings-extension"]));
    #[cfg(target_os = "linux")]
    for (program, args) in [
        ("/usr/bin/gnome-control-center", &["wifi"][..]),
        ("/usr/bin/nm-connection-editor", &[][..]),
        ("/usr/bin/systemsettings", &["kcm_networkmanagement"][..]),
    ] {
        if std::path::Path::new(program).is_file() { return Some((program, args)); }
    }
    #[allow(unreachable_code)]
    None
}

fn usable_address(address: IpAddr) -> bool {
    if address.is_loopback() || address.is_unspecified() || address.is_multicast() { return false; }
    match address {
        IpAddr::V4(ip) => !ip.is_link_local() && !ip.is_broadcast(),
        IpAddr::V6(ip) => !ip.is_unicast_link_local(),
    }
}

fn successful_response(status: u16, body: &[u8]) -> bool {
    if status != 400 || body.len() > RESPONSE_LIMIT as usize { return false; }
    // Required-field validation happens before account lookup/password checks.
    // A deliberate empty request is not a real login or a failed credential attempt.
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(body) else { return false };
    value.get("code").and_then(|value| value.as_u64()) == Some(400)
        && value.get("message").and_then(|value| value.as_str()) == Some("请求参数错误")
}

fn probe() -> Connectivity {
    // No supplied URLs, cookies, keys, redirects, implicit retry, or proxy discovery.
    let Ok(client) = reqwest::blocking::Client::builder()
        .no_proxy().https_only(true).redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(2)).timeout(Duration::from_secs(3)).build()
    else { return Connectivity::Limited };
    let Ok(response) = client.post(Endpoint::Login.url())
        .header(reqwest::header::CONTENT_TYPE, "application/json").body("{}").send()
    else { return Connectivity::Limited };
    let status = response.status().as_u16();
    if response.content_length().is_some_and(|size| size > RESPONSE_LIMIT) { return Connectivity::Limited; }
    let mut body = Vec::new();
    if response.take(RESPONSE_LIMIT + 1).read_to_end(&mut body).is_ok() && successful_response(status, &body) {
        return Connectivity::Online;
    }
    Connectivity::Limited
}

fn cached_probe() -> Connectivity {
    // Hold the lock during the bounded probe so concurrent IPC calls cannot fan out.
    let Ok(mut cached) = CONNECTIVITY_CACHE.lock() else { return Connectivity::Limited };
    if let Some((at, value)) = *cached {
        if at.elapsed() < CACHE_TTL { return value; }
    }
    let value = probe();
    *cached = Some((Instant::now(), value));
    value
}

fn snapshot_with(check: impl FnOnce() -> Connectivity) -> NetworkStatus {
    let networks = sysinfo::Networks::new_with_refreshed_list();
    let mut interfaces: Vec<_> = networks.iter().filter_map(|(name, network)| {
        let addresses: Vec<_> = network.ip_networks().iter()
            .filter(|ip| usable_address(ip.addr)).map(|ip| ip.addr.to_string()).take(4).collect();
        (!addresses.is_empty()).then(|| NetworkInterface { name: name.chars().take(64).collect(), addresses })
    }).collect();
    interfaces.sort_by(|a, b| a.name.cmp(&b.name)); interfaces.truncate(8);
    let connectivity = if interfaces.is_empty() { Connectivity::Offline } else { check() };
    NetworkStatus { platform: std::env::consts::OS, interfaces, settings_available: settings_command().is_some(), connectivity }
}

pub fn snapshot() -> NetworkStatus { snapshot_with(cached_probe) }

pub fn open_settings() -> Result<(), &'static str> {
    let (program, args) = settings_command().ok_or("NETWORK_SETTINGS_UNAVAILABLE")?;
    let child = Command::new(program).args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .spawn().map_err(|_| "NETWORK_SETTINGS_UNAVAILABLE")?;
    // Linux settings apps can be long-lived; reap without blocking the UI command.
    std::thread::spawn(move || { let _ = child.wait_with_output(); });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshot_is_bounded_and_does_not_infer_online_from_an_address() {
        let value = serde_json::to_value(snapshot_with(|| Connectivity::Limited)).unwrap();
        assert!(value["interfaces"].as_array().unwrap().len() <= 8);
        assert_ne!(value["connectivity"], "online");
        for interface in value["interfaces"].as_array().unwrap() {
            assert!(interface["addresses"].as_array().unwrap().len() <= 4);
        }
    }
    #[test]
    fn loopback_link_local_multicast_and_unspecified_are_not_connected_interfaces() {
        for ip in ["127.0.0.1", "::1", "0.0.0.0", "::", "169.254.2.3", "fe80::1", "224.0.0.1", "ff02::1", "255.255.255.255"] {
            assert!(!usable_address(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["192.168.1.3", "10.0.0.2", "2001:db8::2"] { assert!(usable_address(ip.parse().unwrap())); }
    }
    #[test]
    fn redirect_captive_portal_unexpected_and_oversized_bodies_are_not_online() {
        let validation = "{\"code\":400,\"message\":\"请求参数错误\"}";
        assert!(successful_response(400, validation.as_bytes()));
        assert!(successful_response(400, format!(" {validation}\n").as_bytes()));
        for status in [200, 204, 302, 401, 500] { assert!(!successful_response(status, validation.as_bytes())); }
        for body in ["Sign into Wi-Fi", "<TITLE>Success</TITLE>", "{}", "{\"code\":401}", "{\"code\":400,\"message\":\"sign in\"}"] {
            assert!(!successful_response(400, body.as_bytes()));
        }
        assert!(!successful_response(400, &vec![b' '; 1025]));
    }
    #[test]
    fn probe_targets_are_fixed_https_without_credentials_query_or_fragment() {
        for target in [Endpoint::Login.url()] {
            let url = url::Url::parse(target).unwrap();
            assert_eq!(url.scheme(), "https"); assert!(url.username().is_empty());
            assert!(url.password().is_none() && url.query().is_none() && url.fragment().is_none());
        }
    }
    #[test]
    #[ignore = "explicit developer smoke test; validates the public BitBay login route with empty JSON"]
    fn live_https_probe_confirms_this_machine_is_online() {
        assert_eq!(probe(), Connectivity::Online);
    }
}
