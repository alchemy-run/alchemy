import * as AWS from "@/AWS";
import * as Celld from "@/Celld";
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import {
  INGRESS_DOMAIN,
  IngressCells,
  IngressWorker,
} from "./ingress/fleet.ts";
import IngressWorkerLive from "./ingress/worker.ts";

const testOptions = {
  providers: Layer.mergeAll(
    AWS.providers(),
    Celld.providers(),
    Cloudflare.providers(),
  ),
  stage: process.env.CELLD_CONFORMANCE_STAGE,
};
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "CelldIngress");

let workerUrl = "";
/** The ALB hostname, resolved from the domain's CNAME via DoH. */
let albHost = "";

class DnsNotReady extends Data.TaggedError("DnsNotReady")<{
  hostname: string;
}> {}
class UpstreamNotReady extends Data.TaggedError("UpstreamNotReady")<{
  url: string;
  detail: string;
}> {}

/**
 * DoH against 1.1.1.1 — the system resolver must NOT be asked before the
 * record exists (an early query negative-caches NXDOMAIN for the zone's
 * SOA minimum TTL and poisons every later fetch in the test).
 */
const resolveDoh = (hostname: string, type: "A" | "CNAME") =>
  Effect.tryPromise({
    try: async (signal) => {
      const res = await fetch(
        `https://1.1.1.1/dns-query?name=${hostname}&type=${type}`,
        { headers: { accept: "application/dns-json" }, signal },
      );
      const body = (await res.json()) as {
        Answer?: { type: number; data: string }[];
      };
      if (!body.Answer?.length) throw new Error("no answer");
      return body.Answer;
    },
    catch: () => new DnsNotReady({ hostname }),
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "DnsNotReady",
      schedule: Schedule.spaced("5 seconds"),
      times: 36,
    }),
  );

/** Fetch through warm-up: retry 5xx/404/transport until the body arrives. */
const fetchJson = (url: string, init?: RequestInit) =>
  Effect.tryPromise({
    try: async (signal) => {
      const res = await fetch(url, { ...init, signal });
      const body = await res.text();
      return { status: res.status, body };
    },
    catch: (cause) => new UpstreamNotReady({ url, detail: String(cause) }),
  }).pipe(
    Effect.flatMap((response) =>
      response.status >= 500
        ? Effect.fail(
            new UpstreamNotReady({
              url,
              detail: `upstream ${response.status}`,
            }),
          )
        : Effect.succeed(response),
    ),
    Effect.retry({
      while: (e): boolean => e._tag === "UpstreamNotReady",
      schedule: Schedule.spaced("5 seconds"),
      times: 24,
    }),
  );

// Public ingress + custom domain for a celld fleet worker: an
// internet-facing ALB in front of the node tasks (target group attached to
// the EXISTING node service), an ACM certificate DNS-validated through
// `Cloudflare.Dns()` on the standing test zone, and the domain CNAME
// declared through the same seam. First deploy builds the node image,
// waits out Fargate placement, target health, AND certificate issuance —
// keep it out of FAST.
describe.skipIf(!!process.env.FAST)(
  "celld ingress (public ALB + domain)",
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const { url } = yield* sharedStack.deploy(
          Effect.gen(function* () {
            yield* IngressCells;
            const worker = yield* IngressWorker;
            return { url: worker.url };
          }).pipe(Effect.provide(IngressWorkerLive)),
        );
        expect(url).toBeTruthy();
        workerUrl = String(url).replace(/\/+$/, "");
        yield* Effect.logInfo(`celld ingress url: ${workerUrl}`);
        // Resolve the ALB hostname from the domain's CNAME over DoH — this
        // both anchors the direct-ALB tests and proves the Cloudflare-managed
        // record landed, without ever risking the system resolver's negative
        // cache.
        const answers = yield* resolveDoh(INGRESS_DOMAIN, "CNAME");
        const cname = answers.find((answer) => answer.type === 5)?.data;
        expect(cname).toBeTruthy();
        albHost = (cname ?? "").replace(/\.$/, "");
        yield* Effect.logInfo(`celld ingress alb: ${albHost}`);
      }),
      { timeout: 1_500_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), {
      timeout: 1_800_000,
    });

    test(
      "the worker url is the https domain",
      Effect.sync(() => {
        expect(workerUrl).toBe(`https://${INGRESS_DOMAIN}`);
      }),
    );

    test(
      "the ALB serves the worker's public surface directly",
      Effect.gen(function* () {
        const first = yield* fetchJson(
          `http://${albHost}/kv/ing-seq/increment`,
        );
        expect(first.status).toBe(200);
        const second = yield* fetchJson(
          `http://${albHost}/kv/ing-seq/increment`,
        );
        expect(second.status).toBe(200);
        expect((JSON.parse(second.body) as { value: number }).value).toBe(
          (JSON.parse(first.body) as { value: number }).value + 1,
        );
        const read = yield* fetchJson(`http://${albHost}/kv/ing-seq/get`);
        expect((JSON.parse(read.body) as { value: number }).value).toBe(
          (JSON.parse(second.body) as { value: number }).value,
        );
      }),
      { timeout: 300_000 },
    );

    // ── binding security, DIRECTLY at the public ingress ──────────────────
    test(
      "security: an RPC path without the secret header answers 401",
      Effect.gen(function* () {
        const response = yield* fetchJson(
          `http://${albHost}/Counter/probe/__rpc__/get`,
          { method: "POST", body: "[]" },
        );
        expect(response.status).toBe(401);
      }),
      { timeout: 300_000 },
    );

    test(
      "security: a wrong secret answers 401 with an identical body",
      Effect.gen(function* () {
        const missing = yield* fetchJson(
          `http://${albHost}/Counter/probe/__rpc__/get`,
          { method: "POST", body: "[]" },
        );
        const wrong = yield* fetchJson(
          `http://${albHost}/Counter/probe/__rpc__/get`,
          {
            method: "POST",
            body: "[]",
            headers: { "x-alchemy-fleet-secret": "wrong-secret" },
          },
        );
        expect(missing.status).toBe(401);
        expect(wrong.status).toBe(401);
        expect(wrong.body).toBe(missing.body);
      }),
      { timeout: 300_000 },
    );

    test(
      "security: the public fetch surface serves without any header",
      Effect.gen(function* () {
        const open = yield* fetchJson(`http://${albHost}/kv/ing-public/get`);
        expect(open.status).toBe(200);
        expect(JSON.parse(open.body)).toEqual({ value: 0 });
      }),
      { timeout: 300_000 },
    );

    // ── the Dns seam end to end: https through ACM + Cloudflare DNS ───────
    test(
      "https://{domain} serves through the ACM certificate and Cloudflare DNS",
      Effect.gen(function* () {
        // DoH pre-check before the first system-resolver fetch (see above).
        yield* resolveDoh(INGRESS_DOMAIN, "A");
        const first = yield* fetchJson(`${workerUrl}/kv/ing-tls/increment`);
        expect(first.status).toBe(200);
        const value = (JSON.parse(first.body) as { value: number }).value;
        expect(value).toBeGreaterThan(0);
      }),
      { timeout: 300_000 },
    );
  },
);
