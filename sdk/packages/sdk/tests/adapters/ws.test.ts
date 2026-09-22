import { describe, expect, it } from "vitest";
import { StreamAdapter, type StreamEvent, type WebSocketLike } from "../../src/adapters/ws.js";
import { sleep } from "../helpers.js";

class FakeSocket implements WebSocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.onclose?.({ code: 1000, reason: "test close" });
  }
  open(): void {
    this.onopen?.({});
  }
  receive(data: unknown): void {
    this.onmessage?.({ data });
  }
  drop(code = 1006): void {
    this.onclose?.({ code, reason: "abnormal" });
  }
}

function makeAdapter(sockets: FakeSocket[], opts: { ping?: boolean } = {}) {
  return new StreamAdapter({
    url: "wss://example.com/ws",
    source: "example",
    jitter: false,
    reconnectBaseMs: 5,
    reconnectMaxMs: 20,
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      // Open asynchronously like a real socket.
      setTimeout(() => s.open(), 1);
      return s;
    },
    subscribe: (send) => send({ op: "unconfirmed_sub" }),
    ...(opts.ping ? { pingPayload: { method: "ping" }, pingIntervalMs: 10 } : {}),
    parseMessage: (data): StreamEvent | null => {
      const raw = typeof data === "string" ? JSON.parse(data) : (data as Record<string, unknown>);
      if (raw["op"] !== "utx") return null;
      return { kind: "mempool-tx", receivedAt: new Date().toISOString(), data: { hash: raw["hash"] } };
    },
  });
}

describe("StreamAdapter", () => {
  it("connects, subscribes, and maps messages to typed events", async () => {
    const sockets: FakeSocket[] = [];
    const adapter = makeAdapter(sockets);
    const events: StreamEvent[] = [];
    adapter.on("message", (e) => events.push(e));
    adapter.connect();
    await sleep(15);
    expect(sockets).toHaveLength(1);
    expect(JSON.parse(sockets[0].sent[0])).toEqual({ op: "unconfirmed_sub" });
    sockets[0].receive(JSON.stringify({ op: "utx", hash: "abc123" }));
    sockets[0].receive(JSON.stringify({ op: "noise" })); // ignored
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("mempool-tx");
    expect((events[0].data as { hash: string }).hash).toBe("abc123");
    expect(adapter.snapshot()).toHaveLength(1);
    const h = adapter.health();
    expect(h.connected).toBe(true);
    expect(h.live).toBe(true);
    expect(h.lastMessageAt).toBeDefined();
    adapter.disconnect();
  });

  it("reconnects with backoff and resubscribes", async () => {
    const sockets: FakeSocket[] = [];
    const adapter = makeAdapter(sockets);
    const reconnects: number[] = [];
    adapter.on("reconnect", (attempt) => reconnects.push(attempt));
    adapter.connect();
    await sleep(15);
    expect(sockets).toHaveLength(1);
    sockets[0].drop(1006); // abnormal close → reconnect
    await sleep(40);
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    expect(reconnects).toEqual([1]);
    // Resubscribed on the new socket.
    expect(JSON.parse(sockets[1].sent[0])).toEqual({ op: "unconfirmed_sub" });
    adapter.disconnect();
  });

  it("does not reconnect after disconnect()", async () => {
    const sockets: FakeSocket[] = [];
    const adapter = makeAdapter(sockets);
    adapter.connect();
    await sleep(15);
    adapter.disconnect();
    const count = sockets.length;
    await sleep(40);
    expect(sockets.length).toBe(count);
    expect(adapter.health().connected).toBe(false);
    expect(adapter.health().live).toBe(false);
  });

  it("sends ping payloads on the keepalive interval", async () => {
    const sockets: FakeSocket[] = [];
    const adapter = makeAdapter(sockets, { ping: true });
    adapter.connect();
    await sleep(45);
    const pings = sockets[0].sent.filter((s) => s.includes("ping"));
    expect(pings.length).toBeGreaterThanOrEqual(1);
    adapter.disconnect();
  });

  it("caps the snapshot buffer", async () => {
    const sockets: FakeSocket[] = [];
    const adapter = new StreamAdapter({
      url: "wss://example.com/ws",
      source: "example",
      jitter: false,
      reconnectBaseMs: 5,
      maxBuffered: 3,
      createSocket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        setTimeout(() => s.open(), 1);
        return s;
      },
      parseMessage: (data) => ({ kind: "t", receivedAt: new Date().toISOString(), data }),
    });
    adapter.connect();
    await sleep(15);
    for (let i = 0; i < 10; i++) sockets[0].receive(JSON.stringify({ i }));
    expect(adapter.snapshot()).toHaveLength(3);
    adapter.disconnect();
  });
});
