import { Command, Options, Args } from "@effect/cli";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as FileSystem from "@effect/platform/FileSystem";
import * as ConfigProvider from "effect/ConfigProvider";
import {
  NodeContext,
  NodeHttpClient,
  NodeRuntime,
} from "@effect/platform-node";
import * as S from "effect/Schema";
import * as LanguageModel from "@effect/ai/LanguageModel";
import * as Chat from "@effect/ai/Chat";
import * as Config from "effect/Config";
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { toolkit, toolkitLayer } from "./tools/index.ts";
import * as PlatformConfigProvider from "@effect/platform/PlatformConfigProvider";
import * as Persistence from "@effect/experimental/Persistence";
import { LogLevel } from "effect";

const OpenAi = OpenAiClient.layerConfig({
  apiKey: Config.redacted("OPENAI_API_KEY"),
});

const gpt5Nano = OpenAiLanguageModel.model("gpt-5-codex");

const generateCommand = Command.make(
  "generate",
  {
    service: Args.text({ name: "service" }).pipe(
      Args.withDescription("Main file to generate"),
    ),
    resource: Options.text("resource").pipe(
      Options.withDefault(undefined),
      Options.withDescription("Resource to generate. Defaults to all."),
    ),
    clean: Options.boolean("clean").pipe(
      Options.withDefault(false),
      Options.withDescription("Clean up all previous sessions."),
    ),
  },
  ({ service, resource, clean }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* Chat.fromPrompt([
        {
          role: "system",
          content: yield* fs.readFileString("AGENTS.md"),
        },
      ]);
      const {
        value: { resources },
      } = yield* LanguageModel.generateObject({
        toolkit,
        prompt: `List the resources for the ${service} service. Make sure to use your tools to explore the Terraform Provider and Cloudformation docs.`,
        schema: S.Struct({
          resources: S.Array(S.String),
        }),
      });

      console.log(resources);
    }).pipe(
      Effect.provide(
        Chat.layerPersisted({
          storeId: "chat",
        }),
      ),
    ),
);

const root = Command.make("codegen", {}).pipe(
  Command.withSubcommands([generateCommand]),
);

// Set up the CLI application
const cli = Command.run(root, {
  name: "Alchemy Effect Code",
  version: "1.0.0",
});

await Effect.gen(function* () {
  yield* cli(process.argv).pipe(
    Effect.withConfigProvider(yield* PlatformConfigProvider.fromDotEnv(".env")),
    Effect.provide(toolkitLayer),
    Effect.provide(gpt5Nano),
    Effect.provide(OpenAi),
  );
}).pipe(
  Logger.withMinimumLogLevel(
    process.env.DEBUG ? LogLevel.Debug : LogLevel.Info,
  ),
  Effect.scoped,
  Effect.provide(NodeContext.layer),
  Effect.provide(NodeHttpClient.layer),
  Effect.provide(Persistence.layerMemory),
  // Effect.runPromise,
  NodeRuntime.runMain,
);
// Prepare and run the CLI application
