/**
 * EdgeConfigWrite capability tests — live against the standing Vercel test
 * team (run with the doppler alchemy-v2/dev env).
 *
 * Two halves:
 *
 * 1. UNGATED platform probe — pins the live facts that make WriteEdgeConfig
 *    an explicit opt-in (probe 2026-08): `createAuthToken` mints real
 *    `scope: "project-only"` tokens, but Edge Configs are team-owned, so a
 *    project-scoped token cannot read them (typed `NotFound`), cannot write
 *    them (typed `NotFound`), and cannot mint read tokens (typed
 *    `Forbidden`). If this probe ever flips (Vercel ships a scoped write
 *    credential), revisit `WriteEdgeConfigHttp` to mint least-privilege
 *    tokens instead of requiring a user-supplied one.
 *
 * 2. GATED end-to-end fixture (`VERCEL_TEST_EDGE_CONFIG_WRITE=1`) — deploys
 *    a Function that binds `WriteEdgeConfig` with a user-supplied
 *    management token and drives set/delete over HTTP, verifying items
 *    out-of-band through the management API.
 */
import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as authentication from "@distilled.cloud/vercel/authentication";
import { credentials } from "@distilled.cloud/vercel/Credentials";
import * as globalConfig from "@distilled.cloud/vercel/global_config";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import WriteEdgeConfigFn, {
  WriteFlags,
} from "./fixtures/write-edge-config-fn.ts";

const { test } = Test.make({ providers: Vercel.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Fresh .vercel.app URLs take a few seconds to start serving 200s.
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

/** Read the config's items out-of-band as a plain record (management API). */
const fetchItems = (edgeConfigId: string, teamId: string | undefined) =>
  globalConfig
    .getEdgeConfigItems({ edgeConfigId, teamId })
    .pipe(
      Effect.map((items) =>
        Object.fromEntries(items.map((item) => [item.key, item.value])),
      ),
    );

test.provider(
  "platform probe: project-scoped tokens cannot touch team-owned Edge Configs (why writes are opt-in)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { teamId } = yield* Vercel.VercelEnvironment.current;

      // A probe project to scope the token to, and a team-owned config the
      // scoped token will be tested against — both stack-owned.
      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Vercel.Project("ScopedTokenProbe", {});
          const config = yield* Vercel.EdgeConfig("ScopedProbeConfig", {
            items: { probe: "v1" },
          });
          return { project, config };
        }),
      );

      // Mint a project-scoped, expiring token — this WORKS: real scoping
      // exists on the token-creation API.
      const minted = yield* authentication.createAuthToken({
        name: "alchemy-test-ec-write-probe",
        projectId: out.project.projectId,
        expiresAt: Date.now() + 15 * 60 * 1000,
      });
      const dropToken = authentication
        .deleteAuthToken({ tokenId: minted.token.id })
        .pipe(Effect.ignore);

      yield* Effect.gen(function* () {
        expect((minted.token as { scope?: string }).scope).toEqual(
          "project-only",
        );

        const scopedLayer = Layer.merge(
          credentials({ token: minted.bearerToken }),
          FetchHttpClient.layer,
        );

        // The scoped token cannot even SEE the team-owned config…
        const readTag = yield* globalConfig
          .getEdgeConfig({ edgeConfigId: out.config.edgeConfigId, teamId })
          .pipe(
            Effect.as("ok" as const),
            Effect.catchTag("NotFound", () =>
              Effect.succeed("NotFound" as const),
            ),
            Effect.provide(scopedLayer),
          );
        expect(readTag).toEqual("NotFound");

        // …cannot WRITE it…
        const writeTag = yield* globalConfig
          .patchEdgeConfigItems({
            edgeConfigId: out.config.edgeConfigId,
            teamId,
            items: [{ operation: "upsert", key: "probe", value: "scoped" }],
          })
          .pipe(
            Effect.as("ok" as const),
            Effect.catchTag("NotFound", () =>
              Effect.succeed("NotFound" as const),
            ),
            Effect.catchTag("Forbidden", () =>
              Effect.succeed("Forbidden" as const),
            ),
            Effect.provide(scopedLayer),
          );
        expect(writeTag).toEqual("NotFound");

        // …and cannot mint data-plane read tokens for it either.
        const mintTag = yield* globalConfig
          .createEdgeConfigToken({
            edgeConfigId: out.config.edgeConfigId,
            teamId,
            label: "alchemy-test-ec-write-probe",
          })
          .pipe(
            Effect.as("ok" as const),
            Effect.catchTag("NotFound", () =>
              Effect.succeed("NotFound" as const),
            ),
            Effect.catchTag("Forbidden", () =>
              Effect.succeed("Forbidden" as const),
            ),
            Effect.provide(scopedLayer),
          );
        expect(mintTag).toEqual("Forbidden");

        // The write it was denied did not land.
        const items = yield* fetchItems(out.config.edgeConfigId, teamId);
        expect(items).toEqual({ probe: "v1" });
      }).pipe(Effect.ensuring(dropToken));

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!process.env.VERCEL_TEST_EDGE_CONFIG_WRITE)(
  "effect mode: WriteEdgeConfig opt-in binds a user-supplied token and writes converge",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { teamId } = yield* Vercel.VercelEnvironment.current;

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const fn = yield* WriteEdgeConfigFn;
          const flags = yield* WriteFlags;
          return { fn, flags };
        }),
      );
      expect(out.fn.url).toBeDefined();
      expect(out.flags.edgeConfigId).toMatch(/^ecfg_/);

      // Runtime upsert through the deployed binding; management-API
      // readback is strongly consistent, so no data-plane wait is needed.
      const set = (yield* getJson(
        `${out.fn.url}/set?key=banner&value=hello`,
      )) as { ok: boolean };
      expect(set.ok).toBe(true);
      const afterSet = yield* fetchItems(out.flags.edgeConfigId, teamId);
      expect(afterSet).toEqual({ seeded: "v1", banner: "hello" });

      // Batched patch: upsert one key, delete another.
      const patched = (yield* getJson(
        `${out.fn.url}/patch?key=mode&value=on&drop=banner`,
      )) as { ok: boolean };
      expect(patched.ok).toBe(true);
      const afterPatch = yield* fetchItems(out.flags.edgeConfigId, teamId);
      expect(afterPatch).toEqual({ seeded: "v1", mode: "on" });

      // Runtime delete.
      const del = (yield* getJson(`${out.fn.url}/delete?key=mode`)) as {
        ok: boolean;
      };
      expect(del.ok).toBe(true);
      const afterDelete = yield* fetchItems(out.flags.edgeConfigId, teamId);
      expect(afterDelete).toEqual({ seeded: "v1" });

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);
