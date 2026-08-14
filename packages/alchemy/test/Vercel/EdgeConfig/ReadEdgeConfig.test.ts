/**
 * EdgeConfigRead capability tests — live against the standing Vercel test
 * team (run with the doppler alchemy-v2/dev env).
 *
 * Covers: the Effect-mode fixture binding an Edge Config via
 * `Vercel.ReadEdgeConfig` + `ReadEdgeConfigHttp` (get / getAll / has /
 * digest driven over HTTP via the production alias), the auto-minted
 * `EdgeConfigToken` (observe-and-keep — redeploy stability), the sensitive
 * connection-string env row, and the async-mode path (explicit
 * `EdgeConfigToken` + `env:` binding + `readEdgeConfigFromEnv`).
 */
import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as globalConfig from "@distilled.cloud/vercel/global_config";
import * as projects from "@distilled.cloud/vercel/projects";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import EdgeConfigFn from "./fixtures/edge-config-fn.ts";
import { FIXTURE_ITEMS, Flags } from "./fixtures/flags.ts";

const { test } = Test.make({ providers: Vercel.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const asyncFixtureMain = new URL(
  "./fixtures/async-edge-config-fn.ts",
  import.meta.url,
).pathname;

// Fresh .vercel.app URLs take a few seconds to start serving 200s — always
// retry the first request (bounded).
const readiness = Schedule.max([
  Schedule.exponential("500 millis"),
  Schedule.recurs(20),
]);

const getJson = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.json
        : Effect.fail(new Error(`status ${response.status}`)),
    ),
    Effect.retry({ schedule: readiness }),
  );

/**
 * Data-plane reads are eventually consistent after item writes — poll a
 * JSON route (bounded) until the body matches.
 */
const getJsonUntil = <A>(url: string, until: (body: A) => boolean) =>
  getJson(url).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (body) => until(body as A),
      times: 15,
    }),
    Effect.map((body) => body as A),
  );

/** Poll (bounded) until the function's project is gone. */
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

/** Poll (bounded) until the Edge Config is gone (cascades its tokens). */
const expectEdgeConfigGone = (edgeConfigId: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* Vercel.VercelEnvironment.current;
    const gone = yield* globalConfig
      .getEdgeConfig({ edgeConfigId, teamId })
      .pipe(
        Effect.as(false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (g) => g,
          times: 8,
        }),
      );
    expect(gone).toBe(true);
  });

test.provider(
  "effect mode: ReadEdgeConfig binding mints a token, injects a sensitive env row, and serves reads",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { teamId } = yield* Vercel.VercelEnvironment.current;

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const fn = yield* EdgeConfigFn;
          const flags = yield* Flags;
          return { fn, flags };
        }),
      );
      expect(out.fn.url).toBeDefined();
      expect(out.flags.edgeConfigId).toMatch(/^ecfg_/);

      // 1. get — declared items round-trip through the deployed client
      //    (data plane is eventually consistent; bounded poll).
      const greeting = yield* getJsonUntil<{ value: unknown }>(
        `${out.fn.url}/item/greeting`,
        (body) => body.value === FIXTURE_ITEMS.greeting,
      );
      expect(greeting.value).toEqual(FIXTURE_ITEMS.greeting);

      // 2. get on a missing key is undefined (the 404+digest contract) —
      //    NOT an error.
      const missing = (yield* getJson(`${out.fn.url}/item/nope`)) as {
        value: unknown;
      };
      expect(missing.value).toBeNull();

      // 3. has — present and missing keys.
      const hasIt = (yield* getJson(`${out.fn.url}/has/enableCheckout`)) as {
        has: boolean;
      };
      expect(hasIt.has).toBe(true);
      const hasNot = (yield* getJson(`${out.fn.url}/has/nope`)) as {
        has: boolean;
      };
      expect(hasNot.has).toBe(false);

      // 4. getAll — full item set, and a subset.
      const all = yield* getJsonUntil<{ items: Record<string, unknown> }>(
        `${out.fn.url}/all`,
        (body) => Object.keys(body.items ?? {}).length === 3,
      );
      expect(all.items).toEqual(FIXTURE_ITEMS);
      const some = (yield* getJson(`${out.fn.url}/some`)) as {
        items: Record<string, unknown>;
      };
      expect(some.items).toEqual({
        greeting: FIXTURE_ITEMS.greeting,
        enableCheckout: FIXTURE_ITEMS.enableCheckout,
      });

      // 5. digest — the data plane converges on the management digest.
      const digest = yield* getJsonUntil<{ digest: string }>(
        `${out.fn.url}/digest`,
        (body) => body.digest === out.flags.digest,
      );
      expect(digest.digest).toEqual(out.flags.digest);

      // 6. The connection string landed as a SENSITIVE project env row
      //    (key = sanitized `<token logical id>.connectionString` capture).
      const envs = yield* projects.filterProjectEnvs({
        idOrName: out.fn.projectId,
        teamId,
        decrypt: "true",
      });
      const rows = (
        Array.isArray(envs)
          ? envs
          : typeof envs === "object" && envs !== null && "envs" in envs
            ? envs.envs
            : []
      ) as Array<{ key: string; type: string }>;
      const row = rows.find(
        (r) => r.key === "EdgeConfigFnFlagsReadToken_connectionString",
      );
      expect(row).toBeDefined();
      expect(row!.type).toEqual("sensitive");

      // 7. Exactly one read token was minted for the config (out-of-band
      //    via distilled — pins the getEdgeConfigTokens array patch too).
      const tokens = yield* globalConfig.getEdgeConfigTokens({
        edgeConfigId: out.flags.edgeConfigId,
        teamId,
      });
      expect(tokens.length).toEqual(1);
      expect(tokens[0]!.edgeConfigId).toEqual(out.flags.edgeConfigId);

      // 8. Churn regression: an identical redeploy re-observes (never
      //    re-mints) the token, so the env fingerprint — and therefore the
      //    deployment — must not change.
      const redeployed = yield* stack.deploy(
        Effect.gen(function* () {
          const fn = yield* EdgeConfigFn;
          const flags = yield* Flags;
          return { fn, flags };
        }),
      );
      expect(redeployed.fn.deploymentId).toEqual(out.fn.deploymentId);
      const tokensAfter = yield* globalConfig.getEdgeConfigTokens({
        edgeConfigId: out.flags.edgeConfigId,
        teamId,
      });
      expect(tokensAfter.length).toEqual(1);
      expect(tokensAfter[0]!.id).toEqual(tokens[0]!.id);

      // 9. Destroy cascades the project, the config, and its token.
      yield* stack.destroy();
      yield* expectEdgeConfigGone(out.flags.edgeConfigId);
      yield* expectProjectGone(out.fn.projectId);
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "async mode: explicit EdgeConfigToken env binding + readEdgeConfigFromEnv client",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = Effect.gen(function* () {
        const flags = yield* Vercel.EdgeConfig("AsyncFlags", {
          items: { greeting: "async-hello", limit: 7 },
        });
        const token = yield* Vercel.EdgeConfigToken("AsyncFlagsToken", {
          edgeConfigId: flags.edgeConfigId,
        });
        const fn = yield* Vercel.Function("AsyncEdgeFn", {
          main: asyncFixtureMain,
          env: {
            // Redacted attribute Output ⇒ synced as a sensitive env var.
            FLAGS: token.connectionString,
          },
        });
        return { flags, token, fn };
      });

      const out = yield* stack.deploy(program);
      expect(out.fn.url).toBeDefined();
      expect(out.token.tokenId).toBeDefined();
      expect(Redacted.value(out.token.connectionString)).toEqual(
        `https://edge-config.vercel.com/${out.flags.edgeConfigId}?token=${Redacted.value(out.token.token)}`,
      );

      // 1. The env var arrived as the RAW connection string (async channel
      //    has no marker packing).
      const env = yield* getJsonUntil<{ present: boolean; isUrl: boolean }>(
        `${out.fn.url}/env`,
        (body) => body.present,
      );
      expect(env.isUrl).toBe(true);

      // 2. Reads through the promise client (bounded eventual-consistency
      //    poll).
      const greeting = yield* getJsonUntil<{ value: unknown }>(
        `${out.fn.url}/item/greeting`,
        (body) => body.value === "async-hello",
      );
      expect(greeting.value).toEqual("async-hello");
      const has = (yield* getJson(`${out.fn.url}/has/limit`)) as {
        has: boolean;
      };
      expect(has.has).toBe(true);
      const all = yield* getJsonUntil<{ items: Record<string, unknown> }>(
        `${out.fn.url}/all`,
        (body) => Object.keys(body.items ?? {}).length === 2,
      );
      expect(all.items).toEqual({ greeting: "async-hello", limit: 7 });

      // 3. Churn regression: identical redeploy keeps the token AND the
      //    deployment (observe-and-keep — no env fingerprint drift).
      const redeployed = yield* stack.deploy(program);
      expect(redeployed.token.tokenId).toEqual(out.token.tokenId);
      expect(Redacted.value(redeployed.token.token)).toEqual(
        Redacted.value(out.token.token),
      );
      expect(redeployed.fn.deploymentId).toEqual(out.fn.deploymentId);

      // 4. Deleting the stack removes the token, config, and project.
      // Destroy removes the token, config, and project. The standalone
      // token row deletes cleanly even when the config cascade removed it
      // first (idempotent NotFound catch) — destroy() fails otherwise.
      yield* stack.destroy();
      yield* expectEdgeConfigGone(out.flags.edgeConfigId);
      yield* expectProjectGone(out.fn.projectId);
    }).pipe(logLevel),
  { timeout: 180_000 },
);
