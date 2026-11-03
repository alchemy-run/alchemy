import { expect, it } from "@alchemy.run/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  AuthError,
  AuthProviderLayer,
  AuthProvidersLive,
  type PreflightResource,
} from "@/Auth/AuthProvider.ts";
import { preflightCredentials } from "@/Auth/Preflight.ts";
import { ProfileStore, ProfileStoreLive } from "@/Auth/Profile.ts";

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
