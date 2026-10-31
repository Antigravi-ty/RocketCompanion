/**
 * src/network/webrtc/sdpUtils.js
 * Utilities for parsing, validating, and injecting ICE candidates and SDP lines.
 * Strictly adheres to RFC 4566 mandatory session header specifications.
 */

/**
 * Extracts the port from an ICE candidate object or candidate string.
 * Supports standard RFC 5245 candidate line:
 * candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> ...
 * @param {object|string} cand
 * @returns {number|null}
 */
export function extractCandidatePort(cand) {
  if (!cand) return null;
  if (typeof cand === "object" && cand.port) {
    const p = parseInt(cand.port, 10);
    if (!isNaN(p) && p > 0) return p;
  }
  const candStr = typeof cand === "string" ? cand : (cand?.candidate || "");
  if (typeof candStr === "string") {
    // 1. Try splitting by whitespace (port is at index 5)
    const parts = candStr.trim().split(/\s+/);
    if (parts.length >= 6) {
      const p = parseInt(parts[5], 10);
      if (!isNaN(p) && p > 0) return p;
    }
    // 2. Regex fallback: number preceding typ
    const match = candStr.match(/\s(\d{1,5})\styp\b/);
    if (match) {
      const p = parseInt(match[1], 10);
      if (!isNaN(p) && p > 0) {
        console.warn(`[sdpUtils] Standard token split did not yield port for candidate "${candStr}"; extracted port ${p} via regex fallback.`);
        return p;
      }
    }
  }
  return null;
}

/**
 * Extracts the loopback port prioritizing candidate #1, then candidate #0.
 * In WebRTC environments, port1 is often the active data component port.
 * @param {Array} candidates
 * @param {string} [sdp]
 * @returns {number}
 */
export function getLoopbackPortFromCandidates(candidates, sdp = "") {
  let cand0 = null;
  let cand1 = null;

  if (Array.isArray(candidates) && candidates.length > 0) {
    cand0 = candidates[0];
    if (candidates.length > 1) {
      cand1 = candidates[1];
    }
  }

  // Fallback: extract candidate lines from SDP
  if (!cand0 && typeof sdp === "string" && sdp.length > 0) {
    console.warn('[sdpUtils] No explicit ICE candidates provided to getLoopbackPortFromCandidates; falling back to scanning SDP a=candidate lines.');
    const matches = [...sdp.matchAll(/a=(candidate:[^\r\n]+)/g)];
    if (matches.length > 0) cand0 = matches[0][1];
    if (matches.length > 1) cand1 = matches[1][1];
  }

  const port0 = cand0 ? extractCandidatePort(cand0) : null;
  const port1 = cand1 ? extractCandidatePort(cand1) : port0;
  const resolvedPort = port1 || port0;
  if (!resolvedPort) {
    console.warn('[sdpUtils] Could not extract loopback port from candidates or SDP; falling back to default port 50000.');
    return 50000;
  }

  return resolvedPort;
}

/**
 * Creates a loopback (127.0.0.1) candidate using candidate #1 / #0 gathered port.
 * Assigns maximum host priority (2130706431) to guarantee local loopback is preferred.
 * @param {object|string} sourceCandidate
 * @param {number|null} customPort
 * @returns {object}
 */
export function createLoopbackCandidate(sourceCandidate, customPort = null) {
  const extractedPort = customPort || (sourceCandidate ? extractCandidatePort(sourceCandidate) : null);
  if (!extractedPort) {
    console.warn('[sdpUtils] createLoopbackCandidate could not resolve port from sourceCandidate; falling back to default port 50000.');
  }
  const port = extractedPort || 50000;
  const sdpMid = typeof sourceCandidate === "object" ? (sourceCandidate?.sdpMid ?? "0") : "0";
  const sdpMLineIndex = typeof sourceCandidate === "object" ? (sourceCandidate?.sdpMLineIndex ?? 0) : 0;

  const foundation = Math.floor(Math.random() * 100000) + 100000;
  const loopbackCandStr = `candidate:${foundation} 1 udp 2130706431 127.0.0.1 ${port} typ host generation 0`;

  return {
    candidate: loopbackCandStr,
    sdpMid: String(sdpMid),
    sdpMLineIndex: Number(sdpMLineIndex),
    address: "127.0.0.1",
    ip: "127.0.0.1",
    port: Number(port),
    type: "host"
  };
}

/**
 * Injects a 127.0.0.1 loopback candidate into the candidates array at index 0.
 * Prioritizing index 0 ensures the local ICE agent and remote peer process 127.0.0.1 before LAN/mDNS addresses.
 * @param {Array} candidates
 * @param {string} [sdp]
 * @returns {Array}
 */
export function injectLoopbackCandidate(candidates, sdp = "") {
  let list = Array.isArray(candidates) ? [...candidates] : [];
  
  // Filter out any stale loopback candidate so we can reinsert at index 0 with latest gathered port
  list = list.filter(c => {
    const s = typeof c === "string" ? c : (c?.candidate || c?.ip || c?.address || "");
    return !s.includes("127.0.0.1");
  });

  let sourceCand = list.length > 0 ? list[0] : null;
  if (!sourceCand && typeof sdp === "string") {
    const m = sdp.match(/a=(candidate:[^\r\n]+)/);
    if (m) {
      sourceCand = { candidate: m[1], sdpMid: "0", sdpMLineIndex: 0 };
    }
  }

  const port = getLoopbackPortFromCandidates(list, sdp);
  const loopback = createLoopbackCandidate(sourceCand, port);

  // Return with 127.0.0.1 strictly placed at index 0
  return [loopback, ...list];
}

/**
 * Ensures the SDP strictly conforms to RFC 4566 mandatory session header structure:
 * v=0
 * o=- <session-id> <session-version> IN IP4 <address>
 * s=-
 * t=0 0
 * WebRTC implementations (especially WebKit/Safari) throw "SyntaxError: Expect line: o="
 * if the o= line is missing or stripped.
 * @param {string} sdp
 * @returns {string}
 */
export function ensureValidSdp(sdp) {
  if (!sdp || typeof sdp !== "string") return sdp;

  const normalized = sdp.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");

  // 1. Ensure v= line
  if (!lines.some(l => l.startsWith("v="))) {
    lines.unshift("v=0");
  }

  // 2. Ensure o= line (RFC 4566 mandatory directly after v=)
  if (!lines.some(l => l.startsWith("o="))) {
    const vIdx = lines.findIndex(l => l.startsWith("v="));
    const sessionId = Math.floor(Math.random() * 1000000000) + 1000000000;
    const oLine = `o=- ${sessionId} 2 IN IP4 127.0.0.1`;
    if (vIdx !== -1) {
      lines.splice(vIdx + 1, 0, oLine);
    } else {
      lines.unshift(oLine);
    }
  }

  // 3. Ensure s= line
  if (!lines.some(l => l.startsWith("s="))) {
    const oIdx = lines.findIndex(l => l.startsWith("o="));
    if (oIdx !== -1) {
      lines.splice(oIdx + 1, 0, "s=-");
    } else {
      lines.push("s=-");
    }
  }

  // 4. Ensure t= line
  if (!lines.some(l => l.startsWith("t="))) {
    const sIdx = lines.findIndex(l => l.startsWith("s="));
    if (sIdx !== -1) {
      lines.splice(sIdx + 1, 0, "t=0 0");
    } else {
      lines.push("t=0 0");
    }
  }

  return lines.join("\r\n");
}

/**
 * Injects the loopback candidate line into the SDP BEFORE existing candidate lines.
 * Placing 127.0.0.1 before existing a=candidate: lines ensures the WebRTC parser
 * processes the loopback candidate first and avoids connection timeout on local interfaces.
 * @param {string} sdp
 * @param {object|string} loopbackCand
 * @returns {string}
 */
export function injectLoopbackIntoSdp(sdp, loopbackCand) {
  if (!sdp || typeof sdp !== "string") return sdp;

  let candStr = "";
  if (typeof loopbackCand === "string") {
    candStr = loopbackCand.startsWith("a=") ? loopbackCand.slice(2) : loopbackCand;
  } else if (loopbackCand && loopbackCand.candidate) {
    candStr = loopbackCand.candidate.startsWith("a=") ? loopbackCand.candidate.slice(2) : loopbackCand.candidate;
  }

  const validSdp = ensureValidSdp(sdp);
  if (!candStr) return validSdp;

  // CRITICAL: Only filter out candidate lines starting with "a=candidate:" that contain "127.0.0.1"!
  // NEVER filter out "o=" (origin) lines like "o=- ... IN IP4 127.0.0.1", which breaks RFC 4566
  // and causes WebKit/Safari to throw "SyntaxError: Expect line: o="!
  const cleanLines = validSdp.split("\r\n").filter(l => !(l.startsWith("a=candidate:") && l.includes("127.0.0.1")));
  const customLine = `a=${candStr.trim()}`;
  let inserted = false;
  const res = [];

  for (const l of cleanLines) {
    // Insert customLine BEFORE the very first a=candidate: line!
    if (!inserted && l.startsWith("a=candidate:")) {
      res.push(customLine);
      inserted = true;
    }
    res.push(l);
  }

  if (!inserted) {
    // If no candidate line exists yet, insert right after m= section
    const mIdx = res.findIndex(l => l.startsWith("m="));
    if (mIdx !== -1) {
      res.splice(mIdx + 1, 0, customLine);
    } else {
      res.push(customLine);
    }
  }

  return ensureValidSdp(res.join("\r\n"));
}

/**
 * Convenience helper matching minimal WebRTC test injectLoopback signature
 * @param {string} sdp
 * @param {Array} [candidates=[]]
 * @returns {string}
 */
export function injectLoopback(sdp, candidates = []) {
  if (!sdp || typeof sdp !== "string") return sdp;
  const port = getLoopbackPortFromCandidates(candidates, sdp);
  const foundation = Math.floor(Math.random() * 100000);
  const customLine = `a=candidate:${foundation} 1 udp 2130706431 127.0.0.1 ${port} typ host generation 0`;
  return injectLoopbackIntoSdp(sdp, customLine);
}
