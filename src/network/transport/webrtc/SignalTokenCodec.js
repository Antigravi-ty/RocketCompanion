/**
 * src/network/webrtc/signalTokenCodec.js
 * Base64 URL-safe pack / unpack and token serialization for WebRTC signaling.
 */

import { injectLoopback } from './SdpUtils.js';

/**
 * Base64 URL-safe pack / unpack compatible with both RL tokens and test tokens
 */
export function packSdp(sdpObj, candidates = []) {
  const sdpStr = typeof sdpObj === "string" ? sdpObj : (sdpObj?.sdp || "");
  const type = (typeof sdpObj === "object" && sdpObj?.type) ? sdpObj.type : "offer";
  return btoa(encodeURIComponent(JSON.stringify({ type, sdp: injectLoopback(sdpStr, candidates) })));
}

export function unpackSdp(str) {
  if (!str) return null;
  return JSON.parse(decodeURIComponent(atob(str.trim())));
}

export const pack = packSdp;
export const unpack = unpackSdp;

export function encodeSignalToken(obj) {
  const json = JSON.stringify(obj);
  return btoa(
    encodeURIComponent(json).replace(/%([0-9A-F]{2})/g, (match, p1) =>
      String.fromCharCode(parseInt(p1, 16))
    )
  );
}

export function decodeSignalToken(tokenStr) {
  if (!tokenStr) throw new Error("Token string is empty");
  const clean = tokenStr.trim().replace(/^RL_(OFFER|ANSWER)_/, "");
  try {
    const raw = atob(clean);
    try {
      const json = decodeURIComponent(
        raw.split("").map(c => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2)).join("")
      );
      return JSON.parse(json);
    } catch (uriErr) {
      console.warn('[P2PWebRTCChannel] decodeURIComponent failed in decodeSignalToken, falling back to raw atob JSON:', uriErr);
      return JSON.parse(raw);
    }
  } catch (b64Err) {
    console.warn('[P2PWebRTCChannel] Base64 decode failed in decodeSignalToken, falling back to direct JSON parse:', b64Err);
    return JSON.parse(tokenStr.trim());
  }
}
