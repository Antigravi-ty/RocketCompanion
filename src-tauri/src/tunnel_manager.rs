use crate::tunnel_bridge::{
    encode_bridge_frame, start_local_bridge, LocalBridgeHandles, PeerRoutingTable,
};
use crate::tunnel_upnp::{
    detect_network_warning, resolve_local_lan_ipv4, try_map_upnp_udp, try_unmap_upnp_udp,
    UpnpLeaseRecord,
};
use serde::Serialize;
use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tauri::{AppHandle, Manager, State};
use tokio::sync::watch;

const MAX_UDP_DATAGRAM_BYTES: usize = 65507;
const HOLE_PUNCH_MAGIC: &[u8; 4] = b"RCPH";

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
    pub permission_denied: bool,
    pub network_warning: Option<String>,
    pub wt_url: Option<String>,
    pub wt_cert_hash: Option<Vec<u8>>,
    pub wt_error: Option<String>,
    pub ws_url: String,
    pub auth_token: String,
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
    pub peer_count: usize,
    pub peer_addr: Option<String>,
    pub bytes_sent: u64,
    pub bytes_received: u64,
}

struct ActiveTunnelSession {
    socket: Arc<UdpSocket>,
    local_port: u16,
    upnp_lease: Option<UpnpLeaseRecord>,
    routing: PeerRoutingTable,
    bytes_sent: Arc<AtomicU64>,
    bytes_received: Arc<AtomicU64>,
    shutdown: Arc<AtomicBool>,
    bridge_shutdown_tx: watch::Sender<bool>,
    rx_thread: Option<JoinHandle<()>>,
}

#[derive(Default)]
pub struct TunnelManagerState {
    sessions: Mutex<HashMap<String, ActiveTunnelSession>>,
}

fn close_session_internal(mut session: ActiveTunnelSession) {
    session.shutdown.store(true, Ordering::SeqCst);
    let _ = session.bridge_shutdown_tx.send(true);
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
pub async fn tauri_tunnel_open(
    state: State<'_, TunnelManagerState>,
    session_id: String,
    preferred_port: Option<u16>,
    enable_upnp: Option<bool>,
) -> Result<TunnelEndpointInfo, String> {
    let bind_port = preferred_port.unwrap_or(0);
    let socket = UdpSocket::bind(("0.0.0.0", bind_port)).map_err(|e| {
        let msg = format!("Failed to bind UDP tunnel socket: {}", e);
        log::error!("[RocketCompanion][Tunnel] {}", msg);
        eprintln!("[RocketCompanion][Tunnel] ERROR: {}", msg);
        msg
    })?;
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

    let network_warning = detect_network_warning();

    let should_upnp = enable_upnp.unwrap_or(true);
    let (upnp_lease, upnp_error, permission_denied) = if should_upnp {
        let mapped = tauri::async_runtime::spawn_blocking(move || try_map_upnp_udp(local_port))
            .await
            .map_err(|e| format!("UPnP mapping task panicked: {}", e))?;
        match mapped {
            Ok(lease) => (Some(lease), None, false),
            Err((err, denied)) => (None, Some(err), denied),
        }
    } else {
        (None, None, false)
    };

    let socket_arc = Arc::new(socket);
    let shutdown = Arc::new(AtomicBool::new(false));
    let bytes_received = Arc::new(AtomicU64::new(0));
    let bytes_sent = Arc::new(AtomicU64::new(0));
    let routing = PeerRoutingTable::new();

    let LocalBridgeHandles {
        wt_url,
        wt_cert_hash,
        wt_error,
        ws_url,
        auth_token,
        rx_broadcast,
        shutdown_tx: bridge_shutdown_tx,
    } = start_local_bridge(
        session_id.clone(),
        Arc::clone(&socket_arc),
        routing.clone(),
        Arc::clone(&bytes_sent),
        Arc::clone(&shutdown),
    )
    .await?;

    let rx_socket = Arc::clone(&socket_arc);
    let rx_shutdown = Arc::clone(&shutdown);
    let rx_counter = Arc::clone(&bytes_received);
    let rx_routing = routing.clone();
    let rx_session_id = session_id.clone();

    let rx_thread = thread::Builder::new()
        .name(format!("rc-tunnel-rx-{}", session_id))
        .spawn(move || {
            let mut buf = vec![0u8; MAX_UDP_DATAGRAM_BYTES];
            while !rx_shutdown.load(Ordering::Relaxed) {
                match rx_socket.recv_from(&mut buf) {
                    Ok((len, src_addr)) => {
                        if len == HOLE_PUNCH_MAGIC.len() && &buf[..4] == HOLE_PUNCH_MAGIC {
                            continue;
                        }
                        rx_counter.fetch_add(len as u64, Ordering::Relaxed);
                        let peer_id = rx_routing
                            .resolve_peer_by_addr(&src_addr)
                            .unwrap_or_else(|| src_addr.to_string());
                        let frame = encode_bridge_frame(&peer_id, &buf[..len]);
                        let _ = rx_broadcast.send(frame);
                    }
                    Err(err)
                        if err.kind() == std::io::ErrorKind::WouldBlock
                            || err.kind() == std::io::ErrorKind::TimedOut =>
                    {
                        continue;
                    }
                    Err(err) => {
                        if !rx_shutdown.load(Ordering::Relaxed) {
                            log::error!(
                                "[RocketCompanion][Tunnel:{}] UDP recv_from error: {}",
                                rx_session_id,
                                err
                            );
                            eprintln!(
                                "[RocketCompanion][Tunnel:{}] ERROR UDP recv_from: {}",
                                rx_session_id, err
                            );
                        }
                        break;
                    }
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
        permission_denied,
        network_warning,
        wt_url,
        wt_cert_hash,
        wt_error,
        ws_url,
        auth_token,
    };

    let session = ActiveTunnelSession {
        socket: socket_arc,
        local_port,
        upnp_lease,
        routing,
        bytes_sent,
        bytes_received,
        shutdown,
        bridge_shutdown_tx,
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
pub fn tauri_tunnel_connect_peer(
    state: State<'_, TunnelManagerState>,
    session_id: String,
    peer_id: String,
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

    session.routing.upsert(peer_id.clone(), parsed);
    if let Err(e) = session.socket.send_to(HOLE_PUNCH_MAGIC, parsed) {
        log::warn!(
            "[RocketCompanion][Tunnel:{}] Hole-punch send_to({}, peer={}) failed: {}",
            session_id,
            parsed,
            peer_id,
            e
        );
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
        session.routing.remove(&peer_id);
    }
    Ok(())
}

#[tauri::command]
pub fn tauri_tunnel_connect(
    state: State<'_, TunnelManagerState>,
    session_id: String,
    peer_addr: String,
) -> Result<(), String> {
    tauri_tunnel_connect_peer(state, session_id, "default".to_string(), peer_addr)
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
            .routing
            .resolve_addr_by_peer("default")
            .ok_or_else(|| "No default peer address configured for tunnel session".to_string())?
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
        let all = session.routing.all_addrs();
        let peer_count = all.len();
        let peer_addr = session
            .routing
            .resolve_addr_by_peer("default")
            .or_else(|| all.first().copied())
            .map(|a| a.to_string());
        Ok(TunnelStatusInfo {
            session_id,
            open: !session.shutdown.load(Ordering::Relaxed),
            local_port: session.local_port,
            external_ip: session.upnp_lease.as_ref().map(|l| l.external_ip.to_string()),
            external_port: session.upnp_lease.as_ref().map(|l| l.external_port),
            upnp_mapped: session.upnp_lease.is_some(),
            peer_count,
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
            peer_count: 0,
            peer_addr: None,
            bytes_sent: 0,
            bytes_received: 0,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tunnel_bridge::decode_bridge_frame;

    #[test]
    fn peer_routing_table_multi_peer_upsert_and_remove() {
        let table = PeerRoutingTable::new();
        let addr1: SocketAddr = "127.0.0.1:41001".parse().unwrap();
        let addr2: SocketAddr = "127.0.0.1:41002".parse().unwrap();
        let addr1_new: SocketAddr = "127.0.0.1:41003".parse().unwrap();

        table.upsert("peer_a".to_string(), addr1);
        table.upsert("peer_b".to_string(), addr2);
        assert_eq!(table.resolve_addr_by_peer("peer_a"), Some(addr1));
        assert_eq!(table.resolve_peer_by_addr(&addr2).as_deref(), Some("peer_b"));
        assert_eq!(table.all_addrs().len(), 2);

        // Re-bind peer_a to new port; old addr1 must be evicted
        table.upsert("peer_a".to_string(), addr1_new);
        assert_eq!(table.resolve_peer_by_addr(&addr1), None);
        assert_eq!(table.resolve_peer_by_addr(&addr1_new).as_deref(), Some("peer_a"));

        table.remove("peer_a");
        assert_eq!(table.resolve_addr_by_peer("peer_a"), None);
        assert_eq!(table.all_addrs().len(), 1);
    }

    #[test]
    fn bridge_frame_roundtrip_and_udp_loopback() {
        let frame = encode_bridge_frame("peer_1", b"hello_tunnel");
        let (peer_id, payload) = decode_bridge_frame(&frame).expect("valid bridge frame");
        assert_eq!(peer_id, "peer_1");
        assert_eq!(payload, b"hello_tunnel");

        let rx = UdpSocket::bind("127.0.0.1:0").unwrap();
        let tx = UdpSocket::bind("127.0.0.1:0").unwrap();
        let rx_addr = rx.local_addr().unwrap();
        tx.send_to(HOLE_PUNCH_MAGIC, rx_addr).unwrap();
        tx.send_to(b"RCPH_DATA", rx_addr).unwrap();

        let mut buf = [0u8; 64];
        let (n1, _) = rx.recv_from(&mut buf).unwrap();
        assert_eq!(&buf[..n1], HOLE_PUNCH_MAGIC);
        let (n2, _) = rx.recv_from(&mut buf).unwrap();
        assert_eq!(&buf[..n2], b"RCPH_DATA");
    }
}

