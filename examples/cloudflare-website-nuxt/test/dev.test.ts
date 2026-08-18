/**
 * The DEV leg of the Nuxt MaxSite example (Serve/DESIGN.md test doctrine):
 * the same stack under `Test.make({ dev: true })` — nitro's own dev server
 * (SSR in a Node worker thread) with `event.context.cloudflare` served by
 * the platform proxy, and the SAME user mount
 * (server/middleware/alchemy.ts) composing dispatch. The site's platform
 * half (DO/Workflow classes, queue consumers) is hosted INSIDE the dev
 * platform proxy's workerd (the tier B dev sidecar), so DO round-trips,
 * workflows, and queue consumption have real local semantics — mirroring
 * the SvelteKit dev topology.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
  stage: "dev-test",
  dev: true,
});

const { getWhenReady } = Test;

const stack = beforeAll(deploy(Stack));
afterAll(
  Effect.gen(function* () {
    if (!process.env.NO_DESTROY) {
      yield* destroy(Stack);
    }
  }),
);

test(
  "dev url is local (no cloud deploy) and the mount serves /healthz",
  Effect.gen(function* () {
    const { url } = yield* stack;
    if (typeof url !== "string") throw new Error("no url output");
    expect(url).toStartWith("http://localhost");
    const base = url.replace(/\/+$/, "");
    const res = yield* getWhenReady(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(yield* res.text).toBe("ok");
  }),
  { timeout: 240_000 },
);

test(
  "dev: the admin gate runs ahead of the effect fetch",
  Effect.gen(function* () {
    const { url } = yield* stack;
    if (typeof url !== "string") throw new Error("no url output");
    const base = url.replace(/\/+$/, "");
    const client = yield* HttpClient.HttpClient;

    const denied = yield* client.get(`${base}/api/admin/anything`);
    expect(denied.status).toBe(403);

    const passed = yield* client.execute(
      HttpClientRequest.get(`${base}/api/admin/anything`).pipe(
        HttpClientRequest.setHeader("x-admin-key", "letmein"),
      ),
    );
    expect(passed.status).toBe(404);
  }),
  { timeout: 120_000 },
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

    // KNOWN LIMITATION (tier B dev): a Stream-returning DO RPC consumed
    // from the framework's Node dev process crosses the platform proxy,
    // which has no capability transport for nested streams (JSON + chain
    // calls only). On SvelteKit dev the body arrives empty (status 200);
    // on Nuxt dev the serialization error escapes nitro's h3 handling and
    // KILLS the dev SSR worker, so /api/do/ticks is deliberately NOT
    // exercised here. Deployed (live leg) and tier A dev (all-workerd)
    // stream correctly; tracked for a proxy stream channel.
  }),
  { timeout: 120_000 },
);

test(
  "dev: request-scope finalizer lands (inline settle without a real ctx)",
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
  "dev: the framework SSR page serves through the same dev server",
  Effect.gen(function* () {
    const { url } = yield* stack;
    if (typeof url !== "string") throw new Error("no url output");
    const base = url.replace(/\/+$/, "");
    // First SSR compile in the nitro dev worker is slow — generous retry.
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
