import { expect, it } from "@alchemy.run/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Alchemist from "@/Alchemist/index.ts";
import {
  AuthError,
  AuthProviderLayer,
  AuthProvidersLive,
  type PreflightResource,
} from "@/Auth/AuthProvider.ts";
import { preflightCredentials } from "@/Auth/Preflight.ts";
import { ProfileStore, ProfileStoreLive } from "@/Auth/Profile.ts";
import { Stack } from "@/index.ts";
import { inMemoryState } from "@/State/index.ts";
import { Queue, queueProvider } from "../test.resources.ts";

const PROBE = "PreflightProbe";
const PROBE_TOKEN = "PREFLIGHT_PROBE_TOKEN";

const calls: Array<{
  profileName: string;
  config: { method: "stored"; grant: string };
  resources: ReadonlyArray<PreflightResource>;
}> = [];

/** Fails its preflight unless the stored grant is "full". */
const ProbeAuth = AuthProviderLayer<{ method: "stored"; grant: string }, string>()(PROBE, {
  configSchema: Schema.Struct({ method: Schema.Literal("stored"), grant: Schema.String }),
  configure: () => Effect.succeed({ method: "stored" as const, grant: "full" }),
  login: () => Effect.void,
  logout: () => Effect.void,
  details: () => Effect.succeed({ lines: [] }),
  read: () => Effect.succeed("profile-credentials"),
  readEnvironment: Effect.succeed("env-credentials"),
  environment: [{ name: PROBE_TOKEN, required: true, secret: true }],
  preflight: (profileName, config, resources) => {
    calls.push({ profileName, config, resources });
    return config.grant === "full"
      ? Effect.void
      : Effect.fail(AuthError.make({ message: `${PROBE}: grant lacks scope.write` }));
  },
});

const resources: PreflightResource[] = [
  { Type: `${PROBE}.Bucket`, FQN: "Uploads" },
  { Type: "OtherCloud.Queue", FQN: "Jobs" },
  { Type: `${PROBE}.Database`, FQN: "Db" },
];

/** A temp `ALCHEMY_HOME`; tests using this are `exclusive` (process-global env). */
const withTempHome = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  config: Record<string, unknown> = {},
) =>
  Effect.gen(function* () {
    calls.length = 0;
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-preflight-" });
    const previous = process.env.ALCHEMY_HOME;
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        process.env.ALCHEMY_HOME = dir;
      }),
      () =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.ALCHEMY_HOME;
          else process.env.ALCHEMY_HOME = previous;
        }),
    );
    return yield* effect.pipe(
      Effect.provide(
        Layer.mergeAll(ProfileStoreLive, ProbeAuth).pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              AuthProvidersLive,
              ConfigProvider.layer(ConfigProvider.fromUnknown(config)),
              NodeServices.layer,
            ),
          ),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const storeGrant = (grant: string) =>
  Effect.gen(function* () {
    const profile = yield* ProfileStore;
    yield* profile.setProviderConfig("default", PROBE, { method: "stored", grant });
  });

it.live(
  "hands a provider its own resources and the stored profile config",
  () =>
    withTempHome(
      Effect.gen(function* () {
        yield* storeGrant("full");
        yield* preflightCredentials(resources);
        expect(calls).toEqual([
          {
            profileName: "default",
            config: { method: "stored", grant: "full" },
            resources: [resources[0], resources[2]],
          },
        ]);
      }),
    ),
  { tags: ["unit", "local"], exclusive: true },
);

it.live(
  "fails with the provider's message when the grant falls short",
  () =>
    withTempHome(
      Effect.gen(function* () {
        yield* storeGrant("partial");
        const error = yield* Effect.flip(preflightCredentials(resources));
        expect(error.message).toBe(`${PROBE}: grant lacks scope.write`);
      }),
    ),
  { tags: ["unit", "local"], exclusive: true },
);

it.live(
  "skips environment credentials and unconfigured providers",
  () =>
    Effect.gen(function* () {
      yield* withTempHome(
        Effect.gen(function* () {
          yield* storeGrant("partial");
          yield* preflightCredentials(resources);
        }),
        { [PROBE_TOKEN]: "token" },
      );
      expect(calls).toEqual([]);
      yield* withTempHome(preflightCredentials(resources));
      expect(calls).toEqual([]);
    }),
  { tags: ["unit", "local"], exclusive: true },
);

/** Records the resources `Alchemist.plan` hands a provider's preflight. */
const planned: string[][] = [];
const PlanAuth = AuthProviderLayer<{ method: "stored" }, string>()("Test", {
  configSchema: Schema.Struct({ method: Schema.Literal("stored") }),
  configure: () => Effect.succeed({ method: "stored" as const }),
  login: () => Effect.void,
  logout: () => Effect.void,
  details: () => Effect.succeed({ lines: [] }),
  read: () => Effect.succeed("profile-credentials"),
  preflight: (_profileName, _config, resources) =>
    Effect.sync(() => {
      planned.push(resources.map((resource) => resource.FQN).toSorted());
    }),
});

const twoQueues = Stack(
  "PreflightSelection",
  { providers: Layer.mergeAll(queueProvider(), PlanAuth), state: inMemoryState() },
  Effect.gen(function* () {
    yield* Queue("A", {});
    yield* Queue("Q", {});
  }),
);

/** A depends on B through its props; C stands apart. */
const dependentQueues = Stack(
  "PreflightDependencies",
  { providers: Layer.mergeAll(queueProvider(), PlanAuth), state: inMemoryState() },
  Effect.gen(function* () {
    const b = yield* Queue("B", {});
    yield* Queue("A", { name: b.name });
    yield* Queue("C", {});
  }),
);

interface PlanInput {
  readonly stack: typeof twoQueues | typeof dependentQueues;
  readonly include?: ReadonlyArray<string>;
  readonly exclude?: ReadonlyArray<string>;
  readonly dev?: boolean;
}

/**
 * Run `plans` with a temp `ALCHEMY_HOME` whose default profile configures
 * the "Test" auth provider. Tests using this are `exclusive` (process env).
 */
const withProfile = (plans: ReadonlyArray<PlanInput>) =>
  Effect.gen(function* () {
    planned.length = 0;
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-preflight-plan-" });
    const previous = { ALCHEMY_HOME: process.env.ALCHEMY_HOME, CI: process.env.CI };
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        process.env.ALCHEMY_HOME = dir;
        // A CI runner resolves environment credentials, which skip the check.
        delete process.env.CI;
      }),
      () =>
        Effect.sync(() => {
          for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }),
    );
    yield* Effect.gen(function* () {
      const profile = yield* ProfileStore;
      yield* profile.setProviderConfig("default", "Test", { method: "stored" });
      for (const input of plans) {
        yield* Effect.scoped(Alchemist.plan({ ...input, operation: "deploy", stage: "test" }));
      }
    }).pipe(Effect.provide(Alchemist.layer()));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.live(
  "Alchemist.plan checks only the resources an include or exclude selects",
  () =>
    Effect.gen(function* () {
      yield* withProfile([
        { stack: twoQueues },
        { stack: twoQueues, include: ["A"] },
        { stack: twoQueues, exclude: ["A"] },
      ]);
      expect(planned).toEqual([["A", "Q"], ["A"], ["Q"]]);
    }),
  { tags: ["unit", "local"], exclusive: true },
);

it.live(
  "Alchemist.plan checks the dependencies an include pulls in",
  () =>
    Effect.gen(function* () {
      yield* withProfile([{ stack: dependentQueues, include: ["A"] }]);
      expect(planned).toEqual([["A", "B"]]);
    }),
  { tags: ["unit", "local"], exclusive: true },
);

it.live(
  "Alchemist.plan skips the check for dev runs",
  () =>
    Effect.gen(function* () {
      yield* withProfile([{ stack: twoQueues, dev: true }, { stack: twoQueues }]);
      // Only the second, non-dev plan reaches the preflight.
      expect(planned).toEqual([["A", "Q"]]);
    }),
  { tags: ["unit", "local"], exclusive: true },
);
