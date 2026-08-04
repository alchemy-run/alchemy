/**
 * The credential-demand seam for credential-free `alchemy dev`
 * (`src/Auth/Demand.ts`):
 *
 *   - `collectCredentialDemands` scans a plan for rows that need live
 *     credentials during a dev run: `remote()` rows, truthy `devRemote`
 *     binding entries, and deletions of rows stamped `providerMode: "live"`.
 *   - `demandCredentials` demands them exactly once, up front: no-op when
 *     already configured, the provider's `configure` flow (with a reason
 *     naming the demanding resources) when interactive, and the typed
 *     `CredentialsRequired` failure when non-interactive.
 *   - End-to-end: a fully-local dev deploy never touches credentials; a
 *     dev plan with a `remote()` row in a non-interactive process fails
 *     with `CredentialsRequired` BEFORE apply begins.
 */
import {
  AuthProviderLayer,
  AuthProviders,
  type ConfigureContext,
} from "@/Auth/AuthProvider.ts";
import {
  collectCredentialDemands,
  CredentialsRequired,
  credentialsRequired,
  demandCredentials,
} from "@/Auth/Demand.ts";
import {
  AlchemyProfile,
  CONFIG_VERSION,
  type AlchemyProfileProviders,
  type ProfileService,
} from "@/Auth/Profile.ts";
import * as Alchemy from "@/index.ts";
import { remote } from "@/ProviderMode.ts";
import { InMemoryService, State, type ResourceState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { describe, expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { v4 as uuidv4 } from "uuid";
import {
  BindingTarget,
  Bucket,
  inDev,
  ModalResource,
  TestLayers,
} from "../test.resources.ts";

// ── plan-scan detector ──────────────────────────────────────────────────────

const { test } = Test.make({ providers: TestLayers() });

describe("collectCredentialDemands", () => {
  test.provider("an all-local dev plan demands nothing", (stack) =>
    Effect.gen(function* () {
      const plan = yield* inDev(
        Effect.gen(function* () {
          yield* ModalResource("A", { value: "v1" });
          return {};
        }).pipe(stack.plan),
      );
      expect(plan.resources["A"].mode).toEqual("local");
      expect(collectCredentialDemands(plan)).toEqual([]);
    }),
  );

  test.provider(
    "a mode-agnostic (single-implementation) resource demands nothing",
    (stack) =>
      Effect.gen(function* () {
        // Mode-agnostic providers run live even in dev, but they resolve
        // credentials lazily exactly as they do today — the demand seam
        // deliberately leaves them alone (mode === undefined).
        const plan = yield* inDev(
          Effect.gen(function* () {
            yield* Bucket("B", {});
            return {};
          }).pipe(stack.plan),
        );
        expect(plan.resources["B"].mode).toBeUndefined();
        expect(collectCredentialDemands(plan)).toEqual([]);
      }),
  );

  test.provider("a remote() row in a dev plan demands its cloud", (stack) =>
    Effect.gen(function* () {
      const plan = yield* inDev(
        Effect.gen(function* () {
          yield* ModalResource("A", { value: "v1" }).pipe(remote());
          return {};
        }).pipe(stack.plan),
      );
      expect(collectCredentialDemands(plan)).toEqual([
        {
          provider: "Test",
          resources: [{ fqn: "A", reason: "remote" }],
        },
      ]);
    }),
  );

  test.provider(
    "a truthy devRemote binding entry demands; a falsy one does not",
    (stack) =>
      Effect.gen(function* () {
        const planFor = (devRemote: Record<string, boolean>) =>
          inDev(
            Effect.gen(function* () {
              const host = yield* BindingTarget("Host", {});
              yield* host.bind("Remote", {
                env: {},
                devRemote,
              } as any);
              return {};
            }).pipe(stack.plan),
          );

        const demanding = yield* planFor({ FOO: true });
        expect(collectCredentialDemands(demanding)).toEqual([
          {
            provider: "Test",
            resources: [{ fqn: "Host", reason: "remote-binding" }],
          },
        ]);

        const notDemanding = yield* planFor({ FOO: false });
        expect(collectCredentialDemands(notDemanding)).toEqual([]);
      }),
  );

  test.provider(
    "deleting a live-stamped row during a dev run demands; a local-stamped one does not",
    (stack) =>
      Effect.gen(function* () {
        // 1. deploy live (run default), then plan its removal in dev: the
        //    delete resolves the LIVE provider (the mode that created the
        //    row), so it needs credentials.
        yield* Effect.gen(function* () {
          yield* ModalResource("A", { value: "v1" });
          return {};
        }).pipe(stack.deploy);

        const liveDelete = yield* inDev(stack.plan(Effect.succeed({})));
        expect(collectCredentialDemands(liveDelete)).toEqual([
          {
            provider: "Test",
            resources: [{ fqn: "A", reason: "live-delete" }],
          },
        ]);

        // 2. flip the row to local (dev deploy), then plan its removal in
        //    dev: a local delete needs no credentials.
        yield* inDev(
          Effect.gen(function* () {
            yield* ModalResource("A", { value: "v1" });
            return {};
          }).pipe(stack.deploy),
        );
        const localDelete = yield* inDev(stack.plan(Effect.succeed({})));
        expect(collectCredentialDemands(localDelete)).toEqual([]);

        yield* stack.destroy();
      }),
  );
});

// ── CredentialsRequired formatting ──────────────────────────────────────────

it.live("CredentialsRequired names the resources and the fix", () =>
  Effect.sync(() => {
    const error = credentialsRequired(
      {
        provider: "Cloudflare",
        resources: [
          { fqn: "MyStack/Queue", reason: "remote" },
          { fqn: "MyStack/Worker", reason: "remote-binding" },
          { fqn: "MyStack/Old", reason: "live-delete" },
        ],
      },
      "default",
    );
    expect(error).toBeInstanceOf(CredentialsRequired);
    expect(error.provider).toEqual("Cloudflare");
    expect(error.resources).toEqual([
      "MyStack/Queue",
      "MyStack/Worker",
      "MyStack/Old",
    ]);
    expect(error.reason).toEqual("remote, remote-binding, live-delete");
    expect(error.message).toContain("Cloudflare credentials are required");
    expect(error.message).toContain("profile 'default'");
    expect(error.message).toContain("non-interactive");
    expect(error.message).toContain(
      "MyStack/Queue (runs against the real cloud via Alchemy.remote())",
    );
    expect(error.message).toContain(
      "MyStack/Worker (has a binding that proxies to a remote resource (dev: { remote: true }))",
    );
    expect(error.message).toContain(
      "MyStack/Old (deletes an instance that was deployed to the real cloud)",
    );
    expect(error.message).toContain("alchemy login --profile default");
  }),
);

// ── demandCredentials ───────────────────────────────────────────────────────

const FAKE_PROVIDER = "Test";

/** In-memory ProfileService — never touches ~/.alchemy. */
const inMemoryProfileLayer = (
  initial: Record<string, AlchemyProfileProviders> = {},
) => {
  const profiles: Record<string, AlchemyProfileProviders> = { ...initial };
  const service: ProfileService = {
    readConfig: Effect.sync(() => ({ version: CONFIG_VERSION, profiles })),
    writeConfig: () => Effect.void,
    getProfile: (name) => Effect.sync(() => profiles[name]),
    setProfile: (name, profile) =>
      Effect.sync(() => {
        profiles[name] = profile;
      }),
    deleteProfile: (name) =>
      Effect.sync(() => {
        if (!(name in profiles)) return false;
        delete profiles[name];
        return true;
      }),
    // Mirrors the real loadOrConfigure: stored config wins; otherwise the
    // provider's configure flow runs and the result is persisted.
    loadOrConfigure: (auth, profileName, ctx) =>
      Effect.suspend(() => {
        const stored = profiles[profileName]?.[auth.name];
        if (stored) return Effect.succeed(stored as any);
        return auth.configure(profileName, ctx).pipe(
          Effect.tap((config) =>
            Effect.sync(() => {
              profiles[profileName] = {
                ...profiles[profileName],
                [auth.name]: config as any,
              };
            }),
          ),
        );
      }),
  };
  return Layer.succeed(AlchemyProfile, service);
};

/** Proves the seam never consults the credential store. */
const untouchableProfileLayer = Layer.succeed(AlchemyProfile, {
  readConfig: Effect.die("credential store touched"),
  writeConfig: () => Effect.die("credential store touched"),
  getProfile: () => Effect.die("credential store touched"),
  setProfile: () => Effect.die("credential store touched"),
  deleteProfile: () => Effect.die("credential store touched"),
  loadOrConfigure: () => Effect.die("configure flow entered"),
} as ProfileService);

const makeFakeAuth = () => {
  const record = {
    configureCalls: 0,
    contexts: [] as ConfigureContext[],
  };
  const layer = AuthProviderLayer<{ method: string }, undefined>()(
    FAKE_PROVIDER,
    {
      configure: (_profileName: string, ctx: ConfigureContext) =>
        Effect.sync(() => {
          record.configureCalls += 1;
          record.contexts.push(ctx);
          return { method: "fake" };
        }),
      login: () => Effect.void,
      logout: () => Effect.void,
      prettyPrint: () => Effect.void,
      read: () => Effect.succeed(undefined),
    },
  );
  return { record, layer };
};

const demandEnv = (
  profileLayer: Layer.Layer<AlchemyProfile>,
  authLayer: Layer.Layer<never, never, AuthProviders>,
  config: Record<string, string> = {},
) =>
  Layer.mergeAll(profileLayer, authLayer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(AuthProviders, {}),
        ConfigProvider.layer(ConfigProvider.fromUnknown(config)),
      ),
    ),
  );

const remoteDemand = {
  provider: FAKE_PROVIDER,
  resources: [{ fqn: "A", reason: "remote" as const }],
};

it.live("no demands → the credential store is never touched", () =>
  Effect.gen(function* () {
    const { record, layer } = makeFakeAuth();
    yield* demandCredentials([]).pipe(
      Effect.provide(demandEnv(untouchableProfileLayer, layer)),
    );
    expect(record.configureCalls).toBe(0);
  }),
);

it.live("a demand for an unregistered cloud is skipped", () =>
  Effect.gen(function* () {
    const { layer } = makeFakeAuth();
    yield* demandCredentials(
      [
        {
          provider: "NoSuchCloud",
          resources: [{ fqn: "A", reason: "remote" }],
        },
      ],
      { nonInteractive: true },
    ).pipe(Effect.provide(demandEnv(untouchableProfileLayer, layer)));
  }),
);

it.live("already-configured credentials are never re-prompted", () =>
  Effect.gen(function* () {
    const profileName = `demand-${uuidv4()}`;
    const { record, layer } = makeFakeAuth();
    yield* demandCredentials([remoteDemand], { nonInteractive: true }).pipe(
      Effect.provide(
        demandEnv(
          inMemoryProfileLayer({
            [profileName]: { [FAKE_PROVIDER]: { method: "fake" } },
          }),
          layer,
          { ALCHEMY_PROFILE: profileName },
        ),
      ),
    );
    expect(record.configureCalls).toBe(0);
  }),
);

it.live(
  "missing credentials + non-interactive → typed CredentialsRequired",
  () =>
    Effect.gen(function* () {
      const profileName = `demand-${uuidv4()}`;
      const { record, layer } = makeFakeAuth();
      const error = yield* demandCredentials([remoteDemand], {
        nonInteractive: true,
      }).pipe(
        Effect.provide(
          demandEnv(inMemoryProfileLayer(), layer, {
            ALCHEMY_PROFILE: profileName,
          }),
        ),
        Effect.flip,
      );
      expect(error).toBeInstanceOf(CredentialsRequired);
      const required = error as CredentialsRequired;
      expect(required.provider).toEqual(FAKE_PROVIDER);
      expect(required.resources).toEqual(["A"]);
      expect(required.message).toContain(
        `alchemy login --profile ${profileName}`,
      );
      // The configure flow must never have been entered (it would acquire
      // an auth lockfile).
      expect(record.configureCalls).toBe(0);
    }),
);

it.live(
  "missing credentials + interactive → configure runs once with the reason",
  () =>
    Effect.gen(function* () {
      const profileName = `demand-${uuidv4()}`;
      const { record, layer } = makeFakeAuth();
      const env = demandEnv(inMemoryProfileLayer(), layer, {
        ALCHEMY_PROFILE: profileName,
      });

      yield* demandCredentials([remoteDemand], {
        nonInteractive: false,
      }).pipe(Effect.provide(env));
      expect(record.configureCalls).toBe(1);
      expect(record.contexts[0]?.ci).toBe(false);
      // The reason names the demanding resources so the prompt says WHY.
      expect(record.contexts[0]?.reason).toContain(
        "This dev session requires Test credentials",
      );
      expect(record.contexts[0]?.reason).toContain("A (runs against");

      // Demanded exactly once: the configured profile short-circuits the
      // next demand.
      yield* demandCredentials([remoteDemand], {
        nonInteractive: false,
      }).pipe(Effect.provide(env));
      expect(record.configureCalls).toBe(1);
    }),
);

it.live("CI runs configure with ci: true instead of failing", () =>
  Effect.gen(function* () {
    const profileName = `demand-${uuidv4()}`;
    const { record, layer } = makeFakeAuth();
    yield* demandCredentials([remoteDemand], { nonInteractive: true }).pipe(
      Effect.provide(
        demandEnv(inMemoryProfileLayer(), layer, {
          ALCHEMY_PROFILE: profileName,
          CI: "true",
        }),
      ),
    );
    // In CI the provider picks its non-interactive default (env-var
    // credentials) via configure(ctx.ci === true) — no prompt, no failure.
    expect(record.configureCalls).toBe(1);
    expect(record.contexts[0]?.ci).toBe(true);
  }),
);

// ── end-to-end: the dev seam in Deploy.ts ───────────────────────────────────
//
// Runs the real `deploy(Stack)` entry point (the same code path `alchemy
// dev` and the test harness use) with `dev: true`.

const e2eAuth = makeFakeAuth();
const e2eStore: Record<
  string,
  Record<string, Record<string, ResourceState>>
> = {};
const e2eStateLayer = Layer.succeed(State, InMemoryService(e2eStore));
// The demand seam resolves Config through the ConfigProvider captured in
// `stack.services` (innermost). The alchemy-test CLI exports `CI=true`
// before imports (which would legitimately route the demand to the CI
// env-credentials branch) — pin a deterministic provider with CI unset and
// a unique, never-configured profile so the seam's non-CI, non-interactive
// branch is what the test exercises. ProfileLive reads ~/.alchemy READ-ONLY
// here: the demand fails before any configure flow could persist anything.
const E2E_PROFILE = `demand-e2e-${uuidv4()}`;
const e2eProviders = () =>
  Layer.mergeAll(
    TestLayers(),
    e2eAuth.layer,
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({ ALCHEMY_PROFILE: E2E_PROFILE }),
    ),
  );

// The seam resolves ALCHEMY_PROFILE from the ambient env (evalStack rebuilds
// its ConfigProvider from env/.env), and the real ProfileLive reads
// ~/.alchemy/profiles.json READ-ONLY. The non-interactive test below pins a
// unique, never-configured profile name via the env (exclusively) so the
// demand deterministically finds nothing configured for "Test".
const devHarness = Test.make({
  providers: e2eProviders(),
  state: e2eStateLayer,
  dev: true,
});

const AllLocalStack = Alchemy.Stack(
  "CredentialDemandAllLocal",
  { providers: e2eProviders(), state: e2eStateLayer },
  Effect.gen(function* () {
    const a = yield* ModalResource("A", { value: "v1" });
    return { runtime: a.runtime };
  }),
);

const RemoteStack = Alchemy.Stack(
  "CredentialDemandRemote",
  { providers: e2eProviders(), state: e2eStateLayer },
  Effect.gen(function* () {
    const a = yield* ModalResource("A", { value: "v1" }).pipe(remote());
    return { runtime: a.runtime };
  }),
);

devHarness.test(
  "an all-local dev deploy succeeds without any credential resolution",
  Effect.gen(function* () {
    const before = e2eAuth.record.configureCalls;
    const output = yield* devHarness.deploy(AllLocalStack);
    expect(output.runtime).toEqual("local");
    // No credential resolution: the fake auth provider's configure flow
    // never ran (a demand would have — this profile has nothing stored).
    expect(e2eAuth.record.configureCalls).toBe(before);
  }),
);

devHarness.test(
  "a remote() row in a non-interactive dev deploy fails with CredentialsRequired before apply",
  Effect.gen(function* () {
    // Force non-interactivity deterministically (ALCHEMY_PLAIN wins over
    // every other isNonInteractive() signal), restore afterwards.
    const previous = yield* Effect.sync(() => {
      const prior = process.env.ALCHEMY_PLAIN;
      process.env.ALCHEMY_PLAIN = "1";
      return prior;
    });
    const error = yield* devHarness.deploy(RemoteStack).pipe(
      Effect.flip,
      Effect.ensuring(
        Effect.sync(() => {
          if (previous === undefined) {
            delete process.env.ALCHEMY_PLAIN;
          } else {
            process.env.ALCHEMY_PLAIN = previous;
          }
        }),
      ),
    );
    expect(error).toBeInstanceOf(CredentialsRequired);
    const required = error as CredentialsRequired;
    expect(required.provider).toEqual("Test");
    expect(required.resources).toEqual(["A"]);
    expect(required.message).toContain(
      `alchemy login --profile ${E2E_PROFILE}`,
    );
    // Demand fails BEFORE apply: nothing was reconciled or persisted.
    expect(e2eStore.CredentialDemandRemote?.test?.A).toBeUndefined();
    expect(e2eAuth.record.configureCalls).toBe(0);
  }),
  { exclusive: true },
);
