use futures_util::{SinkExt, StreamExt};
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::net::{SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::AsyncReadExt;
use tokio::net::TcpListener;
use tokio::sync::{broadcast, watch};
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::Message;
use wtransport::endpoint::IncomingSession;
use wtransport::{Endpoint, Identity, ServerConfig};

pub const BRIDGE_CHANNEL_CAPACITY: usize = 1024;
const TUNNEL_ENVELOPE_FLAG_RELIABLE: u8 = 1 << 1;

#[derive(Clone)]
pub struct PeerRoutingTable {
    pub peers: Arc<Mutex<HashMap<String, SocketAddr>>>,
    pub addr_to_peer: Arc<Mutex<HashMap<SocketAddr, String>>>,
}

impl PeerRoutingTable {
    pub fn new() -> Self {
        Self {
            peers: Arc::new(Mutex::new(HashMap::new())),
            addr_to_peer: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn upsert(&self, peer_id: String, addr: SocketAddr) {
        if let (Ok(mut p), Ok(mut a)) = (self.peers.lock(), self.addr_to_peer.lock()) {
            if let Some(old_addr) = p.insert(peer_id.clone(), addr) {
                if old_addr != addr {
                    a.remove(&old_addr);
                }
            }
            a.insert(addr, peer_id);
        }
    }

    pub fn remove(&self, peer_id: &str) {
        if let (Ok(mut p), Ok(mut a)) = (self.peers.lock(), self.addr_to_peer.lock()) {
            if let Some(addr) = p.remove(peer_id) {
                a.remove(&addr);
            }
        }
    }

    pub fn resolve_peer_by_addr(&self, addr: &SocketAddr) -> Option<String> {
        self.addr_to_peer
            .lock()
            .ok()
            .and_then(|g| g.get(addr).cloned())
    }

    pub fn resolve_addr_by_peer(&self, peer_id: &str) -> Option<SocketAddr> {
        self.peers.lock().ok().and_then(|g| g.get(peer_id).copied())
    }

    pub fn all_addrs(&self) -> Vec<SocketAddr> {
        self.peers
            .lock()
            .ok()
            .map(|g| g.values().copied().collect())
            .unwrap_or_default()
    }
}

pub fn encode_bridge_frame(peer_id: &str, payload: &[u8]) -> Vec<u8> {
    let id_bytes = peer_id.as_bytes();
    let id_len = id_bytes.len().min(255);
    let mut out = Vec::with_capacity(1 + id_len + payload.len());
    out.push(id_len as u8);
    out.extend_from_slice(&id_bytes[..id_len]);
    out.extend_from_slice(payload);
    out
}

pub fn decode_bridge_frame(frame: &[u8]) -> Option<(&str, &[u8])> {
    if frame.is_empty() {
        return None;
    }
    let id_len = frame[0] as usize;
    if frame.len() < 1 + id_len {
        return None;
    }
    let peer_id = std::str::from_utf8(&frame[1..1 + id_len]).ok()?;
    Some((peer_id, &frame[1 + id_len..]))
}

fn is_reliable_envelope(payload: &[u8]) -> bool {
    payload.len() >= 8
        && payload[0] == 0x52
        && payload[1] == 0x43
        && (payload[5] & TUNNEL_ENVELOPE_FLAG_RELIABLE) != 0
}

fn forward_bridge_frame_to_udp(
    frame: &[u8],
    udp_socket: &UdpSocket,
    routing: &PeerRoutingTable,
    bytes_sent: &AtomicU64,
    session_id: &str,
) {
    let Some((peer_id, payload)) = decode_bridge_frame(frame) else {
        log::warn!(
            "[RocketCompanion][Bridge:{}] Dropping malformed local bridge frame (len={})",
            session_id,
            frame.len()
        );
        return;
    };

    if peer_id == "*" {
        for addr in routing.all_addrs() {
            match udp_socket.send_to(payload, addr) {
                Ok(n) => {
                    bytes_sent.fetch_add(n as u64, Ordering::Relaxed);
                }
                Err(e) => {
                    log::warn!(
                        "[RocketCompanion][Bridge:{}] Broadcast send_to({}) failed: {}",
                        session_id,
                        addr,
                        e
                    );
                }
            }
        }
        return;
    }

    let Some(dest) = routing.resolve_addr_by_peer(peer_id) else {
        log::warn!(
            "[RocketCompanion][Bridge:{}] Unknown peer_id '{}' on outbound send",
            session_id,
            peer_id
        );
        return;
    };

    match udp_socket.send_to(payload, dest) {
        Ok(n) => {
            bytes_sent.fetch_add(n as u64, Ordering::Relaxed);
        }
        Err(e) => {
            log::error!(
                "[RocketCompanion][Bridge:{}] UDP send_to({}, peer={}) failed: {}",
                session_id,
                dest,
                peer_id,
                e
            );
            eprintln!(
                "[RocketCompanion][Bridge:{}] ERROR UDP send_to({}, peer={}) failed: {}",
                session_id, dest, peer_id, e
            );
        }
    }
}

fn generate_auth_token() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn query_has_valid_token(path_and_query: &str, expected_token: &str) -> bool {
    let Some((_, query)) = path_and_query.split_once('?') else {
        return false;
    };
    query.split('&').any(|pair| {
        if let Some((k, v)) = pair.split_once('=') {
            k == "token" && v == expected_token
        } else {
            false
        }
    })
}

pub struct LocalBridgeHandles {
    pub wt_url: Option<String>,
    pub wt_cert_hash: Option<Vec<u8>>,
    pub wt_error: Option<String>,
    pub ws_url: String,
    pub auth_token: String,
    pub rx_broadcast: broadcast::Sender<Vec<u8>>,
    pub shutdown_tx: watch::Sender<bool>,
}

pub async fn start_local_bridge(
    session_id: String,
    udp_socket: Arc<UdpSocket>,
    routing: PeerRoutingTable,
    bytes_sent: Arc<AtomicU64>,
    shutdown_flag: Arc<AtomicBool>,
) -> Result<LocalBridgeHandles, String> {
    let auth_token = generate_auth_token();
    let (rx_broadcast, _) = broadcast::channel::<Vec<u8>>(BRIDGE_CHANNEL_CAPACITY);
    let (shutdown_tx, shutdown_rx) = watch::channel(false);

    // 1. Start WebSocket fallback listener on 127.0.0.1:0
    let ws_listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind local WebSocket bridge: {}", e))?;
    let ws_port = ws_listener
        .local_addr()
        .map_err(|e| format!("Failed to read local WebSocket port: {}", e))?
        .port();
    let ws_url = format!("ws://127.0.0.1:{}/tunnel?token={}", ws_port, auth_token);

    {
        let sid = session_id.clone();
        let token = auth_token.clone();
        let udp = Arc::clone(&udp_socket);
        let rt = routing.clone();
        let sent = Arc::clone(&bytes_sent);
        let rx_tx = rx_broadcast.clone();
        let mut sd_rx = shutdown_rx.clone();
        let sd_flag = Arc::clone(&shutdown_flag);

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = sd_rx.changed() => {
                        if *sd_rx.borrow() { break; }
                    }
                    accept_res = ws_listener.accept() => {
                        let Ok((tcp_stream, peer_addr)) = accept_res else {
                            if sd_flag.load(Ordering::Relaxed) { break; }
                            continue;
                        };
                        let _ = tcp_stream.set_nodelay(true);
                        let sid_c = sid.clone();
                        let tok_c = token.clone();
                        let udp_c = Arc::clone(&udp);
                        let rt_c = rt.clone();
                        let sent_c = Arc::clone(&sent);
                        let mut rx_sub = rx_tx.subscribe();
                        let mut sd_conn = sd_rx.clone();

                        tokio::spawn(async move {
                            let mut authorized = false;
                            let ws_res = tokio_tungstenite::accept_hdr_async(
                                tcp_stream,
                                |req: &Request, res: Response| {
                                    let uri = req.uri().to_string();
                                    authorized = query_has_valid_token(&uri, &tok_c);
                                    if !authorized {
                                        log::error!("[RocketCompanion][WSBridge:{}] Rejected unauthorized WS connection from {}", sid_c, peer_addr);
                                    }
                                    Ok(res)
                                },
                            ).await;

                            let ws_stream = match ws_res {
                                Ok(s) if authorized => s,
                                Ok(_) => return,
                                Err(e) => {
                                    log::error!("[RocketCompanion][WSBridge:{}] Handshake error: {}", sid_c, e);
                                    eprintln!("[RocketCompanion][WSBridge:{}] ERROR handshake: {}", sid_c, e);
                                    return;
                                }
                            };

                            log::warn!("[RocketCompanion][WSBridge:{}] Client connected via WebSocket fallback ({})", sid_c, peer_addr);
                            eprintln!("[RocketCompanion][WSBridge:{}] FALLBACK ACTIVE: Client connected via WebSocket ({})", sid_c, peer_addr);

                            let (mut ws_sink, mut ws_source) = ws_stream.split();
                            loop {
                                tokio::select! {
                                    _ = sd_conn.changed() => {
                                        if *sd_conn.borrow() { break; }
                                    }
                                    inbound = rx_sub.recv() => {
                                        match inbound {
                                            Ok(frame) => {
                                                if ws_sink.send(Message::Binary(frame.into())).await.is_err() {
                                                    break;
                                                }
                                            }
                                            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                                                log::warn!("[RocketCompanion][WSBridge:{}] Dropped {} lagged inbound packets", sid_c, skipped);
                                            }
                                            Err(broadcast::error::RecvError::Closed) => break,
                                        }
                                    }
                                    msg = ws_source.next() => {
                                        match msg {
                                            Some(Ok(Message::Binary(data))) => {
                                                forward_bridge_frame_to_udp(&data, &udp_c, &rt_c, &sent_c, &sid_c);
                                            }
                                            Some(Ok(Message::Close(_))) | None => break,
                                            Some(Err(e)) => {
                                                log::warn!("[RocketCompanion][WSBridge:{}] Read error: {}", sid_c, e);
                                                break;
                                            }
                                            _ => {}
                                        }
                                    }
                                }
                            }
                        });
                    }
                }
            }
        });
    }

    // 2. Start WebTransport primary listener on 127.0.0.1:0
    let (wt_url, wt_cert_hash, wt_error) = match start_webtransport_server(
        session_id,
        auth_token.clone(),
        udp_socket,
        routing,
        bytes_sent,
        rx_broadcast.clone(),
        shutdown_rx,
    ) {
        Ok((url, hash)) => (Some(url), Some(hash), None),
        Err(err) => {
            log::error!("[RocketCompanion][WTBridge] Failed to start WebTransport server: {}", err);
            eprintln!("[RocketCompanion][WTBridge] ERROR: Failed to start WebTransport server: {}", err);
            (None, None, Some(err))
        }
    };

    Ok(LocalBridgeHandles {
        wt_url,
        wt_cert_hash,
        wt_error,
        ws_url,
        auth_token,
        rx_broadcast,
        shutdown_tx,
    })
}

fn start_webtransport_server(
    session_id: String,
    auth_token: String,
    udp_socket: Arc<UdpSocket>,
    routing: PeerRoutingTable,
    bytes_sent: Arc<AtomicU64>,
    rx_broadcast: broadcast::Sender<Vec<u8>>,
    mut shutdown_rx: watch::Receiver<bool>,
) -> Result<(String, Vec<u8>), String> {
    let identity = Identity::self_signed(["localhost", "127.0.0.1"])
        .map_err(|e| format!("Failed to generate self-signed WebTransport identity: {}", e))?;
    let leaf_cert = identity
        .certificate_chain()
        .as_slice()
        .first()
        .ok_or_else(|| "Missing leaf certificate in generated WebTransport identity".to_string())?;
    let cert_hash = Sha256::digest(leaf_cert.der()).to_vec();

    let bind_addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
    let config = ServerConfig::builder()
        .with_bind_address(bind_addr)
        .with_identity(identity)
        .build();

    let endpoint = Endpoint::server(config)
        .map_err(|e| format!("Failed to bind WebTransport endpoint: {}", e))?;
    let local_port = endpoint
        .local_addr()
        .map_err(|e| format!("Failed to read WebTransport local_addr: {}", e))?
        .port();
    let wt_url = format!("https://127.0.0.1:{}/tunnel?token={}", local_port, auth_token);

    log::info!(
        "[RocketCompanion][WTBridge:{}] Listening on {}",
        session_id,
        wt_url
    );

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = shutdown_rx.changed() => {
                    if *shutdown_rx.borrow() { break; }
                }
                incoming = endpoint.accept() => {
                    let sid = session_id.clone();
                    let tok = auth_token.clone();
                    let udp = Arc::clone(&udp_socket);
                    let rt = routing.clone();
                    let sent = Arc::clone(&bytes_sent);
                    let rx_sub = rx_broadcast.subscribe();
                    let sd = shutdown_rx.clone();

                    tokio::spawn(async move {
                        handle_wt_session(incoming, sid, tok, udp, rt, sent, rx_sub, sd).await;
                    });
                }
            }
        }
    });

    Ok((wt_url, cert_hash))
}

async fn handle_wt_session(
    incoming: IncomingSession,
    session_id: String,
    auth_token: String,
    udp_socket: Arc<UdpSocket>,
    routing: PeerRoutingTable,
    bytes_sent: Arc<AtomicU64>,
    mut rx_sub: broadcast::Receiver<Vec<u8>>,
    mut shutdown_rx: watch::Receiver<bool>,
) {
    let session_req = match incoming.await {
        Ok(req) => req,
        Err(e) => {
            log::error!("[RocketCompanion][WTBridge:{}] Incoming session error: {}", session_id, e);
            eprintln!("[RocketCompanion][WTBridge:{}] ERROR incoming session: {}", session_id, e);
            return;
        }
    };

    if !query_has_valid_token(session_req.path(), &auth_token) {
        log::error!(
            "[RocketCompanion][WTBridge:{}] Rejected unauthorized WebTransport session path: {}",
            session_id,
            session_req.path()
        );
        session_req.forbidden().await;
        return;
    }

    let connection = match session_req.accept().await {
        Ok(conn) => Arc::new(conn),
        Err(e) => {
            log::error!("[RocketCompanion][WTBridge:{}] Accept session failed: {}", session_id, e);
            eprintln!("[RocketCompanion][WTBridge:{}] ERROR accept session: {}", session_id, e);
            return;
        }
    };

    log::info!(
        "[RocketCompanion][WTBridge:{}] WebTransport session established (remote={})",
        session_id,
        connection.remote_address()
    );

    loop {
        tokio::select! {
            _ = shutdown_rx.changed() => {
                if *shutdown_rx.borrow() { break; }
            }
            inbound = rx_sub.recv() => {
                match inbound {
                    Ok(frame) => {
                        let is_reliable = decode_bridge_frame(&frame)
                            .map(|(_, p)| is_reliable_envelope(p))
                            .unwrap_or(false);
                        if is_reliable || frame.len() > 1150 {
                            let conn_c = Arc::clone(&connection);
                            let sid_c = session_id.clone();
                            tokio::spawn(async move {
                                match conn_c.open_uni().await {
                                    Ok(opening) => {
                                        if let Ok(mut send_stream) = opening.await {
                                            let _ = send_stream.write_all(&frame).await;
                                            let _ = send_stream.finish().await;
                                        }
                                    }
                                    Err(e) => {
                                        log::warn!("[RocketCompanion][WTBridge:{}] open_uni failed: {}", sid_c, e);
                                    }
                                }
                            });
                        } else if let Err(e) = connection.send_datagram(&frame) {
                            log::warn!("[RocketCompanion][WTBridge:{}] send_datagram failed: {}", session_id, e);
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        log::warn!("[RocketCompanion][WTBridge:{}] Dropped {} lagged inbound packets", session_id, skipped);
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            dgram = connection.receive_datagram() => {
                match dgram {
                    Ok(data) => {
                        forward_bridge_frame_to_udp(&data, &udp_socket, &routing, &bytes_sent, &session_id);
                    }
                    Err(e) => {
                        log::warn!("[RocketCompanion][WTBridge:{}] Session closed/datagram err: {}", session_id, e);
                        break;
                    }
                }
            }
            uni = connection.accept_uni() => {
                match uni {
                    Ok(mut recv_stream) => {
                        let udp_c = Arc::clone(&udp_socket);
                        let rt_c = routing.clone();
                        let sent_c = Arc::clone(&bytes_sent);
                        let sid_c = session_id.clone();
                        tokio::spawn(async move {
                            let mut buf = Vec::with_capacity(2048);
                            if recv_stream.read_to_end(&mut buf).await.is_ok() && !buf.is_empty() {
                                forward_bridge_frame_to_udp(&buf, &udp_c, &rt_c, &sent_c, &sid_c);
                            }
                        });
                    }
                    Err(e) => {
                        log::warn!("[RocketCompanion][WTBridge:{}] accept_uni closed: {}", session_id, e);
                        break;
                    }
                }
            }
        }
    }
}
