/**
 * StreamAdapter (§2.7 "Feed adapter design"): managed WebSocket connection
 * with auto-reconnect + backoff, ping/pong keepalive, resubscribe-on-reconnect,
 * and message → typed-event mapping.
 *
 * Events pushed while the subscription is healthy are labeled LIVE; when the
 * socket drops, `snapshot()` items keep their last `fetchedAt` and consumers
 * should treat them as CACHED (§7.2).
 *
 * The WebSocket implementation is injectable (`createSocket`) so tests run
 * offline and the SDK works in Node 18+ (global WebSocket), browsers, and
 * runtimes with a custom socket (e.g. `ws` package).
 */

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type WebSocketFactory = (url: string, protocols?: string[]) => WebSocketLike;

export interface StreamEvent {
  /** Event kind, e.g. "trade", "mempool-tx", "ticker". */
  kind: string;
  /** ISO timestamp the message arrived. */
  receivedAt: string;
  data: unknown;
}

export type StreamEvents = {
  message: (event: StreamEvent) => void;
  open: () => void;
  close: (info: { code: number; reason?: string }) => void;
  error: (err: unknown) => void;
  reconnect: (attempt: number, delayMs: number) => void;
};

export interface StreamAdapterOptions {
  url: string;
  protocols?: string[];
  /** Called on every (re)connect to (re)subscribe, e.g. send {"op":"unconfirmed_sub"}. */
  subscribe?: (send: (msg: string | object) => void) => void;
  /** Map one raw message → zero, one, or many typed events. Return null to ignore. */
  parseMessage: (data: unknown) => StreamEvent | StreamEvent[] | null;
  /** Payload sent every `pingIntervalMs` to keep the connection alive. */
  pingPayload?: string | object;
  pingIntervalMs?: number;
  /** Reconnect backoff: base ms (default 1000), cap ms (default 30000). */
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /** Disable jitter for deterministic tests. */
  jitter?: boolean;
  createSocket?: WebSocketFactory;
  /** Cap on buffered snapshot events (default 500). */
  maxBuffered?: number;
  source: string;
}

export interface StreamHealth {
  connected: boolean;
  lastMessageAt?: string;
  reconnectAttempts: number;
  bufferedEvents: number;
  /** LIVE while the subscription is healthy; otherwise consumers treat snapshot as CACHED. */
  live: boolean;
}

function defaultCreateSocket(url: string, protocols?: string[]): WebSocketLike {
  const WS = (globalThis as { WebSocket?: new (url: string, protocols?: string[]) => WebSocketLike }).WebSocket;
  if (!WS) throw new Error("No WebSocket implementation available — pass `createSocket` (e.g. from the `ws` package).");
  return new WS(url, protocols);
}

export class StreamAdapter {
  private readonly opts: StreamAdapterOptions;
  private readonly listeners: { [K in keyof StreamEvents]: Array<StreamEvents[K]> } = {
    message: [],
    open: [],
    close: [],
    error: [],
    reconnect: [],
  };
  private socket?: WebSocketLike;
  private wantOpen = false;
  private reconnectAttempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private pingTimer?: ReturnType<typeof setInterval>;
  private buffer: StreamEvent[] = [];
  private lastMessageAtMs?: number;

  constructor(opts: StreamAdapterOptions) {
    this.opts = opts;
  }

  on<K extends keyof StreamEvents>(event: K, cb: StreamEvents[K]): this {
    this.listeners[event].push(cb);
    return this;
  }

  private emit<K extends keyof StreamEvents>(event: K, ...args: Parameters<StreamEvents[K]>): void {
    for (const cb of this.listeners[event]) {
      try {
        (cb as (...a: unknown[]) => void)(...args);
      } catch {
        // Listener errors must not tear down the socket.
      }
    }
  }

  connect(): this {
    this.wantOpen = true;
    this.reconnectAttempts = 0;
    this.openSocket();
    return this;
  }

  disconnect(): void {
    this.wantOpen = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.reconnectTimer = undefined;
    this.pingTimer = undefined;
    try {
      this.socket?.close(1000, "client disconnect");
    } catch {
      // ignore
    }
    this.socket = undefined;
  }

  get connected(): boolean {
    return this.socket != null && this.wantOpen;
  }

  private openSocket(): void {
    if (!this.wantOpen) return;
    const create = this.opts.createSocket ?? defaultCreateSocket;
    const socket = create(this.opts.url, this.opts.protocols);
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectAttempts = 0;
      this.emit("open");
      this.opts.subscribe?.((msg) => {
        try {
          socket.send(typeof msg === "string" ? msg : JSON.stringify(msg));
        } catch (err) {
          this.emit("error", err);
        }
      });
      if (this.opts.pingPayload !== undefined) {
        const payload = typeof this.opts.pingPayload === "string" ? this.opts.pingPayload : JSON.stringify(this.opts.pingPayload);
        const interval = this.opts.pingIntervalMs ?? 20_000;
        if (this.pingTimer) clearInterval(this.pingTimer);
        const t = setInterval(() => {
          try {
            socket.send(payload);
          } catch {
            // The close handler will schedule a reconnect.
          }
        }, interval);
        (t as { unref?: () => void }).unref?.();
        this.pingTimer = t;
      }
    };

    socket.onmessage = (ev) => {
      this.lastMessageAtMs = Date.now();
      let parsed: StreamEvent | StreamEvent[] | null;
      try {
        parsed = this.opts.parseMessage(ev.data);
      } catch (err) {
        this.emit("error", err);
        return;
      }
      if (!parsed) return;
      const events = Array.isArray(parsed) ? parsed : [parsed];
      const max = this.opts.maxBuffered ?? 500;
      for (const e of events) {
        this.buffer.push(e);
        this.emit("message", e);
      }
      while (this.buffer.length > max) this.buffer.shift();
    };

    socket.onclose = (ev) => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = undefined;
      this.emit("close", { code: ev.code, reason: ev.reason });
      if (this.wantOpen) this.scheduleReconnect();
    };

    socket.onerror = (ev) => {
      this.emit("error", ev);
    };
  }

  private scheduleReconnect(): void {
    if (!this.wantOpen || this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    const base = this.opts.reconnectBaseMs ?? 1000;
    const cap = this.opts.reconnectMaxMs ?? 30_000;
    const exp = Math.min(cap, base * 2 ** (this.reconnectAttempts - 1));
    const delayMs = this.opts.jitter === false ? exp : exp / 2 + Math.random() * (exp / 2);
    this.emit("reconnect", this.reconnectAttempts, Math.round(delayMs));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.openSocket();
    }, delayMs);
    (this.reconnectTimer as { unref?: () => void }).unref?.();
  }

  /** Recent events (oldest first). LIVE while connected; CACHED otherwise (§7.2). */
  snapshot(): StreamEvent[] {
    return [...this.buffer];
  }

  clear(): void {
    this.buffer = [];
  }

  health(): StreamHealth {
    return {
      connected: this.connected,
      lastMessageAt: this.lastMessageAtMs != null ? new Date(this.lastMessageAtMs).toISOString() : undefined,
      reconnectAttempts: this.reconnectAttempts,
      bufferedEvents: this.buffer.length,
      live: this.connected,
    };
  }
}
