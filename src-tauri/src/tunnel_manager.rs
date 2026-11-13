use igd_next::{PortMappingProtocol, SearchOptions};
use serde::Serialize;
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};
use tauri::{AppHandle, Emitter, Manager, State};

const UPNP_LEASE_DURATION_SECS: u32 = 3600;
const UPNP_MAPPING_DESCRIPTION: &str = "RocketCompanion P2P Tunnel";
const TUNNEL_PACKET_EVENT: &str = "rc-tunnel-packet";
const TUNNEL_PEER_READY_EVENT: &str = "rc-tunnel-peer-ready";
const MAX_UDP_DATAGRAM_BYTES: usize = 65507;
const HOLE_PUNCH_PROBE: &[u8; 4] = b"RCPH";
const HOLE_PUNCH_ACK: &[u8; 4] = b"RCPA";

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
    pub peer_count: usize,
    pub bytes_sent: u64,
    pub bytes_received: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelPacketEventPayload {
    pub session_id: String,
    pub peer_id: Option<String>,
    pub from_addr: String,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelPeerReadyEventPayload {
    pub session_id: String,
    pub peer_id: Option<String>,
    pub from_addr: String,
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
    default_peer: Arc<Mutex<Option<SocketAddr>>>,
    peers: Arc<Mutex<HashMap<String, SocketAddr>>>,
    addr_to_peer: Arc<Mutex<HashMap<SocketAddr, String>>>,
    rx_channel: Arc<Mutex<Option<Channel<InvokeResponseBody>>>>,
    bytes_sent: Arc<AtomicU64>,
    bytes_received: Arc<AtomicU64>,
    shutdown: Arc<AtomicBool>,
    rx_thread: Option<JoinHandle<()>>,
}

#[derive(Default)]
pub struct TunnelManagerState {
    sessions: Mutex<HashMap<String, ActiveTunnelSession>>,
}

fn encode_binary_rx_frame(peer_id: Option<&str>, from_addr: &str, payload: &[u8]) -> Vec<u8> {
    let pid_bytes = peer_id.unwrap_or("").as_bytes();
    let addr_bytes = from_addr.as_bytes();
    let pid_len = pid_bytes.len().min(255);
    let addr_len = addr_bytes.len().min(255);
    let mut frame = Vec::with_capacity(2 + pid_len + addr_len + payload.len());
    frame.push(pid_len as u8);
    frame.push(addr_len as u8);
    frame.extend_from_slice(&pid_bytes[..pid_len]);
    frame.extend_from_slice(&addr_bytes[..addr_len]);
    frame.extend_from_slice(payload);
    frame
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
    let default_peer = Arc::new(Mutex::new(None));
    let peers = Arc::new(Mutex::new(HashMap::new()));
    let addr_to_peer = Arc::new(Mutex::new(HashMap::new()));
    let rx_channel: Arc<Mutex<Option<Channel<InvokeResponseBody>>>> = Arc::new(Mutex::new(None));

    let rx_socket = Arc::clone(&socket_arc);
    let rx_shutdown = Arc::clone(&shutdown);
    let rx_counter = Arc::clone(&bytes_received);
    let rx_addr_to_peer = Arc::clone(&addr_to_peer);
    let rx_chan_ref = Arc::clone(&rx_channel);
    let rx_session_id = session_id.clone();
    let rx_app = app.clone();

    let rx_thread = thread::Builder::new()
        .name(format!("rc-tunnel-rx-{}", session_id))
        .spawn(move || {
            let mut buf = vec![0u8; MAX_UDP_DATAGRAM_BYTES];
            while !rx_shutdown.load(Ordering::Relaxed) {
                match rx_socket.recv_from(&mut buf) {
                    Ok((len, src_addr)) => {
                        let data = &buf[..len];
                        let peer_id = rx_addr_to_peer
                            .lock()
                            .ok()
                            .and_then(|map| map.get(&src_addr).cloned());

                        if data == HOLE_PUNCH_PROBE {
                            let _ = rx_socket.send_to(HOLE_PUNCH_ACK, src_addr);
                            let _ = rx_app.emit(
                                TUNNEL_PEER_READY_EVENT,
                                TunnelPeerReadyEventPayload {
                                    session_id: rx_session_id.clone(),
                                    peer_id,
                                    from_addr: src_addr.to_string(),
                                },
                            );
                            continue;
                        }
                        if data == HOLE_PUNCH_ACK {
                            let _ = rx_app.emit(
                                TUNNEL_PEER_READY_EVENT,
                                TunnelPeerReadyEventPayload {
                                    session_id: rx_session_id.clone(),
                                    peer_id,
                                    from_addr: src_addr.to_string(),
                                },
                            );
                            continue;
                        }

                        rx_counter.fetch_add(len as u64, Ordering::Relaxed);
                        let from_str = src_addr.to_string();
                        let sent_via_channel = if let Ok(ch_guard) = rx_chan_ref.lock() {
                            if let Some(ref channel) = *ch_guard {
                                let frame =
                                    encode_binary_rx_frame(peer_id.as_deref(), &from_str, data);
                                channel.send(InvokeResponseBody::Raw(frame)).is_ok()
                            } else {
                                false
                            }
                        } else {
                            false
                        };
                        if !sent_via_channel {
                            let payload = TunnelPacketEventPayload {
                                session_id: rx_session_id.clone(),
                                peer_id,
                                from_addr: from_str,
                                data: data.to_vec(),
                            };
                            let _ = rx_app.emit(TUNNEL_PACKET_EVENT, payload);
                        }
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
        default_peer,
        peers,
        addr_to_peer,
        rx_channel,
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
pub fn tauri_tunnel_attach_rx_channel(
    state: State<'_, TunnelManagerState>,
    session_id: String,
    on_packet: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    let guard = state
        .sessions
        .lock()
        .map_err(|_| "TunnelManagerState lock poisoned".to_string())?;
    let session = guard
        .get(&session_id)
        .ok_or_else(|| format!("Tunnel session '{}' not found", session_id))?;
    if let Ok(mut ch_guard) = session.rx_channel.lock() {
        *ch_guard = Some(on_packet);
    }
    Ok(())
}

#[tauri::command]
pub fn tauri_tunnel_connect(
    state: State<'_, TunnelManagerState>,
    session_id: String,
    peer_addr: String,
    peer_id: Option<String>,
    fallback_addr: Option<String>,
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

    if let Ok(mut peer_guard) = session.default_peer.lock() {
        *peer_guard = Some(parsed);
    }
    if let Some(pid) = peer_id {
        if let Ok(mut peers_guard) = session.peers.lock() {
            peers_guard.insert(pid.clone(), parsed);
        }
        if let Ok(mut rev_guard) = session.addr_to_peer.lock() {
            rev_guard.insert(parsed, pid.clone());
            if let Some(ref fb) = fallback_addr {
                if let Ok(fb_parsed) = fb.parse::<SocketAddr>() {
                    rev_guard.insert(fb_parsed, pid);
                }
            }
        }
    }

    // Send 4-byte UDP hole-punching keepalive probes so NAT tables open the 5-tuple
    let _ = session.socket.send_to(HOLE_PUNCH_PROBE, parsed);
    if let Some(fb) = fallback_addr {
        if let Ok(fb_parsed) = fb.parse::<SocketAddr>() {
            if fb_parsed != parsed {
                let _ = session.socket.send_to(HOLE_PUNCH_PROBE, fb_parsed);
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn tauri_tunnel_disconnect_peer(
    state: State<'_, TunnelManagerState>,
    session_id: String,
    peer_id: String,
) -> Result<(), String> {
    let guard = state
        .sessions
        .lock()
        .map_err(|_| "TunnelManagerState lock poisoned".to_string())?;
    if let Some(session) = guard.get(&session_id) {
        if let Ok(mut peers_guard) = session.peers.lock() {
            peers_guard.remove(&peer_id);
        }
        if let Ok(mut rev_guard) = session.addr_to_peer.lock() {
            rev_guard.retain(|_, v| v != &peer_id);
        }
    }
    Ok(())
}

fn resolve_dest_addr(
    session: &ActiveTunnelSession,
    peer_id: Option<&str>,
    target_addr: Option<&str>,
) -> Result<SocketAddr, String> {
    if let Some(pid) = peer_id {
        if let Ok(peers_guard) = session.peers.lock() {
            if let Some(addr) = peers_guard.get(pid) {
                return Ok(*addr);
            }
        }
    }
    if let Some(addr_str) = target_addr {
        return addr_str
            .parse()
            .map_err(|e| format!("Invalid target SocketAddr '{}': {}", addr_str, e));
    }
    session
        .default_peer
        .lock()
        .ok()
        .and_then(|g| *g)
        .ok_or_else(|| "No peer address configured for tunnel session".to_string())
}

#[tauri::command]
pub fn tauri_tunnel_send(
    state: State<'_, TunnelManagerState>,
    session_id: String,
    data: Vec<u8>,
    target_addr: Option<String>,
    peer_id: Option<String>,
) -> Result<usize, String> {
    let guard = state
        .sessions
        .lock()
        .map_err(|_| "TunnelManagerState lock poisoned".to_string())?;
    let session = guard
        .get(&session_id)
        .ok_or_else(|| format!("Tunnel session '{}' not found", session_id))?;

    let dest = resolve_dest_addr(session, peer_id.as_deref(), target_addr.as_deref())?;
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
pub fn tauri_tunnel_send_raw(
    state: State<'_, TunnelManagerState>,
    request: Request<'_>,
) -> Result<usize, String> {
    let headers = request.headers();
    let session_id = headers
        .get("x-session-id")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "Missing x-session-id header".to_string())?;
    let peer_id = headers.get("x-peer-id").and_then(|v| v.to_str().ok());
    let target_addr = headers.get("x-target-addr").and_then(|v| v.to_str().ok());

    let bytes: &[u8] = match request.body() {
        InvokeBody::Raw(raw) => raw.as_slice(),
        InvokeBody::Json(_) => {
            return Err("Expected raw binary body for tauri_tunnel_send_raw".to_string());
        }
    };

    let guard = state
        .sessions
        .lock()
        .map_err(|_| "TunnelManagerState lock poisoned".to_string())?;
    let session = guard
        .get(session_id)
        .ok_or_else(|| format!("Tunnel session '{}' not found", session_id))?;

    let dest = resolve_dest_addr(session, peer_id, target_addr)?;
    let sent = session
        .socket
        .send_to(bytes, dest)
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
            .default_peer
            .lock()
            .ok()
            .and_then(|g| *g)
            .map(|a| a.to_string());
        let peer_count = session.peers.lock().map(|p| p.len()).unwrap_or(0);
        Ok(TunnelStatusInfo {
            session_id,
            open: !session.shutdown.load(Ordering::Relaxed),
            local_port: session.local_port,
            external_ip: session.upnp_lease.as_ref().map(|l| l.external_ip.to_string()),
            external_port: session.upnp_lease.as_ref().map(|l| l.external_port),
            upnp_mapped: session.upnp_lease.is_some(),
            peer_addr,
            peer_count,
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
            peer_count: 0,
            bytes_sent: 0,
            bytes_received: 0,
        })
    }
}
