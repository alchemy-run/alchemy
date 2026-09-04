import { bindWorkerAsyncBindings } from "@/Cloudflare/Workers/WorkerAsyncBindings.ts";
import { resolveSecretManagerConfig } from "@/SecretManager.ts";
import * as Varlock from "alchemy/Varlock";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

const projectDirectory = process.argv[2]!;
const stages = process.argv.slice(3);
process.chdir(projectDirectory);

const originalConsoleLog = console.log;
const originalStage = process.env.ALCHEMY_STAGE;
const originalPrivateBlob = process.env.__VARLOCK_ENV;
const fallback = ConfigProvider.fromUnknown({
  FALLBACK_ONLY: "fallback",
  __VARLOCK_ENV: "must-not-be-forwarded",
});

const read = (provider: ConfigProvider.ConfigProvider, name: string) =>
  Config.string(name).pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, provider),
  );

const program = Effect.gen(function* () {
  const resolved: Array<{
    stage?: string;
    apiKey: string;
    fallback: string;
    privateBindingForwarded: boolean;
  }> = [];
  const secretBindings: Array<unknown> = [];

  for (const rawStage of stages.length > 0 ? stages : [""]) {
    const stage = rawStage.length > 0 ? rawStage : undefined;
    const provider = yield* resolveSecretManagerConfig({
      secrets: Varlock.SecretManager(),
      stack: "varlock-fixture",
      stage,
      fallback,
    });
    const bindingContributions: Array<{
      readonly bindings: ReadonlyArray<unknown>;
    }> = [];
    const worker = {
      FQN: "SecurityProbe",
      LogicalId: "SecurityProbe",
      Mode: "live",
      bind: () => (data: { readonly bindings: ReadonlyArray<unknown> }) =>
        Effect.sync(() => bindingContributions.push(data)),
    };
    yield* bindWorkerAsyncBindings(
      worker as any,
      {
        env: {
          API_KEY: yield* Config.redacted("API_KEY").pipe(
            Effect.provideService(ConfigProvider.ConfigProvider, provider),
          ),
        },
      } as any,
    ) as Effect.Effect<void>;
    secretBindings.push(bindingContributions[0]?.bindings[0]);
    resolved.push({
      stage,
      apiKey: yield* read(provider, "API_KEY"),
      fallback: yield* read(provider, "FALLBACK_ONLY"),
      privateBindingForwarded: yield* Config.option(
        Config.string("__VARLOCK_ENV"),
      ).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, provider),
        Effect.map((value) => value._tag === "Some"),
      ),
    });
  }

  return { resolved, secretBindings };
});

Effect.runPromise(Effect.scoped(program)).then(
  ({ resolved, secretBindings }) => {
    console.log(
      JSON.stringify({
        resolved,
        secretBindings,
        consolePatched: console.log !== originalConsoleLog,
        stageRestored: process.env.ALCHEMY_STAGE === originalStage,
        privateBlobRestored: process.env.__VARLOCK_ENV === originalPrivateBlob,
      }),
    );
  },
  (error) => {
    console.log(
      JSON.stringify({
        error: {
          tag:
            error !== null &&
            typeof error === "object" &&
            "_tag" in error &&
            typeof error._tag === "string"
              ? error._tag
              : undefined,
          message:
            error instanceof Error
              ? error.message
              : "Unknown secret-manager error",
        },
        consolePatched: console.log !== originalConsoleLog,
        stageRestored: process.env.ALCHEMY_STAGE === originalStage,
        privateBlobRestored: process.env.__VARLOCK_ENV === originalPrivateBlob,
      }),
    );
  },
);
