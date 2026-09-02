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
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import {
  INGRESS_DOMAIN,
  IngressCells,
  IngressWorker,
} from "./fixtures/ingress/fleet.ts";
import IngressWorkerLive from "./fixtures/ingress/worker.ts";

const testOptions = {
  providers: Layer.mergeAll(
    AWS.providers(),
    Celld.providers(),
    Celld.Ecs(),
    Cloudflare.providers(),
  ),
};
const { test, beforeAll, afterAll } = Test.make(testOptions);
// File-backed scratch state: the leading `destroy()` below really drains
// whatever a previous (interrupted or NO_DESTROY) run left behind.
const sharedStack = Core.scratchStack(
  testOptions,
  "CelldIngress",
  import.meta.url,
);

let workerUrl = "";
/** The ALB hostname, resolved from the domain's CNAME via DoH. */
let albHost = "";

class DnsNotReady extends Data.TaggedError("DnsNotReady")<{
  hostname: string;
  message: string;
}> {}
class UpstreamNotReady extends Data.TaggedError("UpstreamNotReady")<{
  url: string;
  detail: string;
  message: string;
}> {}

const dnsNotReady = (hostname: string, detail: string) =>
  new DnsNotReady({ hostname, message: `${hostname}: ${detail}` });
const notReady = (url: string, detail: string) =>
  new UpstreamNotReady({ url, detail, message: `${url}: ${detail}` });

/** Render a client failure WITH its underlying cause (transport errors hide it). */
const describeCause = (cause: unknown) =>
  cause instanceof Error && cause.cause !== undefined
    ? `${cause.message} <- ${String(cause.cause)}`
    : String(cause);

/**
 * DoH against 1.1.1.1 — the system resolver must NOT be asked before the
 * record exists (an early query negative-caches NXDOMAIN for the zone's
 * SOA minimum TTL and poisons every later fetch in the test).
 */
const resolveDoh = (hostname: string, type: "A" | "CNAME") =>
  HttpClient.get(`https://1.1.1.1/dns-query?name=${hostname}&type=${type}`, {
    headers: { accept: "application/dns-json" },
  }).pipe(
    Effect.flatMap((response) => response.json),
    Effect.map(
      (body) =>
        (body as { Answer?: { type: number; data: string }[] }).Answer ?? [],
    ),
    Effect.mapError((cause) => dnsNotReady(hostname, String(cause))),
    Effect.flatMap((answers) =>
      answers.length > 0
        ? Effect.succeed(answers)
        : Effect.fail(dnsNotReady(hostname, `no ${type} answer yet`)),
    ),
    Effect.retry({
      while: (e): boolean => e._tag === "DnsNotReady",
      schedule: Schedule.spaced("5 seconds"),
      times: 36,
    }),
  );

/** Fetch through warm-up: retry 5xx/transport until the body arrives. */
const fetchText = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.text.pipe(
        Effect.map((body) => ({ status: response.status, body })),
      ),
    ),
    Effect.mapError((cause) => notReady(request.url, describeCause(cause))),
    Effect.flatMap((response) =>
      response.status >= 500
        ? Effect.fail(notReady(request.url, `upstream ${response.status}`))
        : Effect.succeed(response),
    ),
    Effect.retry({
      while: (e): boolean => e._tag === "UpstreamNotReady",
      // Generous: a prior run's CNAME may sit in the resolver cache for up
      // to its 300s TTL, pointing at a torn-down ALB.
      schedule: Schedule.spaced("5 seconds"),
      times: 72,
    }),
  );

const fetchJson = (url: string) => fetchText(HttpClientRequest.get(url));

const rpcProbe = (url: string, secret?: string) =>
  fetchText(
    HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyText("[]", "application/json"),
      secret === undefined
        ? (request) => request
        : HttpClientRequest.setHeader("x-alchemy-fleet-secret", secret),
    ),
  );

/** A fetch client that surfaces redirects instead of following them. */
const manualRedirects = FetchHttpClient.layer.pipe(
  Layer.provide(
    Layer.succeed(FetchHttpClient.RequestInit, { redirect: "manual" }),
  ),
);

/**
 * Probe a redirecting URL: reads ONLY the status and `location` header (a
 * 301 carries no body worth decoding), retrying transport errors and 5xx
 * while the ALB's listener comes up.
 */
const probeRedirect = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.map((response) => ({
      status: response.status,
      location: response.headers.location,
    })),
    Effect.mapError((cause) => notReady(url, describeCause(cause))),
    Effect.flatMap((response) =>
      response.status >= 500
        ? Effect.fail(notReady(url, `upstream ${response.status}`))
        : Effect.succeed(response),
    ),
    Effect.retry({
      while: (e): boolean => e._tag === "UpstreamNotReady",
      schedule: Schedule.spaced("5 seconds"),
      times: 24,
    }),
    Effect.provide(manualRedirects),
  );

// Public ingress + custom domain for a celld fleet worker: an
// internet-facing ALB in front of the node tasks (target group attached to
// the EXISTING node service), an ACM certificate DNS-validated through
// `Cloudflare.CloudflareDns()` on the standing test zone, and the domain
// CNAME declared through the same seam. Gated like an entitlement: set
// ALCHEMY_TEST_FLEETS=1 to run it (first deploy builds the node image and
// waits out Fargate placement, target health AND certificate issuance).
describe.skipIf(!process.env.ALCHEMY_TEST_FLEETS || !!process.env.FAST)(
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
        // DoH A pre-check before the first system-resolver fetch of the
        // domain (see above) — every test below may then use `workerUrl`.
        yield* resolveDoh(INGRESS_DOMAIN, "A");
      }),
      // Image build + Fargate placement + ALB target health + ACM DNS
      // validation (issuance alone can take 10+ minutes).
      { timeout: 1_500_000 },
    );

    // Destroy must ride out Lambda-style hyperplane ENI teardown and the
    // ALB's deregistration delay (5-20 min before the VPC's subnets/SGs
    // release).
    afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), {
      timeout: 1_800_000,
    });

    test(
      "the worker url is the https domain",
      Effect.sync(() => {
        expect(workerUrl).toBe(`https://${INGRESS_DOMAIN}`);
      }),
    );

    // With a domain, plaintext never reaches the fleet: the ALB's HTTP
    // listener is a permanent redirect to HTTPS.
    test(
      "http://{albHost} redirects to https when a domain is set",
      Effect.gen(function* () {
        const response = yield* probeRedirect(
          `http://${albHost}/kv/ing-redirect/get`,
        );
        expect([301, 308]).toContain(response.status);
        expect(response.location).toMatch(/^https:\/\//);
      }),
      { timeout: 600_000 },
    );

    // The ALB's HTTP listener redirects with a domain (above), and its
    // certificate is the domain's — so the ingress is driven through the
    // domain URL, which the DoH pre-check in `beforeAll` made safe to
    // resolve.
    test(
      "the ALB serves the worker's public surface directly",
      Effect.gen(function* () {
        const first = yield* fetchJson(`${workerUrl}/kv/ing-seq/increment`);
        expect(first.status).toBe(200);
        const second = yield* fetchJson(`${workerUrl}/kv/ing-seq/increment`);
        expect(second.status).toBe(200);
        expect((JSON.parse(second.body) as { value: number }).value).toBe(
          (JSON.parse(first.body) as { value: number }).value + 1,
        );
        const read = yield* fetchJson(`${workerUrl}/kv/ing-seq/get`);
        expect((JSON.parse(read.body) as { value: number }).value).toBe(
          (JSON.parse(second.body) as { value: number }).value,
        );
      }),
      { timeout: 600_000 },
    );

    // ── binding security, DIRECTLY at the public ingress ──────────────────
    test(
      "security: an RPC path without the secret header answers 401",
      Effect.gen(function* () {
        const response = yield* rpcProbe(
          `${workerUrl}/Counter/probe/__rpc__/get`,
        );
        expect(response.status).toBe(401);
      }),
      { timeout: 600_000 },
    );

    test(
      "security: a wrong secret answers 401 with an identical body",
      Effect.gen(function* () {
        const missing = yield* rpcProbe(
          `${workerUrl}/Counter/probe/__rpc__/get`,
        );
        const wrong = yield* rpcProbe(
          `${workerUrl}/Counter/probe/__rpc__/get`,
          "wrong-secret",
        );
        expect(missing.status).toBe(401);
        expect(wrong.status).toBe(401);
        expect(wrong.body).toBe(missing.body);
      }),
      { timeout: 600_000 },
    );

    test(
      "security: the public fetch surface serves without any header",
      Effect.gen(function* () {
        const open = yield* fetchJson(`${workerUrl}/kv/ing-public/get`);
        expect(open.status).toBe(200);
        expect(JSON.parse(open.body)).toEqual({ value: 0 });
      }),
      { timeout: 600_000 },
    );

    // ── the Dns seam end to end: https through ACM + Cloudflare DNS ───────
    test(
      "https://{domain} serves through the ACM certificate and Cloudflare DNS",
      Effect.gen(function* () {
        const first = yield* fetchJson(`${workerUrl}/kv/ing-tls/increment`);
        expect(first.status).toBe(200);
        const value = (JSON.parse(first.body) as { value: number }).value;
        expect(value).toBeGreaterThan(0);
      }),
      { timeout: 600_000 },
    );
  },
);
