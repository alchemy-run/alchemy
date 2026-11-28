import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { runBuildChild } from "../core/BuildChild.ts";
import {
  DeployTargetError,
  makeDeployTarget,
  readServerModulesFromDisk,
  sortServerModules,
} from "../core/index.ts";
import { make, type EffectUITarget, type EffectUITargetConfig } from "./EffectUI.ts";

export interface EffectUIAwsTargetConfig extends EffectUITargetConfig {
  /** Stream Lambda responses. @default true */
  readonly streaming?: boolean | undefined;
}
const fail = (message: string, cause?: unknown) =>
  new DeployTargetError({ platform: "aws", message, cause });

/** Use the same web Request/Response adapter as the other Lambda framework targets. */
const makeAwsFinishTarget = (config: EffectUIAwsTargetConfig = {}): EffectUITarget =>
  makeDeployTarget({
    platform: "aws",
    config,
    bundle: {
      conditions: ["node", "import", "module"],
      external: ["@aws-sdk/"],
    },
    finish: (output, context) =>
      Effect.gen(function* () {
        if (!context.entry) return output;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        if (!output.distDirectory)
          return yield* fail("Effect UI produced no deployment directory.");
        const server = path.join(output.distDirectory, "server");
        const adapter = yield* Effect.try({
          try: () =>
            fileURLToPath(import.meta.resolve("@alchemy.run/frontend-frameworks/aws-lambda")),
          catch: (cause) => fail("Failed to resolve the Lambda adapter", cause),
        });
        const source = yield* fs.readFileString(adapter);
        yield* fs.writeFileString(
          path.join(server, "effect-ui-aws-lambda.mjs"),
          source.replace(/^\/\/# sourceMappingURL=.*$/m, ""),
        );
        yield* fs.writeFileString(path.join(server, "package.json"), '{"type":"module"}\n');
        const wrap = config.streaming === false ? "toBufferedLambdaHandler" : "toLambdaHandler";
        yield* fs.writeFileString(
          path.join(server, "index.mjs"),
          `import * as entry from ${JSON.stringify("./" + path.relative(server, context.entry).replaceAll("\\", "/"))};
import { ${wrap} } from "./effect-ui-aws-lambda.mjs";
export const handler = ${wrap}((request) => entry.handler(request));
`,
        );
        const modules = yield* readServerModulesFromDisk({
          directory: server,
          prefix: "server",
        }).pipe(Effect.mapError((error) => fail(error.message, error.cause)));
        return {
          ...output,
          serverModules: sortServerModules(modules, "server/index.mjs"),
        };
      }).pipe(
        Effect.catchTag("PlatformError", (cause) =>
          Effect.fail(fail("Failed to emit the Effect UI Lambda entry", cause)),
        ),
      ),
  });

export const buildInChild = (input: {
  readonly rootDir: string;
  readonly config: EffectUIAwsTargetConfig;
}) =>
  Effect.gen(function* () {
    const framework = yield* make({
      ...input.config,
      root: input.rootDir,
      target: makeAwsFinishTarget(input.config),
    });
    return yield* framework.build({ root: input.rootDir });
  });
export const makeAwsTarget = (config: EffectUIAwsTargetConfig = {}): EffectUITarget => ({
  ...makeAwsFinishTarget(config),
  build: (context) =>
    runBuildChild({
      module: import.meta.url,
      rootDir: context.root,
      env: context.env,
      framework: "effect-ui",
      config: { rootDir: context.root, config },
    }).pipe(Effect.mapError((error) => fail(error.message, error.cause))),
});
export const target = makeAwsTarget;
export default makeAwsTarget;
