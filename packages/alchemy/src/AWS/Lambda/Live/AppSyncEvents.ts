/**
 * Minimal AWS AppSync Events client: SigV4-authenticated WebSocket
 * subscriptions plus signed HTTPS publishes.
 *
 * Mirrors the protocol SST v3 uses for its live bridge:
 * - Connect: `wss://{realtime}/event/realtime` with subprotocols
 *   `aws-appsync-event-ws` and `header-{base64url(signed headers)}`, then a
 *   `connection_init` / `connection_ack` handshake.
 * - Subscribe: a `subscribe` frame whose `authorization` is the signed header
 *   set for `POST https://{http}/event` with body `{"channel": ...}`.
 * - Publish: a plain SigV4-signed `POST https://{http}/event` (never over the
 *   WebSocket).
 * - Keepalive: the server sends `ka` frames; missing them for
 *   `connectionTimeoutMs` means the connection is dead.
 *
 * Plain TypeScript (global `WebSocket` + `fetch`, available on Node >= 22 and
 * Bun) because it is bundled into the bridge Lambda; the local (Effect) side
 * wraps it.
 */
import { signRequest, type AwsCredentials } from "./SigV4.ts";

export interface AppSyncEventsClientOptions {
  /** e.g. `abc123.appsync-api.us-east-1.amazonaws.com` */
  httpEndpoint: string;
  /** e.g. `abc123.appsync-realtime-api.us-east-1.amazonaws.com` */
  realtimeEndpoint: string;
  region: string;
  getCredentials: () => Promise<AwsCredentials>;
  log?: (message: string) => void;
}

interface Subscription {
  channel: string;
  handler: (event: string) => void;
}

const SUBSCRIBE_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_MS = 10_000;
const RECONNECT_DELAY_MS = 5_000;

export class AppSyncEventsClient {
  private ws: WebSocket | undefined;
  private connecting: Promise<void> | undefined;
  private subscriptions = new Map<string, Subscription>();
  private acks = new Map<string, (error?: Error) => void>();
  private kaTimeoutMs = 5 * 60_000;
  private kaTimer: ReturnType<typeof setTimeout> | undefined;
  private lastActivity = 0;
  private nextSubscriptionId = 0;
  private closed = false;

  constructor(private readonly options: AppSyncEventsClientOptions) {}

  private log(message: string) {
    this.options.log?.(`[appsync] ${message}`);
  }

  /**
   * Signed header set authorizing a `POST /event` with the given body — used
   * both as the WebSocket connect subprotocol payload and per-subscription
   * authorization.
   */
  private async getAuth(body: unknown): Promise<Record<string, string>> {
    const credentials = await this.options.getCredentials();
    const bodyJson = JSON.stringify(body);
    const url = new URL(`https://${this.options.httpEndpoint}/event`);
    const signed = signRequest(
      {
        method: "POST",
        url,
        headers: {
          accept: "application/json, text/javascript",
          "content-encoding": "amz-1.0",
          "content-type": "application/json; charset=UTF-8",
        },
        body: bodyJson,
      },
      {
        credentials,
        region: this.options.region,
        service: "appsync",
      },
    );
    const auth: Record<string, string> = {
      accept: signed.accept,
      "content-encoding": signed["content-encoding"],
      "content-type": signed["content-type"],
      host: signed.host,
      "x-amz-date": signed["x-amz-date"],
      Authorization: signed.authorization,
    };
    if (signed["x-amz-security-token"]) {
      auth["X-Amz-Security-Token"] = signed["x-amz-security-token"];
    }
    return auth;
  }

  /** Publish one event (JSON-encoded) to a channel over signed HTTPS. */
  async publish(channel: string, event: unknown): Promise<void> {
    const credentials = await this.options.getCredentials();
    const body = JSON.stringify({
      channel,
      events: [JSON.stringify(event)],
    });
    const url = new URL(`https://${this.options.httpEndpoint}/event`);
    const headers = signRequest(
      {
        method: "POST",
        url,
        headers: { "content-type": "application/json" },
        body,
      },
      {
        credentials,
        region: this.options.region,
        service: "appsync",
      },
    );
    const response = await fetch(url, { method: "POST", headers, body });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `AppSync publish to ${channel} failed with ${response.status}: ${text}`,
      );
    }
    // Drain so the socket can be reused.
    await response.arrayBuffer().catch(() => undefined);
  }

  /**
   * Subscribe to a channel. The subscription survives reconnects. Returns an
   * unsubscribe function.
   */
  async subscribe(
    channel: string,
    handler: (event: string) => void,
  ): Promise<() => void> {
    const id = `sub-${this.nextSubscriptionId++}`;
    // Connect BEFORE registering: `connect` re-subscribes everything already
    // in the map, so registering first would double-subscribe this id.
    await this.ensureConnected();
    this.subscriptions.set(id, { channel, handler });
    try {
      await this.sendSubscribe(id, channel);
    } catch (error) {
      this.subscriptions.delete(id);
      throw error;
    }
    return () => {
      this.subscriptions.delete(id);
      try {
        this.ws?.send(JSON.stringify({ type: "unsubscribe", id }));
      } catch {
        // connection already gone — nothing to clean up remotely
      }
    };
  }

  /**
   * Ensure the WebSocket is live. Detects zombie connections (e.g. after a
   * Lambda sandbox freeze/thaw) by checking the keepalive recency and forces
   * a reconnect when stale.
   */
  async ensureHealthy(): Promise<void> {
    if (
      this.ws?.readyState === WebSocket.OPEN &&
      Date.now() - this.lastActivity < this.kaTimeoutMs
    ) {
      return;
    }
    this.teardown();
    await this.ensureConnected();
  }

  private ensureConnected(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("AppSyncEventsClient is closed"));
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    this.connecting ??= this.connect().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async connect(): Promise<void> {
    const auth = await this.getAuth({});
    const auth64 = Buffer.from(JSON.stringify(auth), "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const ws = new WebSocket(
      `wss://${this.options.realtimeEndpoint}/event/realtime`,
      ["aws-appsync-event-ws", `header-${auth64}`],
    );
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("AppSync connection timed out"));
        ws.close();
      }, CONNECT_TIMEOUT_MS);
      const fail = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
      ws.addEventListener("error", () =>
        fail(new Error("AppSync connection failed")),
      );
      ws.addEventListener("close", () =>
        fail(new Error("AppSync connection closed during handshake")),
      );
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ type: "connection_init" }));
      });
      ws.addEventListener("message", (event) => {
        const message = this.parse(event.data);
        if (message?.type === "connection_ack") {
          clearTimeout(timer);
          if (typeof message.connectionTimeoutMs === "number") {
            this.kaTimeoutMs = message.connectionTimeoutMs;
          }
          this.lastActivity = Date.now();
          this.armKaTimer();
          resolve();
        }
      });
    });

    ws.addEventListener("message", (event) => {
      const message = this.parse(event.data);
      if (!message) return;
      this.lastActivity = Date.now();
      switch (message.type) {
        case "ka":
          this.armKaTimer();
          break;
        case "subscribe_success": {
          this.acks.get(String(message.id))?.();
          break;
        }
        case "subscribe_error": {
          this.acks.get(String(message.id))?.(
            new Error(
              `AppSync subscription failed: ${JSON.stringify(message.errors ?? message)}`,
            ),
          );
          break;
        }
        case "data": {
          const subscription = this.subscriptions.get(String(message.id));
          if (subscription && typeof message.event === "string") {
            subscription.handler(message.event);
          }
          break;
        }
      }
    });

    const onDrop = () => {
      if (this.ws !== ws) return;
      this.log("connection lost");
      this.scheduleReconnect();
    };
    ws.addEventListener("close", onDrop);
    ws.addEventListener("error", onDrop);

    // Restore subscriptions after a reconnect.
    for (const [id, subscription] of this.subscriptions) {
      await this.sendSubscribe(id, subscription.channel);
    }
  }

  private async sendSubscribe(id: string, channel: string): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("AppSync connection is not open");
    }
    const auth = await this.getAuth({ channel });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.acks.delete(id);
        reject(new Error(`AppSync subscription to ${channel} timed out`));
      }, SUBSCRIBE_TIMEOUT_MS);
      this.acks.set(id, (error) => {
        clearTimeout(timer);
        this.acks.delete(id);
        if (error) reject(error);
        else resolve();
      });
      ws.send(
        JSON.stringify({ type: "subscribe", id, channel, authorization: auth }),
      );
    });
  }

  private armKaTimer() {
    if (this.kaTimer) clearTimeout(this.kaTimer);
    this.kaTimer = setTimeout(() => {
      this.log("keepalive expired");
      this.scheduleReconnect();
    }, this.kaTimeoutMs);
    // Don't hold the process open just for the keepalive watchdog.
    (this.kaTimer as { unref?: () => void }).unref?.();
  }

  private scheduleReconnect() {
    this.teardown();
    if (this.closed) return;
    const attempt = () => {
      if (this.closed) return;
      this.ensureConnected().catch((error) => {
        this.log(`reconnect failed: ${error}`);
        const timer = setTimeout(attempt, RECONNECT_DELAY_MS);
        (timer as { unref?: () => void }).unref?.();
      });
    };
    attempt();
  }

  private teardown() {
    if (this.kaTimer) clearTimeout(this.kaTimer);
    this.kaTimer = undefined;
    const ws = this.ws;
    this.ws = undefined;
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      try {
        ws.close();
      } catch {
        // already closing
      }
    }
  }

  close() {
    this.closed = true;
    this.teardown();
  }

  private parse(data: unknown): Record<string, any> | undefined {
    try {
      if (typeof data === "string") return JSON.parse(data);
      if (data instanceof ArrayBuffer) {
        return JSON.parse(Buffer.from(data).toString("utf8"));
      }
      if (ArrayBuffer.isView(data)) {
        return JSON.parse(
          Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
            "utf8",
          ),
        );
      }
    } catch {
      // non-JSON frame — ignore
    }
    return undefined;
  }
}
