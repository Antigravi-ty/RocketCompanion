/**
 * src/network/transport/tunnel/LocalBridgeClient.ts
 * Worker-safe localhost bridge client: connects to Rust's local WebTransport (QUIC)
 * server as primary transport, and falls back loudly to local WebSocket on failure.
 */

import type { LocalBridgeMode, TunnelDiagnosticWarning } from './TunnelTransport.ts';

interface WebTransportHashInit {
  algorithm: 'sha-256';
  value: BufferSource;
}

interface WebTransportInstance {
  ready: Promise<void>;
  closed: Promise<{ closeCode?: number; reason?: string }>;
  datagrams: {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  };
  incomingUnidirectionalStreams: ReadableStream<ReadableStream<Uint8Array>>;
  createUnidirectionalStream(): Promise<WritableStream<Uint8Array>>;
  close(): void;
}

type WebTransportConstructor = new (
  url: string,
  options?: { serverCertificateHashes?: WebTransportHashInit[] }
) => WebTransportInstance;

export interface LocalBridgeConnectOptions {
  wtUrl?: string | null;
  wtCertHash?: number[] | null;
  wtError?: string | null;
  wsUrl: string;
  onFrame: (frame: Uint8Array) => void;
  onWarning?: (warning: TunnelDiagnosticWarning) => void;
  onClose?: (reason: string) => void;
}

export class LocalBridgeClient {
  mode: LocalBridgeMode = 'webtransport';
  private wt: WebTransportInstance | null = null;
  private wtDatagramWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private ws: WebSocket | null = null;
  private closed = false;
  private readonly options: LocalBridgeConnectOptions;

  constructor(options: LocalBridgeConnectOptions) {
    this.options = options;
  }

  async connect(): Promise<LocalBridgeMode> {
    this.closed = false;
    const wtCtor = (globalThis as unknown as { WebTransport?: WebTransportConstructor })
      .WebTransport;

    if (wtCtor && this.options.wtUrl && this.options.wtCertHash?.length) {
      try {
        const certHash = new Uint8Array(this.options.wtCertHash);
        const wt = new wtCtor(this.options.wtUrl, {
          serverCertificateHashes: [{ algorithm: 'sha-256', value: certHash }],
        });
        await wt.ready;
        this.wt = wt;
        this.wtDatagramWriter = wt.datagrams.writable.getWriter();
        this.mode = 'webtransport';
        this.pumpWebTransportDatagrams(wt);
        this.pumpWebTransportUniStreams(wt);
        void wt.closed
          .then((info) => {
            if (!this.closed) {
              const reason = info?.reason || `code=${info?.closeCode ?? 0}`;
              console.warn('[LocalBridgeClient] WebTransport closed:', reason);
              this.options.onClose?.(reason);
            }
          })
          .catch((err) => {
            if (!this.closed) {
              console.error('[LocalBridgeClient] WebTransport closed with error:', err);
              this.options.onClose?.(err instanceof Error ? err.message : String(err));
            }
          });
        console.info('[LocalBridgeClient] Connected via local WebTransport:', this.options.wtUrl);
        return 'webtransport';
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(
          '[LocalBridgeClient] WebTransport failed, falling back to local WebSocket:',
          reason
        );
        this.options.onWarning?.({
          code: 'WEBTRANSPORT_FALLBACK_TO_WEBSOCKET',
          message: 'Local WebTransport unavailable; using WebSocket loopback fallback.',
          detail: reason,
        });
      }
    } else {
      const reason =
        this.options.wtError ||
        (!wtCtor ? 'WebTransport API unavailable in current runtime' : 'Missing wtUrl/wtCertHash');
      console.warn(
        '[LocalBridgeClient] WebTransport unavailable, falling back to local WebSocket:',
        reason
      );
      this.options.onWarning?.({
        code: 'WEBTRANSPORT_FALLBACK_TO_WEBSOCKET',
        message: 'Local WebTransport unavailable; using WebSocket loopback fallback.',
        detail: reason,
      });
    }

    await this.connectWebSocket(this.options.wsUrl);
    this.mode = 'websocket';
    return 'websocket';
  }

  private connectWebSocket(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      let settled = false;

      ws.onopen = () => {
        settled = true;
        this.ws = ws;
        console.warn('[LocalBridgeClient] Connected via local WebSocket fallback:', wsUrl);
        resolve();
      };

      ws.onerror = () => {
        const err = new Error(`Local WebSocket bridge connection error (${wsUrl})`);
        console.error('[LocalBridgeClient]', err.message);
        if (!settled) {
          settled = true;
          reject(err);
        }
      };

      ws.onclose = (ev) => {
        if (!this.closed) {
          const reason = ev.reason || `code=${ev.code}`;
          console.warn('[LocalBridgeClient] WebSocket closed:', reason);
          this.options.onClose?.(reason);
        }
      };

      ws.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) {
          this.options.onFrame(new Uint8Array(ev.data));
        } else if (ev.data instanceof Uint8Array) {
          this.options.onFrame(ev.data);
        }
      };
    });
  }

  private pumpWebTransportDatagrams(wt: WebTransportInstance): void {
    const reader = wt.datagrams.readable.getReader();
    const pump = async () => {
      try {
        while (!this.closed) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) this.options.onFrame(value);
        }
      } catch (err) {
        if (!this.closed) {
          console.warn('[LocalBridgeClient] WebTransport datagram reader stopped:', err);
        }
      } finally {
        reader.releaseLock();
      }
    };
    void pump();
  }

  private pumpWebTransportUniStreams(wt: WebTransportInstance): void {
    const reader = wt.incomingUnidirectionalStreams.getReader();
    const pump = async () => {
      try {
        while (!this.closed) {
          const { value: stream, done } = await reader.read();
          if (done) break;
          if (stream) void this.readUniStream(stream);
        }
      } catch (err) {
        if (!this.closed) {
          console.warn('[LocalBridgeClient] WebTransport uni-stream acceptor stopped:', err);
        }
      } finally {
        reader.releaseLock();
      }
    };
    void pump();
  }

  private async readUniStream(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          chunks.push(value);
          total += value.byteLength;
        }
      }
      if (total > 0) {
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          merged.set(chunk, offset);
          offset += chunk.byteLength;
        }
        this.options.onFrame(merged);
      }
    } catch (err) {
      if (!this.closed) {
        console.warn('[LocalBridgeClient] WebTransport uni-stream read error:', err);
      }
    } finally {
      reader.releaseLock();
    }
  }

  sendFrame(frame: Uint8Array, reliable: boolean = false): boolean {
    if (this.closed) return false;
    if (this.mode === 'webtransport' && this.wt) {
      if (reliable || frame.byteLength > 1150) {
        void this.sendReliableUniStream(frame);
        return true;
      }
      if (this.wtDatagramWriter) {
        void this.wtDatagramWriter.write(frame).catch((err) => {
          console.warn('[LocalBridgeClient] WebTransport datagram write failed:', err);
        });
        return true;
      }
      return false;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const payload =
        frame.buffer instanceof ArrayBuffer
          ? (frame as Uint8Array<ArrayBuffer>)
          : new Uint8Array(frame);
      this.ws.send(payload);
      return true;
    }
    return false;
  }

  private async sendReliableUniStream(frame: Uint8Array): Promise<void> {
    if (!this.wt || this.closed) return;
    try {
      const stream = await this.wt.createUnidirectionalStream();
      const writer = stream.getWriter();
      await writer.write(frame);
      await writer.close();
    } catch (err) {
      if (!this.closed) {
        console.warn('[LocalBridgeClient] WebTransport reliable uni-stream write failed:', err);
      }
    }
  }

  close(): void {
    this.closed = true;
    if (this.wtDatagramWriter) {
      try {
        this.wtDatagramWriter.releaseLock();
      } catch {
        // ignore
      }
      this.wtDatagramWriter = null;
    }
    if (this.wt) {
      try {
        this.wt.close();
      } catch {
        // ignore
      }
      this.wt = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }
}
