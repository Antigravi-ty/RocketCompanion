use igd_next::{PortMappingProtocol, SearchOptions};
use serde::Serialize;
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

const UPNP_LEASE_DURATION_SECS: u32 = 3600;
const UPNP_MAPPING_DESCRIPTION: &str = "RocketCompanion P2P Tunnel";
const TUNNEL_PACKET_EVENT: &str = "rc-tunnel-packet";
const MAX_UDP_DATAGRAM_BYTES: usize = 65507;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpnpProbeResult {
    pub available: bool,
    pub gateway_addr: Option<String>,
    pub local_ip: Option<String>,
    pub external_ip: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelEndpointInfo {
    pub session_id: String,
    pub local_ip: String,
    pub local_port: u16,
    pub external_ip: Option<String>,
    pub external_port: Option<u16>,
    pub upnp_mapped: bool,
    pub upnp_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatusInfo {
    pub session_id: String,
    pub open: bool,
    pub local_port: u16,
    pub external_ip: Option<String>,
    pub external_port: Option<u16>,
    pub upnp_mapped: bool,
    pub peer_addr: Option<String>,
    pub bytes_sent: u64,
    pub bytes_received: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelPacketEventPayload {
    pub session_id: String,
    pub from_addr: String,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone)]
struct UpnpLeaseRecord {
    external_ip: IpAddr,
    external_port: u16,
}

struct ActiveTunnelSession {
    socket: Arc<UdpSocket>,
    local_port: u16,
    upnp_lease: Option<UpnpLeaseRecord>,
    peer_addr: Arc<Mutex<Option<SocketAddr>>>,
    bytes_sent: Arc<AtomicU64>,
    bytes_received: Arc<AtomicU64>,
    shutdown: Arc<AtomicBool>,
    rx_thread: Option<JoinHandle<()>>,
}

#[derive(Default)]
pub struct TunnelManagerState {
    sessions: Mutex<HashMap<String, ActiveTunnelSession>>,
}

fn resolve_local_lan_ipv4(target_hint: Option<SocketAddr>) -> Option<Ipv4Addr> {
    let probe_target = target_hint.unwrap_or_else(|| SocketAddr::from(([8, 8, 8, 8], 80)));
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect(probe_target).ok()?;
    match sock.local_addr().ok()?.ip() {
        IpAddr::V4(v4) if !v4.is_loopback() => Some(v4),
        _ => None,
    }
}

fn try_map_upnp_udp(local_port: u16) -> Result<UpnpLeaseRecord, String> {
    let mut search_opts = SearchOptions::default();
    search_opts.timeout = Some(Duration::from_millis(1800));
    let gateway = igd_next::search_gateway(search_opts)
        .map_err(|e| format!("UPnP gateway discovery failed: {}", e))?;

    let local_ip = resolve_local_lan_ipv4(Some(gateway.addr))
        .ok_or_else(|| "Unable to determine local LAN IPv4 address".to_string())?;
    let local_socket_addr = SocketAddr::V4(SocketAddrV4::new(local_ip, local_port));

    gateway
        .add_port(
            PortMappingProtocol::UDP,
            local_port,
            local_socket_addr,
            UPNP_LEASE_DURATION_SECS,
            UPNP_MAPPING_DESCRIPTION,
        )
        .map_err(|e| format!("UPnP add_port failed: {}", e))?;

    let external_ip = gateway
        .get_external_ip()
        .map_err(|e| format!("UPnP get_external_ip failed: {}", e))?;

    Ok(UpnpLeaseRecord {
        external_ip,
        external_port: local_port,
    })
}

fn try_unmap_upnp_udp(external_port: u16) {
    let mut search_opts = SearchOptions::default();
    search_opts.timeout = Some(Duration::from_millis(1200));
    if let Ok(gateway) = igd_next::search_gateway(search_opts) {
        let _ = gateway.remove_port(PortMappingProtocol::UDP, external_port);
    }
}

fn close_session_internal(mut session: ActiveTunnelSession) {
    session.shutdown.store(true, Ordering::SeqCst);
    if let Some(handle) = session.rx_thread.take() {
        let _ = handle.join();
    }
    if let Some(lease) = session.upnp_lease.take() {
        thread::spawn(move || {
            try_unmap_upnp_udp(lease.external_port);
        });
    }
}

pub fn cleanup_all_tunnels(app: &AppHandle) {
    if let Some(state) = app.try_state::<TunnelManagerState>() {
        if let Ok(mut guard) = state.sessions.lock() {
            let drained: Vec<ActiveTunnelSession> = guard.drain().map(|(_, v)| v).collect();
            drop(guard);
            for session in drained {
                close_session_internal(session);
            }
        }
    }
}

#[tauri::command]
pub async fn tauri_upnp_probe() -> Result<UpnpProbeResult, String> {
    tauri::async_runtime::spawn_blocking(|| {
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
                    },
                    Err(e) => UpnpProbeResult {
                        available: false,
                        gateway_addr: Some(gateway.addr.to_string()),
                        local_ip,
                        external_ip: None,
                        error: Some(format!("get_external_ip failed: {}", e)),
                    },
                }
            }
            Err(e) => UpnpProbeResult {
                available: false,
                gateway_addr: None,
                local_ip: resolve_local_lan_ipv4(None).map(|ip| ip.to_string()),
                external_ip: None,
                error: Some(format!("UPnP discovery failed: {}", e)),
            },
        }
    })
    .await
    .map_err(|e| format!("UPnP probe task panicked: {}", e))
}

#[tauri::command]
pub async fn tauri_tunnel_open(
    app: AppHandle,
    state: State<'_, TunnelManagerState>,
    session_id: String,
    preferred_port: Option<u16>,
    enable_upnp: Option<bool>,
) -> Result<TunnelEndpointInfo, String> {
    let bind_port = preferred_port.unwrap_or(0);
    let socket = UdpSocket::bind(("0.0.0.0", bind_port))
        .map_err(|e| format!("Failed to bind UDP tunnel socket: {}", e))?;
    socket
        .set_read_timeout(Some(Duration::from_millis(50)))
        .map_err(|e| format!("Failed to configure UDP socket timeout: {}", e))?;

    let local_port = socket
        .local_addr()
        .map_err(|e| format!("Failed to read bound UDP port: {}", e))?
        .port();
    let local_ip = resolve_local_lan_ipv4(None)
        .unwrap_or(Ipv4Addr::LOCALHOST)
        .to_string();

    let should_upnp = enable_upnp.unwrap_or(true);
    let (upnp_lease, upnp_error) = if should_upnp {
        let mapped = tauri::async_runtime::spawn_blocking(move || try_map_upnp_udp(local_port))
            .await
            .map_err(|e| format!("UPnP mapping task panicked: {}", e))?;
        match mapped {
            Ok(lease) => (Some(lease), None),
            Err(err) => (None, Some(err)),
        }
    } else {
        (None, None)
    };

    let socket_arc = Arc::new(socket);
    let shutdown = Arc::new(AtomicBool::new(false));
    let bytes_received = Arc::new(AtomicU64::new(0));
    let bytes_sent = Arc::new(AtomicU64::new(0));
    let peer_addr = Arc::new(Mutex::new(None));

    let rx_socket = Arc::clone(&socket_arc);
    let rx_shutdown = Arc::clone(&shutdown);
    let rx_counter = Arc::clone(&bytes_received);
    let rx_session_id = session_id.clone();
    let rx_app = app.clone();

    let rx_thread = thread::Builder::new()
        .name(format!("rc-tunnel-rx-{}", session_id))
        .spawn(move || {
            let mut buf = vec![0u8; MAX_UDP_DATAGRAM_BYTES];
            while !rx_shutdown.load(Ordering::Relaxed) {
                match rx_socket.recv_from(&mut buf) {
                    Ok((len, src_addr)) => {
                        rx_counter.fetch_add(len as u64, Ordering::Relaxed);
                        let payload = TunnelPacketEventPayload {
                            session_id: rx_session_id.clone(),
                            from_addr: src_addr.to_string(),
                            data: buf[..len].to_vec(),
                        };
                        let _ = rx_app.emit(TUNNEL_PACKET_EVENT, payload);
                    }
                    Err(err)
                        if err.kind() == std::io::ErrorKind::WouldBlock
                            || err.kind() == std::io::ErrorKind::TimedOut =>
                    {
                        continue;
                    }
                    Err(_) => break,
                }
            }
        })
        .map_err(|e| format!("Failed to spawn tunnel receiver thread: {}", e))?;

    let endpoint_info = TunnelEndpointInfo {
        session_id: session_id.clone(),
        local_ip,
        local_port,
        external_ip: upnp_lease.as_ref().map(|l| l.external_ip.to_string()),
        external_port: upnp_lease.as_ref().map(|l| l.external_port),
        upnp_mapped: upnp_lease.is_some(),
        upnp_error,
    };

    let session = ActiveTunnelSession {
        socket: socket_arc,
        local_port,
        upnp_lease,
        peer_addr,
        bytes_sent,
        bytes_received,
        shutdown,
        rx_thread: Some(rx_thread),
    };

    let previous = {
        let mut guard = state
            .sessions
            .lock()
            .map_err(|_| "TunnelManagerState lock poisoned".to_string())?;
        guard.insert(session_id, session)
    };
    if let Some(prev) = previous {
        close_session_internal(prev);
    }

    Ok(endpoint_info)
}

#[tauri::command]
pub fn tauri_tunnel_connect(
    state: State<'_, TunnelManagerState>,
    session_id: String,
    peer_addr: String,
) -> Result<(), String> {
    let parsed: SocketAddr = peer_addr
        .parse()
        .map_err(|e| format!("Invalid peer SocketAddr '{}': {}", peer_addr, e))?;

    let guard = state
        .sessions
        .lock()
        .map_err(|_| "TunnelManagerState lock poisoned".to_string())?;
    let session = guard
        .get(&session_id)
        .ok_or_else(|| format!("Tunnel session '{}' not found", session_id))?;

    if let Ok(mut peer_guard) = session.peer_addr.lock() {
        *peer_guard = Some(parsed);
    }
    // Send a 4-byte UDP hole-punching keepalive probe so NAT tables open the 5-tuple
    let _ = session.socket.send_to(b"RCPH", parsed);
    Ok(())
}

#[tauri::command]
pub fn tauri_tunnel_send(
    state: State<'_, TunnelManagerState>,
    session_id: String,
    data: Vec<u8>,
    target_addr: Option<String>,
) -> Result<usize, String> {
    let guard = state
        .sessions
        .lock()
        .map_err(|_| "TunnelManagerState lock poisoned".to_string())?;
    let session = guard
        .get(&session_id)
        .ok_or_else(|| format!("Tunnel session '{}' not found", session_id))?;

    let dest: SocketAddr = if let Some(addr_str) = target_addr {
        addr_str
            .parse()
            .map_err(|e| format!("Invalid target SocketAddr '{}': {}", addr_str, e))?
    } else {
        session
            .peer_addr
            .lock()
            .ok()
            .and_then(|g| *g)
            .ok_or_else(|| "No peer address configured for tunnel session".to_string())?
    };

    let sent = session
        .socket
        .send_to(&data, dest)
        .map_err(|e| format!("UDP send_to failed: {}", e))?;
    session
        .bytes_sent
        .fetch_add(sent as u64, Ordering::Relaxed);
    Ok(sent)
}

#[tauri::command]
pub fn tauri_tunnel_close(
    state: State<'_, TunnelManagerState>,
    session_id: String,
) -> Result<(), String> {
    let removed = {
        let mut guard = state
            .sessions
            .lock()
            .map_err(|_| "TunnelManagerState lock poisoned".to_string())?;
        guard.remove(&session_id)
    };
    if let Some(session) = removed {
        close_session_internal(session);
    }
    Ok(())
}

#[tauri::command]
pub fn tauri_tunnel_get_status(
    state: State<'_, TunnelManagerState>,
    session_id: String,
) -> Result<TunnelStatusInfo, String> {
    let guard = state
        .sessions
        .lock()
        .map_err(|_| "TunnelManagerState lock poisoned".to_string())?;
    if let Some(session) = guard.get(&session_id) {
        let peer_addr = session
            .peer_addr
            .lock()
            .ok()
            .and_then(|g| *g)
            .map(|a| a.to_string());
        Ok(TunnelStatusInfo {
            session_id,
            open: !session.shutdown.load(Ordering::Relaxed),
            local_port: session.local_port,
            external_ip: session.upnp_lease.as_ref().map(|l| l.external_ip.to_string()),
            external_port: session.upnp_lease.as_ref().map(|l| l.external_port),
            upnp_mapped: session.upnp_lease.is_some(),
            peer_addr,
            bytes_sent: session.bytes_sent.load(Ordering::Relaxed),
            bytes_received: session.bytes_received.load(Ordering::Relaxed),
        })
    } else {
        Ok(TunnelStatusInfo {
            session_id,
            open: false,
            local_port: 0,
            external_ip: None,
            external_port: None,
            upnp_mapped: false,
            peer_addr: None,
            bytes_sent: 0,
            bytes_received: 0,
        })
    }
}
