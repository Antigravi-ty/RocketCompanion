/**
 * MqttWebSocketClient.js
 * Zero-dependency MQTT v3.1.1 over WebSocket client for browser WebRTC signaling.
 * Supports username/password authentication, topic subscription, QoS 0/1 publishing,
 * keepalive PINGREQ/PINGRESP, and pub/sub self-loopback verification.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function encodeRemainingLength(lengthValue) {
  const bytes = [];
  let rem = lengthValue;
  do {
    let encodedByte = rem % 128;
    rem = Math.floor(rem / 128);
    if (rem > 0) {
      encodedByte |= 128;
    }
    bytes.push(encodedByte);
  } while (rem > 0);
  return bytes;
}

function encodeMqttUtf8String(value) {
  const utf8 = textEncoder.encode(String(value || ''));
  const output = new Uint8Array(2 + utf8.length);
  output[0] = (utf8.length >> 8) & 0xff;
  output[1] = utf8.length & 0xff;
  output.set(utf8, 2);
  return output;
}

function buildMqttConnectPacket(clientId, username, password, keepAliveSeconds = 30) {
  const protocolHeader = new Uint8Array([0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, 0x04]);
  let connectFlags = 0x02;
  const payloadParts = [encodeMqttUtf8String(clientId)];

  if (username) {
    connectFlags |= 0x80;
    payloadParts.push(encodeMqttUtf8String(username));
    if (password) {
      connectFlags |= 0x40;
      payloadParts.push(encodeMqttUtf8String(password));
    }
  }

  const variableTail = new Uint8Array([
    connectFlags,
    (keepAliveSeconds >> 8) & 0xff,
    keepAliveSeconds & 0xff,
  ]);

  let bodyLength = protocolHeader.length + variableTail.length;
  for (const part of payloadParts) {
    bodyLength += part.length;
  }

  const remBytes = encodeRemainingLength(bodyLength);
  const packet = new Uint8Array(1 + remBytes.length + bodyLength);
  let offset = 0;
  packet[offset++] = 0x10;
  for (const b of remBytes) {
    packet[offset++] = b;
  }
  packet.set(protocolHeader, offset);
  offset += protocolHeader.length;
  packet.set(variableTail, offset);
  offset += variableTail.length;
  for (const part of payloadParts) {
    packet.set(part, offset);
    offset += part.length;
  }
  return packet;
}

function buildMqttSubscribePacket(packetId, topic, qos = 1) {
  const topicBytes = encodeMqttUtf8String(topic);
  const bodyLength = 2 + topicBytes.length + 1;
  const remBytes = encodeRemainingLength(bodyLength);
  const packet = new Uint8Array(1 + remBytes.length + bodyLength);
  let offset = 0;
  packet[offset++] = 0x82;
  for (const b of remBytes) {
    packet[offset++] = b;
  }
  packet[offset++] = (packetId >> 8) & 0xff;
  packet[offset++] = packetId & 0xff;
  packet.set(topicBytes, offset);
  offset += topicBytes.length;
  packet[offset++] = qos & 0x03;
  return packet;
}

function buildMqttPublishPacket(topic, messageString, qos = 0, packetId = 1) {
  const topicBytes = encodeMqttUtf8String(topic);
  const payloadBytes = textEncoder.encode(messageString);
  const packetIdLength = qos > 0 ? 2 : 0;
  const bodyLength = topicBytes.length + packetIdLength + payloadBytes.length;
  const remBytes = encodeRemainingLength(bodyLength);

  const headerByte = 0x30 | ((qos & 0x03) << 1);
  const packet = new Uint8Array(1 + remBytes.length + bodyLength);
  let offset = 0;
  packet[offset++] = headerByte;
  for (const b of remBytes) {
    packet[offset++] = b;
  }
  packet.set(topicBytes, offset);
  offset += topicBytes.length;
  if (qos > 0) {
    packet[offset++] = (packetId >> 8) & 0xff;
    packet[offset++] = packetId & 0xff;
  }
  packet.set(payloadBytes, offset);
  return packet;
}

function buildMqttPubAckPacket(packetId) {
  return new Uint8Array([
    0x40,
    0x02,
    (packetId >> 8) & 0xff,
    packetId & 0xff,
  ]);
}

export class MqttWebSocketClient {
  constructor(brokerUrl, options = {}) {
    this.brokerUrl = String(brokerUrl || '').trim();
    this.relayId = options.relayId || 'mqtt_relay';
    this.relayLabel = options.relayLabel || this.brokerUrl;
    this.topic = options.topic;
    this.peerId = options.peerId || `peer_${Math.random().toString(36).slice(2, 8)}`;
    this.clientId = options.clientId || `rc_${this.peerId}_${Math.random().toString(36).slice(2, 7)}`;
    this.username = options.username || '';
    this.password = options.password || '';
    this.keepAliveSeconds = options.keepAliveSeconds || 30;

    this.ws = null;
    this.isConnected = false;
    this.isSubscribed = false;
    this.isLoopbackVerified = false;
    this.loopbackRttMs = 0;
    this._rxBuffer = new Uint8Array(0);
    this._nextPacketId = 1;
    this._keepAliveTimer = null;
    this._probeId = `probe_${Math.random().toString(36).slice(2, 10)}`;
    this._probeSentAt = 0;
    this.eventListeners = new Map();
  }

  _allocatePacketId() {
    this._nextPacketId = (this._nextPacketId % 65534) + 1;
    return this._nextPacketId;
  }

  async connect(timeoutMs = 5000) {
    if (this.isConnected && this.isSubscribed && this.ws?.readyState === 1) {
      return;
    }

    const WebSocketConstructor = typeof WebSocket !== 'undefined'
      ? WebSocket
      : (globalThis.WebSocket || null);

    if (!WebSocketConstructor) {
      throw new Error('WebSocket is not supported in this environment');
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let timeoutHandle = null;
      let loopbackFallbackHandle = null;

      const finishSuccess = () => {
        if (settled) return;
        settled = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (loopbackFallbackHandle) clearTimeout(loopbackFallbackHandle);
        this.emit('open', { relayId: this.relayId, loopbackVerified: this.isLoopbackVerified });
        resolve();
      };

      const finishFailure = (err) => {
        if (settled) return;
        settled = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (loopbackFallbackHandle) clearTimeout(loopbackFallbackHandle);
        this.close();
        const errorObj = err instanceof Error ? err : new Error(String(err));
        this.emit('error', errorObj);
        reject(errorObj);
      };

      if (timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          finishFailure(new Error(`MQTT connection timed out after ${timeoutMs}ms (${this.relayLabel})`));
        }, timeoutMs);
      }

      let sock;
      try {
        sock = new WebSocketConstructor(this.brokerUrl, 'mqtt');
        sock.binaryType = 'arraybuffer';
        this.ws = sock;
      } catch (err) {
        return finishFailure(err);
      }

      sock.onopen = () => {
        try {
          const connectPacket = buildMqttConnectPacket(
            this.clientId,
            this.username,
            this.password,
            this.keepAliveSeconds
          );
          sock.send(connectPacket);
        } catch (err) {
          finishFailure(err);
        }
      };

      sock.onmessage = (ev) => {
        this._appendAndProcessBuffer(new Uint8Array(ev.data), {
          onSubscribed: () => {
            this._sendLoopbackSelfProbe();
            loopbackFallbackHandle = setTimeout(() => {
              finishSuccess();
            }, 350);
          },
          onLoopbackVerified: () => {
            finishSuccess();
          },
          onFatalError: (err) => {
            finishFailure(err);
          },
        });
      };

      sock.onerror = () => {
        if (!settled) {
          finishFailure(new Error(`MQTT WebSocket error (${this.relayLabel})`));
        } else {
          this.emit('error', new Error(`MQTT runtime socket error (${this.relayLabel})`));
        }
      };

      sock.onclose = (ev) => {
        this.isConnected = false;
        this.isSubscribed = false;
        this._stopKeepAlive();
        if (!settled) {
          finishFailure(new Error(`MQTT socket closed before ready (code ${ev.code})`));
        } else {
          this.emit('close', ev);
        }
      };
    });
  }

  _sendLoopbackSelfProbe() {
    this._probeSentAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.send({
      type: 'relay_loopback_probe',
      probeId: this._probeId,
      fromPeerId: this.peerId,
      relayId: this.relayId,
      timestamp: Date.now(),
    });
  }

  _appendAndProcessBuffer(chunk, hooks = {}) {
    if (!chunk || chunk.length === 0) return;
    if (this._rxBuffer.length === 0) {
      this._rxBuffer = chunk;
    } else {
      const merged = new Uint8Array(this._rxBuffer.length + chunk.length);
      merged.set(this._rxBuffer, 0);
      merged.set(chunk, this._rxBuffer.length);
      this._rxBuffer = merged;
    }

    while (this._rxBuffer.length >= 2) {
      const headerByte = this._rxBuffer[0];
      const packetType = (headerByte & 0xf0) >> 4;

      let multiplier = 1;
      let remainingLength = 0;
      let lengthByteCount = 0;
      let offset = 1;
      let malformed = false;

      while (true) {
        if (offset >= this._rxBuffer.length) {
          return;
        }
        const encodedByte = this._rxBuffer[offset++];
        lengthByteCount++;
        remainingLength += (encodedByte & 127) * multiplier;
        if ((encodedByte & 128) === 0) {
          break;
        }
        multiplier *= 128;
        if (lengthByteCount > 4) {
          malformed = true;
          break;
        }
      }

      if (malformed) {
        this._rxBuffer = new Uint8Array(0);
        hooks.onFatalError?.(new Error('Malformed MQTT remaining length'));
        return;
      }

      const totalPacketLength = 1 + lengthByteCount + remainingLength;
      if (this._rxBuffer.length < totalPacketLength) {
        return;
      }

      const body = this._rxBuffer.slice(1 + lengthByteCount, totalPacketLength);
      this._rxBuffer = this._rxBuffer.slice(totalPacketLength);

      this._handleMqttPacket(packetType, headerByte & 0x0f, body, hooks);
    }
  }

  _handleMqttPacket(packetType, flags, body, hooks = {}) {
    if (packetType === 2) {
      const returnCode = body.length >= 2 ? body[1] : 255;
      if (returnCode !== 0) {
        hooks.onFatalError?.(new Error(`MQTT CONNACK rejected with code ${returnCode}`));
        return;
      }
      this.isConnected = true;
      this._startKeepAlive();
      if (this.topic && this.ws?.readyState === 1) {
        const subPacket = buildMqttSubscribePacket(this._allocatePacketId(), this.topic, 1);
        this.ws.send(subPacket);
      } else {
        this.isSubscribed = true;
        hooks.onSubscribed?.();
      }
      return;
    }

    if (packetType === 9) {
      const grantCode = body.length >= 3 ? body[2] : 0x80;
      if (grantCode === 0x80) {
        hooks.onFatalError?.(new Error(`MQTT SUBACK rejected subscription to topic`));
        return;
      }
      this.isSubscribed = true;
      hooks.onSubscribed?.();
      return;
    }

    if (packetType === 3) {
      const qos = (flags >> 1) & 0x03;
      if (body.length < 2) return;
      const topicLength = (body[0] << 8) | body[1];
      let cursor = 2 + topicLength;
      if (qos > 0) {
        if (body.length < cursor + 2) return;
        const packetId = (body[cursor] << 8) | body[cursor + 1];
        cursor += 2;
        if (qos === 1 && this.ws?.readyState === 1) {
          try {
            this.ws.send(buildMqttPubAckPacket(packetId));
          } catch (_) {}
        }
      }
      if (cursor > body.length) return;
      const payloadBytes = body.subarray(cursor);
      try {
        const text = textDecoder.decode(payloadBytes);
        const parsed = JSON.parse(text);
        if (parsed?.type === 'relay_loopback_probe') {
          if (parsed.probeId === this._probeId && parsed.fromPeerId === this.peerId) {
            const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
            this.isLoopbackVerified = true;
            this.loopbackRttMs = Math.max(1, Math.round(now - this._probeSentAt));
            this.emit('loopback_verified', { relayId: this.relayId, rttMs: this.loopbackRttMs });
            hooks.onLoopbackVerified?.();
          }
          return;
        }
        this.emit('message', parsed);
      } catch (_) {}
      return;
    }

    if (packetType === 13) {
      this.emit('pong', { relayId: this.relayId });
    }
  }

  send(data, qos = 0) {
    if (!this.ws || this.ws.readyState !== 1 || !this.isConnected || !this.topic) {
      return false;
    }
    try {
      const jsonStr = typeof data === 'string' ? data : JSON.stringify(data);
      const packetId = qos > 0 ? this._allocatePacketId() : 0;
      const packet = buildMqttPublishPacket(this.topic, jsonStr, qos, packetId);
      this.ws.send(packet);
      return true;
    } catch (err) {
      console.warn(`[MqttWebSocketClient] Failed to publish on ${this.relayLabel}:`, err);
      return false;
    }
  }

  _startKeepAlive() {
    this._stopKeepAlive();
    const intervalMs = Math.max(10000, Math.floor(this.keepAliveSeconds * 800));
    this._keepAliveTimer = setInterval(() => {
      if (this.isConnected && this.ws?.readyState === 1) {
        try {
          this.ws.send(new Uint8Array([0xc0, 0x00]));
        } catch (_) {}
      }
    }, intervalMs);
  }

  _stopKeepAlive() {
    if (this._keepAliveTimer) {
      clearInterval(this._keepAliveTimer);
      this._keepAliveTimer = null;
    }
  }

  on(event, listener) {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event).push(listener);
  }

  off(event, listener) {
    const list = this.eventListeners.get(event);
    if (!list) return;
    this.eventListeners.set(
      event,
      list.filter((fn) => fn !== listener)
    );
  }

  emit(event, payload) {
    const list = this.eventListeners.get(event);
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      try {
        list[i](payload);
      } catch (err) {
        console.error('[MqttWebSocketClient] Listener error:', err);
      }
    }
  }

  close() {
    this._stopKeepAlive();
    if (this.ws) {
      try {
        if (this.ws.readyState === 1 && this.isConnected) {
          this.ws.send(new Uint8Array([0xe0, 0x00]));
        }
        this.ws.close(1000, 'Client closed');
      } catch (_) {}
      this.ws = null;
    }
    this.isConnected = false;
    this.isSubscribed = false;
  }
}
