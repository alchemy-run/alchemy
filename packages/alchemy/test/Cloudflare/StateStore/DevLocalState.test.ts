import { AlchemyContext } from "@/AlchemyContext.ts";
import { AuthProviders } from "@/Auth/AuthProvider.ts";
import * as Cloudflare from "@/Cloudflare";
import {
  DEV_LOCAL_STATE_ID,
  makeDevLocalState,
  resolveStateStoreMode,
} from "@/Cloudflare/StateStore/State.ts";
import { State, type StateService } from "@/State/State.ts";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { ArtifactStore, createArtifactStore } from "@/Artifacts.ts";
import { LoggingCli } from "@/Cli/LoggingCli.ts";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

/**
 * Unit coverage for the dev-mode branch of `Cloudflare.state()`:
 *
 * - `alchemy dev` (`AlchemyContext.dev === true`) ALWAYS resolves to the
 *   machine-local file store — deterministically, never dependent on whether
 *   Cloudflare credentials happen to exist. The whole environment below is
 *   scrubbed (empty AuthProviders registry, a profile name that cannot have
 *   stored credentials, CI so nothing can prompt), so any credential demand
 *   would fail loudly instead of silently authenticating with the machine's
 *   real profile.
 * - non-dev keeps the cloud init path: the layer still BUILDS lazily without
 *   credentials, and first use dies on credential resolution in the scrubbed
 *   environment (the seam right before any cloud/bootstrap work).
 */

/** Deterministic scratch namespace — cleaned up by each test. */
const STACK = "CfDevLocalStateUnit";

const sampleState = (fqn: string, instanceId: string) => ({
  kind: "resource" as const,
  resourceType: "Test.Resource",
  namespace: undefined,
  fqn,
  logicalId: fqn.split("/").pop()!,
  instanceId,
  providerVersion: 1,
  status: "created" as const,
  downstream: [],
  bindings: [],
  props: { hello: "world" },
  attr: { id: instanceId },
});

/**
 * Fully scrubbed environment: an empty AuthProviders registry (the
 * `CloudflareAuth` layer inside `Cloudflare.state()` registers into it), a
 * profile that cannot exist in `~/.alchemy`, and `CI` so `loadOrConfigure`
 * bails instead of prompting. Any code path that demands Cloudflare
 * credentials fails in this environment.
 */
const scrubbedEnv = (dev: boolean) =>
  Layer.mergeAll(
    Layer.succeed(AuthProviders, {}),
    Layer.succeed(AlchemyContext, {
      dev,
      adopt: false,
      dotAlchemy: ".alchemy",
    }),
    Layer.succeed(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({
        ALCHEMY_PROFILE: "cf-dev-local-state-unit-nonexistent-profile",
        CI: "true",
      }),
    ),
    NodeServices.layer,
    FetchHttpClient.layer,
  );

const stateLayer = (dev: boolean) =>
  Cloudflare.state().pipe(
    Layer.provide(scrubbedEnv(dev)),
    // The state layer's type also carries the cloud branch's renderer and
    // artifact requirements; satisfy them so the tests stay self-contained.
    Layer.provide(
      Layer.mergeAll(
        LoggingCli,
        Layer.succeed(ArtifactStore, createArtifactStore()),
      ),
    ),
  );

const roundtrip = (store: StateService) =>
  Effect.gen(function* () {
    const stage = "unit";
    const fqn = "stack/scope/resource-a";
    yield* store.deleteStack({ stack: STACK });
    const echoed = yield* store.set({
      stack: STACK,
      stage,
      fqn,
      value: sampleState(fqn, "inst-a"),
    });
    expect(echoed.instanceId).toBe("inst-a");
    const got = yield* store.get({ stack: STACK, stage, fqn });
    expect(got?.fqn).toBe(fqn);
    expect((got as any).props).toEqual({ hello: "world" });
    const fqns = yield* store.list({ stack: STACK, stage });
    expect([...fqns]).toEqual([fqn]);
    yield* store.deleteStack({ stack: STACK });
  });

describe("Cloudflare.state() dev-local branch", () => {
  it("resolveStateStoreMode is deterministic on the run mode", () => {
    expect(resolveStateStoreMode({ dev: true })).toBe("dev-local");
    expect(resolveStateStoreMode({ dev: false })).toBe("cloud");
    // No AlchemyContext at all (bare library use) keeps the cloud store.
    expect(resolveStateStoreMode(undefined)).toBe("cloud");
  });

  it.live("makeDevLocalState needs only FileSystem + Path", () =>
    Effect.gen(function* () {
      const store = yield* makeDevLocalState;
      expect(store.id).toBe(DEV_LOCAL_STATE_ID);
      yield* roundtrip(store);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "dev: true resolves Cloudflare.state() to the local file store without credentials",
    () =>
      Effect.gen(function* () {
        const store = yield* yield* State;
        expect(store.id).toBe(DEV_LOCAL_STATE_ID);

        // Proof the rows land on the local disk (same layout as
        // Alchemy.localState()) before the roundtrip cleans up after itself.
        const fqn = "stack/scope/on-disk";
        yield* store.set({
          stack: STACK,
          stage: "disk",
          fqn,
          value: sampleState(fqn, "inst-disk"),
        });
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = path.join(process.cwd(), ".alchemy", "state", STACK);
        expect(yield* fs.exists(dir)).toBe(true);

        yield* roundtrip(store);
      }).pipe(
        Effect.provide(Layer.mergeAll(stateLayer(true), NodeServices.layer)),
      ),
  );

  it.live(
    "dev: false keeps the cloud init path (builds lazily, demands credentials on first use)",
    () =>
      Effect.gen(function* () {
        // Layer BUILD must succeed without credentials — the cloud init is
        // deferred to first use.
        const init = yield* State;
        // First use walks the cloud path: in the scrubbed environment the
        // credential force fails (AuthError -> orDie) BEFORE any bootstrap
        // work. A dev-local store here would be a branch-selection bug.
        const exit = yield* Effect.exit(init);
        if (Exit.isSuccess(exit)) {
          expect(exit.value.id).not.toBe(DEV_LOCAL_STATE_ID);
          throw new Error(
            `expected the scrubbed cloud init to fail, got store '${exit.value.id}'`,
          );
        }
        expect(Exit.isFailure(exit)).toBe(true);
      }).pipe(Effect.provide(stateLayer(false))),
    { timeout: 30_000 },
  );
});
