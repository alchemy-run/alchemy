/**
 * Vercel Edge Config dev-mode (`alchemy dev`) tests — the registry-style
 * local providers per the Local-tests doctrine: `dev: true` runs local
 * providers behind the RPC sidecar proxy by default, matching the process
 * topology of the real `alchemy dev` command.
 *
 * Covers (a) the local roundtrip through a locally running Function binding
 * `ReadEdgeConfig` (Effect mode) plus the async channel
 * (`readEdgeConfigFromEnv` over an explicit local `EdgeConfigToken`), with
 * `dev:` identity markers; (b) the RAW data-plane protocol against the
 * sidecar endpoint — the exact contract probed against
 * `@vercel/edge-config@1.5.1` (missing item = 404 WITH the
 * `x-edge-config-digest` header, bare 404 = config-not-found, bearer auth,
 * 401 on a bad token); (c) registry live-sync — an items-only redeploy is
 * served immediately without restarting the consuming Function; and (d)
 * the mixed stack: an `Alchemy.remote()` Edge Config runs LIVE during dev
 * (real `ecfg_` id, real token minted by the delegating local provider)
 * alongside a fully local sibling, verified out-of-band via distilled and
 * gone after destroy.
 */
import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as globalConfig from "@distilled.cloud/vercel/global_config";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import LocalEdgeFn from "./fixtures/local-edge-config-fn.ts";
import { LOCAL_FIXTURE_ITEMS, LocalFlags } from "./fixtures/local-flags.ts";
import MixedEdgeFn, {
  MIXED_LIVE_ITEMS,
  MIXED_LOCAL_ITEMS,
  MixedLiveFlags,
  MixedLocalFlags,
} from "./fixtures/mixed-edge-config-fn.ts";

const { test } = Test.make({
  providers: Vercel.providers(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const asyncFixtureMain = new URL(
  "./fixtures/async-edge-config-fn.ts",
  import.meta.url,
).pathname;

class NotReady extends Data.TaggedError("NotReady")<{ status: number }> {}

// The first request races the dev bundle's first build — retry, bounded.
const readiness = Schedule.max([
  Schedule.min([
    Schedule.exponential("500 millis"),
    Schedule.spaced("2 seconds"),
  ]),
  Schedule.recurs(45),
]);

const getJsonReady = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new NotReady({ status: res.status })),
      ),
      Effect.retry({
        while: (e): e is NotReady => e instanceof NotReady,
        schedule: readiness,
      }),
    );
    return yield* res.json;
  }).pipe(Effect.orDie);

/** Poll a JSON route (bounded) until the body matches. */
const getJsonUntil = <A>(url: string, until: (body: A) => boolean) =>
  getJsonReady(url).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (body) => until(body as A),
      times: 20,
    }),
    Effect.map((body) => body as A),
  );

/** A raw data-plane request with bearer auth (the SDK's request shape). */
const raw = (
  url: string,
  options?: { token?: string; method?: "GET" | "HEAD" },
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    let request = HttpClientRequest.make(options?.method ?? "GET")(url).pipe(
      HttpClientRequest.appendUrlParam("version", "1"),
    );
    if (options?.token !== undefined) {
      request = HttpClientRequest.bearerToken(request, options.token);
    }
    const response = yield* client.execute(request);
    const body = yield* response.text;
    return {
      status: response.status,
      digestHeader: response.headers["x-edge-config-digest"],
      body,
    };
  });

test.provider(
  "local roundtrip: dev markers, effect + async clients, raw protocol, live item sync",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (items: Record<string, unknown>) =>
        stack.deploy(
          Effect.gen(function* () {
            const fn = yield* LocalEdgeFn;
            const flags = yield* LocalFlags;
            // A standalone config + explicit token: drives the raw
            // protocol probes and the async-channel Function, and its
            // varying `items` pin registry live-sync across deploys.
            const standalone = yield* Vercel.EdgeConfig("StandaloneFlags", {
              items,
            });
            const token = yield* Vercel.EdgeConfigToken(
              "StandaloneFlagsToken",
              { edgeConfigId: standalone.edgeConfigId },
            );
            const asyncFn = yield* Vercel.Function("AsyncLocalEdgeFn", {
              main: asyncFixtureMain,
              env: { FLAGS: token.connectionString },
            });
            return { fn, flags, standalone, token, asyncFn };
          }),
        );

      const first = yield* deploy({ greeting: "standalone-hello", n: 1 });

      // ── dev identity markers — proof no cloud call ran.
      expect(first.flags.edgeConfigId).toMatch(/^dev:ecfg_/);
      expect(first.flags.ownerId).toBe("dev");
      expect(first.standalone.edgeConfigId).toMatch(/^dev:ecfg_/);
      expect(first.token.tokenId).toMatch(/^dev:/);
      expect(Redacted.value(first.token.token)).toMatch(/^dev:ectok_/);
      expect(first.fn.url).toMatch(/^http:\/\/localhost:\d+$/);
      expect(first.asyncFn.projectId).toMatch(/^dev:/);
      const connection = Redacted.value(first.token.connectionString);
      expect(connection).toMatch(/^http:\/\/localhost:\d+\/dev:ecfg_/);

      // ── Effect client through the locally running Function.
      const greeting = (yield* getJsonReady(
        `${first.fn.url}/item/greeting`,
      )) as { value: unknown };
      expect(greeting.value).toEqual(LOCAL_FIXTURE_ITEMS.greeting);
      const missing = (yield* getJsonReady(`${first.fn.url}/item/nope`)) as {
        value: unknown;
      };
      expect(missing.value).toBeNull();
      const hasIt = (yield* getJsonReady(
        `${first.fn.url}/has/enableCheckout`,
      )) as { has: boolean };
      expect(hasIt.has).toBe(true);
      const hasNot = (yield* getJsonReady(`${first.fn.url}/has/nope`)) as {
        has: boolean;
      };
      expect(hasNot.has).toBe(false);
      const all = (yield* getJsonReady(`${first.fn.url}/all`)) as {
        items: Record<string, unknown>;
      };
      expect(all.items).toEqual(LOCAL_FIXTURE_ITEMS);
      const some = (yield* getJsonReady(`${first.fn.url}/some`)) as {
        items: Record<string, unknown>;
      };
      expect(some.items).toEqual({
        greeting: LOCAL_FIXTURE_ITEMS.greeting,
        enableCheckout: LOCAL_FIXTURE_ITEMS.enableCheckout,
      });
      const digest = (yield* getJsonReady(`${first.fn.url}/digest`)) as {
        digest: string;
      };
      expect(digest.digest).toEqual(first.flags.digest);

      // ── Async channel: `readEdgeConfigFromEnv` (plain fetch, the SDK's
      // protocol semantics) against the explicit local token.
      const asyncGreeting = (yield* getJsonReady(
        `${first.asyncFn.url}/item/greeting`,
      )) as { value: unknown };
      expect(asyncGreeting.value).toEqual("standalone-hello");
      const asyncAll = (yield* getJsonReady(`${first.asyncFn.url}/all`)) as {
        items: Record<string, unknown>;
      };
      expect(asyncAll.items).toEqual({ greeting: "standalone-hello", n: 1 });
      const asyncDigest = (yield* getJsonReady(
        `${first.asyncFn.url}/digest`,
      )) as { digest: string };
      expect(asyncDigest.digest).toEqual(first.standalone.digest);

      // ── RAW protocol against the sidecar data plane (the probe-verified
      // `@vercel/edge-config` contract).
      const { baseUrl, token } =
        Vercel.parseEdgeConfigConnectionString(connection);
      const origin = new URL(baseUrl).origin;

      // Present item: 200 + digest header.
      const present = yield* raw(`${baseUrl}/item/greeting`, { token });
      expect(present.status).toBe(200);
      expect(JSON.parse(present.body)).toEqual("standalone-hello");
      expect(present.digestHeader).toEqual(first.standalone.digest);

      // Missing ITEM: 404 *with* the digest header (SDK ⇒ undefined).
      const missingItem = yield* raw(`${baseUrl}/item/nope`, { token });
      expect(missingItem.status).toBe(404);
      expect(missingItem.digestHeader).toEqual(first.standalone.digest);

      // HEAD: 200 for present, 404 + digest for missing.
      const headPresent = yield* raw(`${baseUrl}/item/greeting`, {
        token,
        method: "HEAD",
      });
      expect(headPresent.status).toBe(200);
      const headMissing = yield* raw(`${baseUrl}/item/nope`, {
        token,
        method: "HEAD",
      });
      expect(headMissing.status).toBe(404);
      expect(headMissing.digestHeader).toEqual(first.standalone.digest);

      // Item subset + digest endpoints.
      const subset = yield* raw(`${baseUrl}/items?key=greeting`, { token });
      expect(subset.status).toBe(200);
      expect(JSON.parse(subset.body)).toEqual({
        greeting: "standalone-hello",
      });
      const digestRaw = yield* raw(`${baseUrl}/digest`, { token });
      expect(digestRaw.status).toBe(200);
      expect(JSON.parse(digestRaw.body)).toEqual(first.standalone.digest);

      // Bad token: 401. Unknown config: BARE 404 (no digest header) — the
      // SDK's "config not found" throw signal.
      const badToken = yield* raw(`${baseUrl}/item/greeting`, {
        token: "dev:ectok_wrong",
      });
      expect(badToken.status).toBe(401);
      const unknownConfig = yield* raw(
        `${origin}/dev:ecfg_does-not-exist/item/greeting`,
        { token },
      );
      expect(unknownConfig.status).toBe(404);
      expect(unknownConfig.digestHeader).toBeUndefined();

      // ── Registry live-sync: an items-only redeploy converges the served
      // data WITHOUT re-minting the token or restarting the Functions.
      const second = yield* deploy({ greeting: "standalone-bonjour", n: 2 });
      expect(second.standalone.edgeConfigId).toEqual(
        first.standalone.edgeConfigId,
      );
      expect(second.standalone.digest).not.toEqual(first.standalone.digest);
      expect(Redacted.value(second.token.token)).toEqual(
        Redacted.value(first.token.token),
      );
      // Same connection string ⇒ unchanged env ⇒ the async Function did
      // not restart (its dev deployment id is the config hash).
      expect(second.asyncFn.deploymentId).toEqual(first.asyncFn.deploymentId);
      expect(second.asyncFn.url).toEqual(first.asyncFn.url);
      const updated = yield* raw(`${baseUrl}/item/greeting`, { token });
      expect(JSON.parse(updated.body)).toEqual("standalone-bonjour");
      const updatedThroughFn = yield* getJsonUntil<{ value: unknown }>(
        `${second.asyncFn.url}/item/greeting`,
        (body) => body.value === "standalone-bonjour",
      );
      expect(updatedThroughFn.value).toEqual("standalone-bonjour");

      yield* stack.destroy();

      // The registry row is gone: the data plane now answers a bare 404.
      const afterDestroy = yield* raw(`${baseUrl}/item/greeting`, { token });
      expect(afterDestroy.status).toBe(404);
      expect(afterDestroy.digestHeader).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 240_000 },
);

test.provider(
  "Alchemy.remote() Edge Config runs live in dev alongside a local one",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { teamId } = yield* Vercel.VercelEnvironment.current;

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const fn = yield* MixedEdgeFn;
          const localFlags = yield* MixedLocalFlags;
          const liveFlags = yield* MixedLiveFlags;
          return { fn, localFlags, liveFlags };
        }),
      );

      // The default config is emulated; the remote() one is real — and the
      // Function itself runs locally.
      expect(deployed.localFlags.edgeConfigId).toMatch(/^dev:ecfg_/);
      expect(deployed.liveFlags.edgeConfigId).toMatch(/^ecfg_/);
      expect(deployed.fn.url).toMatch(/^http:\/\/localhost:\d+$/);
      expect(deployed.fn.projectId).toMatch(/^dev:/);

      // Both bindings round-trip through the SAME locally running Function.
      const local = (yield* getJsonReady(
        `${deployed.fn.url}/local/item/source`,
      )) as { value: unknown };
      expect(local.value).toEqual(MIXED_LOCAL_ITEMS.source);
      // The live data plane is eventually consistent after item writes.
      const live = yield* getJsonUntil<{ value: unknown }>(
        `${deployed.fn.url}/live/item/source`,
        (body) => body.value === MIXED_LIVE_ITEMS.source,
      );
      expect(live.value).toEqual(MIXED_LIVE_ITEMS.source);

      // Out-of-band via distilled: the remote() config exists on real
      // Vercel with the declared items, and the delegating local token
      // provider minted exactly one REAL read token for it.
      const items = yield* globalConfig.getEdgeConfigItems({
        edgeConfigId: deployed.liveFlags.edgeConfigId,
        teamId,
      });
      expect(
        Object.fromEntries(items.map((item) => [item.key, item.value])),
      ).toEqual(MIXED_LIVE_ITEMS);
      const tokens = yield* globalConfig.getEdgeConfigTokens({
        edgeConfigId: deployed.liveFlags.edgeConfigId,
        teamId,
      });
      expect(tokens.length).toEqual(1);

      yield* stack.destroy();

      // The live config was deleted from the cloud on destroy (its state
      // row is stamped live, so the live provider handles the delete even
      // in a dev run — and the delegated token delete rode the cascade).
      const gone = yield* globalConfig
        .getEdgeConfig({
          edgeConfigId: deployed.liveFlags.edgeConfigId,
          teamId,
        })
        .pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (g) => g,
            times: 10,
          }),
        );
      expect(gone).toBe(true);
    }).pipe(logLevel),
  { timeout: 240_000 },
);
