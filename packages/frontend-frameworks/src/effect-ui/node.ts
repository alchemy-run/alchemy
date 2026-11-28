import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { runBuildChild } from "../core/BuildChild.ts";
import { DeployTargetError, makeDeployTarget } from "../core/index.ts";
import {
  NODE_BUNDLE_CONDITIONS,
  NODE_SERVE_ENTRY_FILE_NAME,
  relativeClientDirExpression,
  writeNodeServeEntry,
} from "../core/NodeServe.ts";
import { make, type EffectUITarget, type EffectUITargetConfig } from "./EffectUI.ts";

const fail = (message: string, cause?: unknown) =>
  new DeployTargetError({ platform: "node", message, cause });

const makeNodeFinishTarget = (config: EffectUITargetConfig = {}): EffectUITarget =>
  makeDeployTarget({
    platform: "node",
    config,
    bundle: { conditions: [...NODE_BUNDLE_CONDITIONS] },
    finish: (output, context) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        if (!output.distDirectory || !output.clientDirectory)
          return yield* fail("Effect UI produced no deployment or client directory.");
        const server = path.join(output.distDirectory, "server");
        yield* fs.makeDirectory(server, { recursive: true });
        yield* fs.writeFileString(path.join(server, "package.json"), '{"type":"module"}\n');
        const servePath = path.join(server, NODE_SERVE_ENTRY_FILE_NAME);
        const handler =
          context.entry === undefined
            ? undefined
            : {
                kind: "fetch" as const,
                imports: `import * as entry from ${JSON.stringify("./" + path.relative(server, context.entry).replaceAll("\\", "/"))};`,
                expr: "(request) => entry.handler(request)",
              };
        return yield* writeNodeServeEntry({
          output,
          servePath,
          serveModuleName: `server/${NODE_SERVE_ENTRY_FILE_NAME}`,
          clientDirExpression: relativeClientDirExpression(servePath, output.clientDirectory),
          handler,
          assetBasePath: context.assetBasePath,
          serveRootIndex: true,
          // A prerendered `404.html` is the app's own not-found page;
          // without one, a browser-only app routes deep links itself.
          notFoundHandling:
            config.notFoundHandling ??
            (handler
              ? "none"
              : (yield* fs.exists(path.join(output.clientDirectory, "404.html")))
                ? "404-page"
                : config.output === "static"
                  ? "none"
                  : "spa"),
          // `HtmlServerVite` prerenders `/about` to `about.html`.
          htmlHandling: config.htmlHandling ?? "drop-trailing-slash",
          platform: "node",
        });
      }).pipe(
        Effect.catchTag("PlatformError", (cause) =>
          Effect.fail(fail("Failed to emit the Effect UI Node entry", cause)),
        ),
      ),
  });

/** Isolate Vite configuration execution from the deployment process. */
export const buildInChild = (input: {
  readonly rootDir: string;
  readonly config: EffectUITargetConfig;
}) =>
  Effect.gen(function* () {
    const framework = yield* make({
      ...input.config,
      root: input.rootDir,
      target: makeNodeFinishTarget(input.config),
    });
    return yield* framework.build({ root: input.rootDir });
  });

export const makeNodeTarget = (config: EffectUITargetConfig = {}): EffectUITarget => ({
  ...makeNodeFinishTarget(config),
  build: (context) =>
    runBuildChild({
      module: import.meta.url,
      rootDir: context.root,
      env: context.env,
      framework: "effect-ui",
      config: { rootDir: context.root, config },
    }).pipe(Effect.mapError((error) => fail(error.message, error.cause))),
});
export const target = makeNodeTarget;
export default makeNodeTarget;
