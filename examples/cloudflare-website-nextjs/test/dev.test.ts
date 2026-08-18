/**
 * The DEV leg of the Next MaxSite example (Serve/DESIGN.md test doctrine):
 * the same stack under `Test.make({ dev: true })`. Next's default dev mode
 * is "preview" — the OpenNext takeover artifact (with the route-file mount
 * compiled inside it) served under local workerd with production parity —
 * so every platform surface the live leg proves is driven here against the
 * local runtime: the effect API through the mount, DO (monotonic +
 * streaming RPC), Workflow to completion, queue produce→consume, and the
 * request-scope finalizer (inline settle — the mount passes no ctx — but
 * observable the same way). No /healthz or gate tests: a route-file mount
 * only sees /api/*.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
  stage: "dev-test",
  dev: true,
});

const { getWhenReady } = Test;

// The first dev boot runs the full Next.js + OpenNext build before workerd
// serves — give the hook the same headroom as a live deploy.
const stack = beforeAll(deploy(Stack), { timeout: 600_000 });
afterAll(
  Effect.gen(function* () {
    if (!process.env.NO_DESTROY) {
      yield* destroy(Stack);
    }
  }),
);

test(
  "dev url is local (no cloud deploy) and the effect API serves through the mount",
  Effect.gen(function* () {
    const { url } = yield* stack;
    if (typeof url !== "string") throw new Error("no url output");
    expect(url).toStartWith("http://localhost");
    const base = url.replace(/\/+$/, "");
    // The mount's own 404 for an unclaimed effect path — the route-file
    // mount answered (empty body), not Next's HTML error page.
    const res = yield* getWhenReady(`${base}/api/kv?key=absent`);
    expect(res.status).toBe(200);
    const body = (yield* res.json) as { value: string | null };
    expect(body.value).toBeNull();
  }),
  { timeout: 600_000 },
);

test(
  "dev: durable object round-trip (monotonic) and streaming RPC",
  Effect.gen(function* () {
    const { url } = yield* stack;
    if (typeof url !== "string") throw new Error("no url output");
    const base = url.replace(/\/+$/, "");
    const name = `dev-${crypto.randomUUID().slice(0, 8)}`;

    const first = yield* getWhenReady(`${base}/api/do/increment?name=${name}`);
    const a = ((yield* first.json) as { next: number }).next;
    const second = yield* getWhenReady(`${base}/api/do/increment?name=${name}`);
    const b = ((yield* second.json) as { next: number }).next;
    expect(b).toBe(a + 1);

    // Full stream assertion (Next preview dev is all-workerd; the proxy
    // stream channel covers the Node-side worlds).
    const ticks = yield* getWhenReady(`${base}/api/do/ticks?n=3`);
    expect(ticks.status).toBe(200);
    expect(yield* ticks.text).toBe("0\n1\n2\n");
  }),
  { timeout: 120_000 },
);

test(
  "dev: request-scope finalizer lands (inline settle without a ctx)",
  Effect.gen(function* () {
    const { url } = yield* stack;
    if (typeof url !== "string") throw new Error("no url output");
    const base = url.replace(/\/+$/, "");
    const marker = `fin-${crypto.randomUUID().slice(0, 8)}`;

    const res = yield* getWhenReady(`${base}/api/finalizer?v=${marker}`);
    expect(res.status).toBe(200);

    const client = yield* HttpClient.HttpClient;
    const value = yield* Effect.gen(function* () {
      const kv = yield* client.get(`${base}/api/kv?key=finalizer-last`);
      return ((yield* kv.json) as { value: string | null }).value;
    }).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (value) => value === marker,
        times: 20,
      }),
    );
    expect(value).toBe(marker);
  }),
  { timeout: 120_000 },
);

test(
  "dev: queue produce → local broker → consumer on the same class",
  Effect.gen(function* () {
    const { url } = yield* stack;
    if (typeof url !== "string") throw new Error("no url output");
    const base = url.replace(/\/+$/, "");
    const marker = `q-${crypto.randomUUID().slice(0, 8)}`;

    const sent = yield* getWhenReady(`${base}/api/enqueue?m=${marker}`);
    expect(sent.status).toBe(200);

    const client = yield* HttpClient.HttpClient;
    const last = yield* Effect.gen(function* () {
      const kv = yield* client.get(`${base}/api/kv?key=processed-last`);
      return ((yield* kv.json) as { value: string | null }).value;
    }).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (value) => value === marker,
        times: 30,
      }),
    );
    expect(last).toBe(marker);
  }),
  { timeout: 120_000 },
);

test(
  "dev: workflow runs durable steps to completion locally",
  Effect.gen(function* () {
    const { url } = yield* stack;
    if (typeof url !== "string") throw new Error("no url output");
    const base = url.replace(/\/+$/, "");
    const marker = `wf-${crypto.randomUUID().slice(0, 8)}`;

    const started = yield* getWhenReady(
      `${base}/api/workflow/start?marker=${marker}`,
    );
    const { id } = (yield* started.json) as { id: string };

    const client = yield* HttpClient.HttpClient;
    const status = yield* Effect.gen(function* () {
      const res = yield* client.get(`${base}/api/workflow/status?id=${id}`);
      return (yield* res.json) as { status: string } | null;
    }).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (s) => s?.status === "complete" || s?.status === "errored",
        times: 30,
      }),
    );
    expect(status?.status).toBe("complete");

    const kv = yield* client.get(`${base}/api/kv?key=workflow-last`);
    const { value } = (yield* kv.json) as { value: string | null };
    expect(value).toBe(`report:${marker}`);
  }),
  { timeout: 180_000 },
);

test(
  "dev: the framework SSR page serves through the same worker",
  Effect.gen(function* () {
    const { url } = yield* stack;
    if (typeof url !== "string") throw new Error("no url output");
    const base = url.replace(/\/+$/, "");
    const client = yield* HttpClient.HttpClient;
    const html = yield* Effect.gen(function* () {
      const res = yield* client.get(base);
      const body = yield* res.text;
      if (res.status !== 200 || !body.includes("Server-rendered visits:")) {
        return yield* Effect.fail(new Error(`not ready: ${res.status}`));
      }
      return body;
    }).pipe(
      Effect.retry({
        schedule: Schedule.max([
          Schedule.spaced("2 seconds"),
          Schedule.recurs(60),
        ]),
      }),
    );
    expect(html).toContain("Server-rendered visits:");
  }),
  { timeout: 240_000 },
);
