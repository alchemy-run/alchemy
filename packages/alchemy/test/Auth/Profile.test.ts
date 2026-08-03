import {
  AuthProviderLayer,
  AuthProviders,
  getAuthProvider,
  refreshHint,
} from "@/Auth/AuthProvider.ts";
import {
  ProfileError,
  ProfileStore,
  ProfileStoreLive,
  validateProfileName,
} from "@/Auth/Profile.ts";
import { resolveProfileName } from "@/Cli/commands/_shared.ts";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { v4 as uuidv4 } from "uuid";

const FAKE_PROVIDER = "FakeAuthProvider";

// Records whether the lock-wrapped `configure` was ever entered. A missing
// profile must short-circuit before provider configuration starts.
const state = { configureCalls: 0 };

const FakeAuth = AuthProviderLayer<{ method: "env" }, undefined>()(
  FAKE_PROVIDER,
  {
    configure: () =>
      Effect.sync(() => {
        state.configureCalls += 1;
        return { method: "env" as const };
      }),
    login: () => Effect.void,
    logout: () => Effect.void,
    prettyPrint: () => Effect.void,
    read: () => Effect.succeed(undefined),
  },
);

const TestLayer = Layer.mergeAll(ProfileStoreLive, FakeAuth).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.succeed(AuthProviders, {}),
      ConfigProvider.layer(ConfigProvider.fromUnknown({})),
      NodeServices.layer,
    ),
  ),
);

it.live("loadOrConfigure requires profiles to be explicitly created", () =>
  Effect.gen(function* () {
    state.configureCalls = 0;
    const profile = yield* ProfileStore;
    const auth = yield* getAuthProvider<{ method: "env" }, undefined>(
      FAKE_PROVIDER,
    );

    const error = yield* profile
      .loadOrConfigure(auth, `non-existent-${uuidv4()}`, { ci: false })
      .pipe(Effect.flip);

    expect(error).toBeInstanceOf(ProfileError);
    expect((error as ProfileError).message).toContain("profile create");
    // The lock-wrapped `configure` must never run.
    expect(state.configureCalls).toBe(0);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("accepts portable profile names", () =>
  Effect.gen(function* () {
    expect(yield* validateProfileName("production-admin")).toBe(
      "production-admin",
    );
    expect(yield* validateProfileName("team.prod_2")).toBe("team.prod_2");
  }),
);

it("includes the selected profile in refresh hints", () => {
  expect(refreshHint("Cloudflare", "production")).toBe(
    "Run: alchemy profile refresh production --provider Cloudflare",
  );
});

it.effect(
  "rejects profile names that can escape the credential directory",
  () =>
    Effect.gen(function* () {
      for (const name of ["..", "../..", "team/prod", "/tmp/profile", ""]) {
        const error = yield* validateProfileName(name).pipe(Effect.flip);
        expect(error).toBeInstanceOf(ProfileError);
      }
    }),
);

it.effect("resolves ALCHEMY_PROFILE from an explicit env file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* fs.makeTempFileScoped();
    yield* fs.writeFileString(file, "ALCHEMY_PROFILE=from-env-file\n");

    expect(yield* resolveProfileName(Option.some(file), undefined)).toBe(
      "from-env-file",
    );
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect("lets --profile override ALCHEMY_PROFILE from an env file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* fs.makeTempFileScoped();
    yield* fs.writeFileString(file, "ALCHEMY_PROFILE=from-env-file\n");

    expect(yield* resolveProfileName(Option.some(file), "from-cli")).toBe(
      "from-cli",
    );
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);
