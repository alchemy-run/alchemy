/**
 * DEPTH chain 2 — upstream replacement propagation through InvokeFunction
 * (live, doppler alchemy-v2/dev env).
 *
 * Two chains, each ≥3 full deploy cycles asserting BOTH what changed and
 * what stayed stable:
 *
 * 1. One-way: async-mode `ChainUpstreamA` (declared inline so its `name`
 *    prop can vary) ← `invoke({ LogicalId })` ← Effect-mode `ChainCallerB`.
 *    Cycle 1 greenfield + round trip; cycle 2 identical redeploy (all ids
 *    stable, skip-on-hash); cycle 3 renames A — an explicit `name` change
 *    is a project REPLACEMENT — while B stays deployed, asserting B's
 *    bound URL/BYPASS env re-resolved to the successor, B redeployed in
 *    place (same project), B reaches A's successor over HTTP, and A's old
 *    project is gone.
 *
 * 2. Circular: `ChainEchoA` ↔ `ChainEchoB` (fresh logical ids mirroring
 *    the Functions suite's invoke pair). Cycle 3 renames B — a replacement
 *    INSIDE the cycle, exercising the pre-create story under replacement:
 *    the successor B's project (URL + bypass secret) must exist before
 *    either side's redeploy binds it.
 *
 * Engine-deadlock rule respected: every replacement keeps the dependent's
 * binding deployed — nothing removes a dependency in the same deploy that
 * replaces its target.
 */
import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as projects from "@distilled.cloud/vercel/projects";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { MinimumLogLevel } from "effect/References";
import ChainCallerB from "./fixtures/caller-b.ts";
import ChainEchoA from "./fixtures/chain-a.ts";
import ChainEchoB, { chainBName } from "./fixtures/chain-b.ts";

const { test } = Test.make({ providers: Vercel.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const upstreamMain = new URL("./fixtures/upstream-a.ts", import.meta.url)
  .pathname;

/** Deterministic successor names (constants — never `Date.now()`). */
const RENAMED_A = "alch-chain-invrepl-upstream-two";
const RENAMED_B = "alch-chain-invrepl-echo-b-two";

// Fresh .vercel.app URLs take a few seconds to start serving 200s — always
// retry the first request (bounded: `times` is the hard cap).
const readiness = Schedule.min([
  Schedule.exponential("500 millis"),
  Schedule.spaced("2 seconds"),
]);

const getJson = (url: string) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.get(url);
    const body = yield* response.text;
    if (response.status !== 200) {
      return yield* Effect.fail(
        new Error(`status ${response.status}: ${body.slice(0, 300)}`),
      );
    }
    // Fresh production aliases can transiently serve a 200 HTML edge
    // placeholder before the deployment is routed — treat an unparseable
    // body as retryable, not a crash.
    return yield* Effect.try({
      try: () => JSON.parse(body) as unknown,
      catch: () =>
        new Error(`status 200 but non-JSON body: ${body.slice(0, 300)}`),
    });
  }).pipe(Effect.retry({ schedule: readiness, times: 40 }));

/** Poll (bounded) until a project is gone; asserts it. */
const expectProjectGone = (projectId: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* Vercel.VercelEnvironment.current;
    const gone = yield* projects
      .getProject({ idOrName: projectId, teamId })
      .pipe(
        Effect.map(() => false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (g) => g,
          times: 10,
        }),
      );
    expect(gone).toBe(true);
  });

const bypassValue = (attrs: {
  protectionBypass: Redacted.Redacted<string> | undefined;
}) => {
  expect(attrs.protectionBypass).toBeDefined();
  return Redacted.value(attrs.protectionBypass!);
};

interface CallerResponse {
  fn: string;
  targetUrl: string;
  hasBypass: boolean;
  target: { fn: string; echo: string };
}

interface CircularResponse {
  fn: string;
  targetUrl: string;
  target: { fn: string; echo: string };
}

test.provider(
  "one-way: renaming upstream A replaces its project and repoints B's invoke env",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const makeStack = (nameA?: string) =>
        Effect.gen(function* () {
          const a = yield* Vercel.Function("ChainUpstreamA", {
            main: upstreamMain,
            ...(nameA !== undefined ? { name: nameA } : {}),
          });
          const b = yield* ChainCallerB;
          return { a, b };
        });

      // ── Cycle 1: greenfield (engine-generated name for A). ──────────────
      const c1 = yield* stack.deploy(makeStack());
      expect(c1.a.url).toMatch(/^https:\/\/.+\.vercel\.app$/);
      expect(c1.b.url).toMatch(/^https:\/\/.+\.vercel\.app$/);
      expect(c1.a.projectId).not.toEqual(c1.b.projectId);
      const r1 = (yield* getJson(`${c1.b.url}/call-a`)) as CallerResponse;
      expect(r1.fn).toEqual("caller-b");
      expect(r1.targetUrl).toEqual(c1.a.url);
      expect(r1.hasBypass).toBe(true);
      expect(r1.target.fn).toEqual("upstream-a");
      expect(r1.target.echo).toContain("from=caller-b");

      // ── Cycle 2: identical redeploy — EVERYTHING stable (skip-on-hash
      //    across the whole bound pair). ─────────────────────────────────
      const c2 = yield* stack.deploy(makeStack());
      expect(c2.a.projectId).toEqual(c1.a.projectId);
      expect(c2.a.deploymentId).toEqual(c1.a.deploymentId);
      expect(c2.a.url).toEqual(c1.a.url);
      expect(c2.b.projectId).toEqual(c1.b.projectId);
      expect(c2.b.deploymentId).toEqual(c1.b.deploymentId);
      expect(c2.b.url).toEqual(c1.b.url);
      expect(bypassValue(c2.b)).toEqual(bypassValue(c1.b));

      // ── Cycle 3: explicit name ⇒ project REPLACEMENT of A; B stays
      //    deployed (its invoke binding is never removed). ───────────────
      const c3 = yield* stack.deploy(makeStack(RENAMED_A));
      // Changed: A is a new project under the explicit name, new URL, new
      // bypass secret (minted at successor-project ensure).
      expect(c3.a.projectId).not.toEqual(c1.a.projectId);
      expect(c3.a.projectName).toEqual(RENAMED_A);
      expect(c3.a.url).not.toEqual(c1.a.url);
      expect(bypassValue(c3.a)).not.toEqual(bypassValue(c1.a));
      // Stable: B keeps its project/URL — but was REDEPLOYED (the successor
      // URL/bypass flowed into B's env, and env only takes effect on new
      // deployments).
      expect(c3.b.projectId).toEqual(c1.b.projectId);
      expect(c3.b.url).toEqual(c1.b.url);
      expect(c3.b.deploymentId).not.toEqual(c2.b.deploymentId);
      expect(bypassValue(c3.b)).toEqual(bypassValue(c1.b));
      // Create-first replacement: the predecessor project is gone AFTER the
      // successor deploy (typed wait-until-gone).
      yield* expectProjectGone(c1.a.projectId);
      // Out-of-band via distilled: the successor exists under the explicit
      // name.
      const { teamId } = yield* Vercel.VercelEnvironment.current;
      const successor = yield* projects.getProject({
        idOrName: c3.a.projectId,
        teamId,
      });
      expect(successor.name).toEqual(RENAMED_A);
      // B reaches A's successor through its re-bound env. B's production
      // alias may briefly serve the previous deployment — poll (bounded)
      // until the fresh env is live.
      const r3 = (yield* getJson(`${c3.b.url}/call-a`).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (r) => (r as CallerResponse).targetUrl === c3.a.url,
          times: 20,
        }),
      )) as CallerResponse;
      expect(r3.targetUrl).toEqual(c3.a.url);
      expect(r3.hasBypass).toBe(true);
      expect(r3.target.fn).toEqual("upstream-a");
      expect(r3.target.echo).toContain("from=caller-b");

      // ── Teardown: census-clean. ──────────────────────────────────────
      yield* stack.destroy();
      yield* expectProjectGone(c3.a.projectId);
      yield* expectProjectGone(c3.b.projectId);
    }).pipe(logLevel),
  { timeout: 240_000 },
);

test.provider(
  "circular: renaming B replaces one side of the A<->B invoke cycle in place",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      chainBName.current = undefined;

      const program = Effect.gen(function* () {
        const a = yield* ChainEchoA;
        const b = yield* ChainEchoB;
        return { a, b };
      });

      // ── Cycle 1: greenfield circular pair; both directions round-trip. ─
      const c1 = yield* stack.deploy(program);
      expect(c1.a.url).toMatch(/^https:\/\/.+\.vercel\.app$/);
      expect(c1.b.url).toMatch(/^https:\/\/.+\.vercel\.app$/);
      expect(c1.a.projectId).not.toEqual(c1.b.projectId);
      const viaA1 = (yield* getJson(`${c1.a.url}/call-b`)) as CircularResponse;
      expect(viaA1.fn).toEqual("a");
      expect(viaA1.targetUrl).toEqual(c1.b.url);
      expect(viaA1.target.fn).toEqual("b");
      const viaB1 = (yield* getJson(`${c1.b.url}/call-a`)) as CircularResponse;
      expect(viaB1.fn).toEqual("b");
      expect(viaB1.targetUrl).toEqual(c1.a.url);
      expect(viaB1.target.fn).toEqual("a");

      // ── Cycle 2: identical redeploy — both sides fully stable. ────────
      const c2 = yield* stack.deploy(program);
      expect(c2.a.projectId).toEqual(c1.a.projectId);
      expect(c2.a.deploymentId).toEqual(c1.a.deploymentId);
      expect(c2.b.projectId).toEqual(c1.b.projectId);
      expect(c2.b.deploymentId).toEqual(c1.b.deploymentId);

      // ── Cycle 3: rename B ⇒ replacement INSIDE the cycle. The successor
      //    B project must be pre-created (URL + bypass minted) before
      //    either side deploys against it. A's binding stays deployed
      //    throughout (deadlock rule). ────────────────────────────────────
      chainBName.current = RENAMED_B;
      const c3 = yield* stack.deploy(program);
      // Changed: B is a new project; A was redeployed with B's successor
      // env.
      expect(c3.b.projectId).not.toEqual(c1.b.projectId);
      expect(c3.b.projectName).toEqual(RENAMED_B);
      expect(c3.b.url).not.toEqual(c1.b.url);
      expect(c3.a.deploymentId).not.toEqual(c2.a.deploymentId);
      // Stable: A's project identity and URL survive its partner's
      // replacement.
      expect(c3.a.projectId).toEqual(c1.a.projectId);
      expect(c3.a.url).toEqual(c1.a.url);
      expect(bypassValue(c3.a)).toEqual(bypassValue(c1.a));
      // Predecessor B project is gone.
      yield* expectProjectGone(c1.b.projectId);
      // Both directions round-trip against the successor. A's production
      // alias may briefly serve its previous deployment — poll until the
      // re-bound target URL is live.
      const viaA3 = (yield* getJson(`${c3.a.url}/call-b`).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (r) => (r as CircularResponse).targetUrl === c3.b.url,
          times: 20,
        }),
      )) as CircularResponse;
      expect(viaA3.targetUrl).toEqual(c3.b.url);
      expect(viaA3.target.fn).toEqual("b");
      const viaB3 = (yield* getJson(`${c3.b.url}/call-a`)) as CircularResponse;
      expect(viaB3.targetUrl).toEqual(c3.a.url);
      expect(viaB3.target.fn).toEqual("a");

      // ── Teardown: census-clean. ──────────────────────────────────────
      yield* stack.destroy();
      chainBName.current = undefined;
      yield* expectProjectGone(c3.a.projectId);
      yield* expectProjectGone(c3.b.projectId);
    }).pipe(logLevel),
  { timeout: 240_000 },
);
