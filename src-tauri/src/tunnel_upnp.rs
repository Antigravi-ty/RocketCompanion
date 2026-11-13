use igd_next::{PortMappingProtocol, SearchError, SearchOptions};
use serde::Serialize;
use std::io::ErrorKind;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket};
use std::time::Duration;

pub const UPNP_LEASE_DURATION_SECS: u32 = 3600;
pub const UPNP_MAPPING_DESCRIPTION: &str = "RocketCompanion P2P Tunnel";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpnpProbeResult {
    pub available: bool,
    pub gateway_addr: Option<String>,
    pub local_ip: Option<String>,
    pub external_ip: Option<String>,
    pub error: Option<String>,
    pub permission_denied: bool,
    pub network_warning: Option<String>,
}

#[derive(Debug, Clone)]
pub struct UpnpLeaseRecord {
    pub external_ip: IpAddr,
    pub external_port: u16,
}

pub fn resolve_local_lan_ipv4(target_hint: Option<SocketAddr>) -> Option<Ipv4Addr> {
    let probe_target = target_hint.unwrap_or_else(|| SocketAddr::from(([8, 8, 8, 8], 80)));
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect(probe_target).ok()?;
    match sock.local_addr().ok()?.ip() {
        IpAddr::V4(v4) if !v4.is_loopback() => Some(v4),
        _ => None,
    }
}

fn is_permission_denied_search_error(err: &SearchError) -> bool {
    match err {
        SearchError::IoError(io_err) => io_err.kind() == ErrorKind::PermissionDenied,
        _ => {
            let lower = err.to_string().to_lowercase();
            lower.contains("permission denied")
                || lower.contains("operation not permitted")
                || lower.contains("eacces")
                || lower.contains("eperm")
        }
    }
}

#[cfg(target_os = "windows")]
pub fn detect_network_warning() -> Option<String> {
    use windows::Win32::Networking::NetworkListManager::{
        INetwork, INetworkListManager, NLM_NETWORK_CATEGORY_PUBLIC, NetworkListManager,
    };
    use windows::Win32::System::Com::{
        CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
    };

    unsafe {
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        let should_uninit = hr.is_ok();
        let result = (|| -> Option<String> {
            let mgr: INetworkListManager =
                CoCreateInstance(&NetworkListManager, None, CLSCTX_ALL).ok()?;
            let networks = mgr
                .GetNetworks(windows::Win32::Networking::NetworkListManager::NLM_ENUM_NETWORK_CONNECTED)
                .ok()?;
            let mut fetched = 0u32;
            let mut arr: [Option<INetwork>; 1] = [None];
            while networks.Next(&mut arr, Some(&mut fetched)).is_ok() && fetched > 0 {
                if let Some(net) = arr[0].take() {
                    if let Ok(cat) = net.GetCategory() {
                        if cat == NLM_NETWORK_CATEGORY_PUBLIC {
                            let msg = "WINDOWS_PUBLIC_NETWORK_FIREWALL_RISK: Active network profile is Public; Windows Defender Firewall may block inbound UDP/UPnP.".to_string();
                            log::warn!("[RocketCompanion][UPnP] {}", msg);
                            eprintln!("[RocketCompanion][UPnP] WARNING: {}", msg);
                            return Some(msg);
                        }
                    }
                }
                fetched = 0;
            }
            None
        })();
        if should_uninit {
            CoUninitialize();
        }
        result
    }
}

#[cfg(not(target_os = "windows"))]
pub fn detect_network_warning() -> Option<String> {
    None
}

pub fn try_map_upnp_udp(local_port: u16) -> Result<UpnpLeaseRecord, (String, bool)> {
    let mut search_opts = SearchOptions::default();
    search_opts.timeout = Some(Duration::from_millis(1800));
    let gateway = igd_next::search_gateway(search_opts).map_err(|e| {
        let denied = is_permission_denied_search_error(&e);
        let msg = if denied {
            format!(
                "LOCAL_NETWORK_PERMISSION_DENIED: UPnP SSDP multicast blocked by OS privacy/firewall ({})",
                e
            )
        } else {
            format!("UPnP gateway discovery failed: {}", e)
        };
        log::error!("[RocketCompanion][UPnP] {}", msg);
        eprintln!("[RocketCompanion][UPnP] ERROR: {}", msg);
        (msg, denied)
    })?;

    let local_ip = resolve_local_lan_ipv4(Some(gateway.addr)).ok_or_else(|| {
        let msg = "Unable to determine local LAN IPv4 address".to_string();
        log::error!("[RocketCompanion][UPnP] {}", msg);
        eprintln!("[RocketCompanion][UPnP] ERROR: {}", msg);
        (msg, false)
    })?;
    let local_socket_addr = SocketAddr::V4(SocketAddrV4::new(local_ip, local_port));

    gateway
        .add_port(
            PortMappingProtocol::UDP,
            local_port,
            local_socket_addr,
            UPNP_LEASE_DURATION_SECS,
            UPNP_MAPPING_DESCRIPTION,
        )
        .map_err(|e| {
            let msg = format!("UPnP add_port({}) failed: {}", local_port, e);
            log::error!("[RocketCompanion][UPnP] {}", msg);
            eprintln!("[RocketCompanion][UPnP] ERROR: {}", msg);
            (msg, false)
        })?;

    let external_ip = gateway.get_external_ip().map_err(|e| {
        let msg = format!("UPnP get_external_ip failed: {}", e);
        log::error!("[RocketCompanion][UPnP] {}", msg);
        eprintln!("[RocketCompanion][UPnP] ERROR: {}", msg);
        (msg, false)
    })?;

    log::info!(
        "[RocketCompanion][UPnP] Mapped UDP {}:{} -> {}:{}",
        local_ip,
        local_port,
        external_ip,
        local_port
    );

    Ok(UpnpLeaseRecord {
        external_ip,
        external_port: local_port,
    })
}

pub fn try_unmap_upnp_udp(external_port: u16) {
    let mut search_opts = SearchOptions::default();
    search_opts.timeout = Some(Duration::from_millis(1200));
    match igd_next::search_gateway(search_opts) {
        Ok(gateway) => {
            if let Err(e) = gateway.remove_port(PortMappingProtocol::UDP, external_port) {
                log::warn!(
                    "[RocketCompanion][UPnP] remove_port({}) failed: {}",
                    external_port,
                    e
                );
            }
        }
        Err(e) => {
            log::warn!(
                "[RocketCompanion][UPnP] Gateway lookup for unmap({}) failed: {}",
                external_port,
                e
            );
        }
    }
}

#[tauri::command]
pub async fn tauri_upnp_probe() -> Result<UpnpProbeResult, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let network_warning = detect_network_warning();
        let mut search_opts = SearchOptions::default();
        search_opts.timeout = Some(Duration::from_millis(1800));
        match igd_next::search_gateway(search_opts) {
            Ok(gateway) => {
                let local_ip =
                    resolve_local_lan_ipv4(Some(gateway.addr)).map(|ip| ip.to_string());
                match gateway.get_external_ip() {
                    Ok(ext_ip) => UpnpProbeResult {
                        available: true,
                        gateway_addr: Some(gateway.addr.to_string()),
                        local_ip,
                        external_ip: Some(ext_ip.to_string()),
                        error: None,
                        permission_denied: false,
                        network_warning,
                    },
                    Err(e) => {
                        let msg = format!("get_external_ip failed: {}", e);
                        log::error!("[RocketCompanion][UPnP] Probe failed: {}", msg);
                        eprintln!("[RocketCompanion][UPnP] Probe ERROR: {}", msg);
                        UpnpProbeResult {
                            available: false,
                            gateway_addr: Some(gateway.addr.to_string()),
                            local_ip,
                            external_ip: None,
                            error: Some(msg),
                            permission_denied: false,
                            network_warning,
                        }
                    }
                }
            }
            Err(e) => {
                let denied = is_permission_denied_search_error(&e);
                let msg = if denied {
                    format!(
                        "LOCAL_NETWORK_PERMISSION_DENIED: UPnP discovery blocked ({})",
                        e
                    )
                } else {
                    format!("UPnP discovery failed: {}", e)
                };
                log::error!("[RocketCompanion][UPnP] Probe failed: {}", msg);
                eprintln!("[RocketCompanion][UPnP] Probe ERROR: {}", msg);
                UpnpProbeResult {
                    available: false,
                    gateway_addr: None,
                    local_ip: resolve_local_lan_ipv4(None).map(|ip| ip.to_string()),
                    external_ip: None,
                    error: Some(msg),
                    permission_denied: denied,
                    network_warning,
                }
            }
        }
    })
    .await
    .map_err(|e| format!("UPnP probe task panicked: {}", e))
}
