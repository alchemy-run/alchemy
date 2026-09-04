import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { fileURLToPath } from "node:url";
import path from "pathe";
import { describe, expect, test } from "alchemy-test";
import {
  buildStackProviders,
  collectAuthProviderContext,
  collectAuthProviders,
  DEFAULT_ENTRYPOINT,
  importStack,
  open,
  resolveStackProfileName,
  routeCacheLayer,
  StackModuleLoader,
} from "@/Alchemist/Session.ts";
import * as Nuke from "@/Alchemist/routes/nuke.ts";
import * as ProviderRoute from "@/Alchemist/routes/provider.ts";
import * as AlchemistState from "@/Alchemist/routes/state.ts";
import * as CliKit from "@/Cli/CliKit/index.ts";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Redacted from "effect/Redacted";
import { evalStack } from "../../src/Stack";
import * as TestCore from "../../src/Test/Core";
import { TestLayers } from "../test.resources";
import {
  ProviderSecret,
  StateSecret,
} from "./fixtures/secret-manager-probes.ts";

const fixtureAbsolutePath = fileURLToPath(
  import.meta.resolve("./fixtures/import-stack-fixture.ts"),
);
const fixtureRelativePath = path.relative(process.cwd(), fixtureAbsolutePath);
const secretManagerFixture = fileURLToPath(
  import.meta.resolve("./fixtures/secret-manager-stack.ts"),
);

const runFixture = (path: string) =>
  TestCore.run(
    importStack(path).pipe(
      Effect.flatMap((stackEffect) =>
        evalStack(stackEffect, (stack) => Effect.succeed(stack.output), {
          stage: "test",
        }),
      ),
    ),
    {
      providers: TestLayers(),
    },
  );

describe("importStack", () => {
  test("loads stack entrypoint via relative path", () =>
    expect(runFixture(fixtureRelativePath)).resolves.toBe(
      "import-stack-fixture",
    ));

  test("loads stack entrypoint via absolute path", () =>
    expect(runFixture(fixtureAbsolutePath)).resolves.toBe(
      "import-stack-fixture",
    ));

  test("memoizes an opened stack session within a command scope", async () => {
    const [first, second] = await TestCore.run(
      Effect.all([
        open({ entrypoint: fixtureAbsolutePath, stage: "test" }),
        open({ entrypoint: fixtureAbsolutePath, stage: "test" }),
      ]).pipe(
        Effect.provide(routeCacheLayer),
        Effect.provide(CliKit.layer({ input: false })),
      ),
      { providers: TestLayers() },
    );

    expect(second).toBe(first);
  });

  test("resolves stack secrets before executing the stack", async () => {
    const session = await TestCore.run(
      open({ entrypoint: secretManagerFixture, stage: "preview-42" }).pipe(
        Effect.provide(routeCacheLayer),
        Effect.provide(CliKit.layer({ input: false })),
      ),
      { providers: TestLayers() },
    );

    expect(session.stack.output).toBe("secret-preview-42");
  });

  test("resolves stack secrets before provider and state layers", async () => {
    const built = await TestCore.run(
      buildStackProviders({
        main: secretManagerFixture,
        envFile: Option.none(),
        stage: "provider-stage",
      }),
      { providers: TestLayers() },
    );

    const context = built.context as unknown as Context.Context<
      ProviderSecret | StateSecret
    >;
    expect(Context.get(context, ProviderSecret)).toBe("secret-provider-stage");
    expect(Context.get(context, StateSecret)).toBe("secret-provider-stage");
  });

  test("uses stack secrets during authentication discovery", async () => {
    const collected = await TestCore.run(
      collectAuthProviderContext({
        main: secretManagerFixture,
        envFile: Option.none(),
        stage: "auth-stage",
      }).pipe(Effect.provide(routeCacheLayer)),
      { providers: TestLayers() },
    );

    const value = await Effect.runPromise(
      Config.string("FIXTURE_SECRET").pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          collected.configProvider,
        ),
      ),
    );
    expect(value).toBe("secret-auth-stage");

    const custom = collected.authProviders.FixtureAuth;
    expect(custom).toBeDefined();
    expect(
      await Effect.runPromise(custom!.read("default", { method: "fixture" })),
    ).toBe("secret-auth-stage");

    const neon = collected.authProviders.Neon;
    expect(neon?.readEnvironment).toBeDefined();
    const credentials = (await Effect.runPromise(neon!.readEnvironment!)) as {
      readonly apiKey: Redacted.Redacted<string>;
    };
    expect(Redacted.value(credentials.apiKey)).toBe("neon-auth-stage");
  });

  test("uses stack secrets while constructing configured state", async () => {
    const state = await TestCore.run(
      AlchemistState.store({
        backend: "configured",
        entrypoint: secretManagerFixture,
        stage: "state-stage",
      }).pipe(
        Effect.provide(routeCacheLayer),
        Effect.provide(CliKit.layer({ input: false })),
      ),
      { providers: TestLayers() },
    );

    expect(state.id).toBe("fixture-secret-state-stage");
  });

  test("uses stack secrets for provider environment checks", async () => {
    const result = await TestCore.run(
      ProviderRoute.checkEnvironment({
        entrypoint: secretManagerFixture,
        providers: ["Neon"],
        stage: "provider-check-stage",
      }).pipe(Effect.provide(routeCacheLayer)),
      { providers: TestLayers() },
    );

    expect(result).toEqual({
      checks: [{ provider: "Neon", status: "satisfied", missing: [] }],
      satisfied: true,
    });
  });

  test("does not import a stack for config-less state backends", async () => {
    let imports = 0;
    const state = await TestCore.run(
      AlchemistState.store({ backend: "local" }).pipe(
        Effect.provideService(StackModuleLoader, {
          import: async () => {
            imports += 1;
            throw new Error("config-less state must not import a stack");
          },
        }),
      ),
      { providers: TestLayers() },
    );

    expect(state.id).toBe("local");
    expect(imports).toBe(0);
  });

  test("uses stack secrets for profile selection while preserving explicit overrides", async () => {
    const [configured, explicit] = await TestCore.run(
      Effect.all([
        resolveStackProfileName({
          main: secretManagerFixture,
          envFile: Option.none(),
          stage: "profile-stage",
        }),
        resolveStackProfileName({
          main: secretManagerFixture,
          envFile: Option.none(),
          profile: "explicit-profile",
          stage: "profile-stage",
        }),
      ]).pipe(
        Effect.provide(routeCacheLayer),
        Effect.provide(CliKit.layer({ input: false })),
      ),
      { providers: TestLayers() },
    );

    expect(configured).toBe("manager-profile");
    expect(explicit).toBe("explicit-profile");
  });

  test("forwards the nuke stage into stack provider construction", async () => {
    const scan = await TestCore.run(
      Nuke.scan({
        entrypoint: secretManagerFixture,
        stage: "nuke-stage",
        mode: "live",
      }).pipe(Effect.provide(CliKit.layer({ input: false }))),
      { providers: TestLayers() },
    );

    expect(
      Context.get(
        scan.context as Context.Context<ProviderSecret>,
        ProviderSecret,
      ),
    ).toBe("secret-nuke-stage");
  });

  test("memoizes an auth registry within a command scope", async () => {
    const options = {
      main: DEFAULT_ENTRYPOINT,
      envFile: Option.none<string>(),
      profile: "default",
    };
    const [first, second] = await TestCore.run(
      Effect.all([
        collectAuthProviders(options),
        collectAuthProviders(options),
      ]).pipe(
        Effect.provide(routeCacheLayer),
        Effect.provide(CliKit.layer({ input: false })),
      ),
      { providers: TestLayers() },
    );

    expect(second).toBe(first);
  });

  test("reports a missing stack entrypoint as a user-facing error", async () => {
    const result = await TestCore.run(
      importStack(
        path.join(import.meta.dirname, "missing-alchemy.run.ts"),
      ).pipe(Effect.result),
      { providers: TestLayers() },
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("StackEntrypointError");
      expect(result.failure.message).toContain("does not exist");
      expect(result.failure.message).toContain("--config <path>");
    }
  });
});
