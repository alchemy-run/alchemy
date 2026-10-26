/**
 * `@alchemy.run/frontend-frameworks/astro/azure` — the Azure Functions
 * deploy target for the Astro integration (`Azure.Website.Astro`).
 *
 * It reuses the Node target's adapter and child-process build, then swaps
 * the listening Node program for an Azure Functions Fetch entry
 * (`serve-azure.mjs`, `export default { fetch(request) }`) that calls
 * `App.render`. Front Door serves the client directory from Blob Storage,
 * so the entry carries no static file server.
 *
 * A fully static build (`output: "static"`) deploys assets-only: the Node
 * target writes its serve entry into the client directory, so this target
 * removes it and drops `serverModules` before the client directory is
 * uploaded.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { finishAzureOutput, makeAzureTarget as wrapAzureTarget } from "../core/AzureServe.ts";
import type { BuildOutput } from "../core/BuildOutput.ts";
import { DeployTargetError } from "../core/DeployTarget.ts";
import { NODE_SERVE_ENTRY_FILE_NAME } from "../core/NodeServe.ts";
import { makeNodeTarget, type AstroNodeConfig, type AstroNodeTarget } from "./node.ts";

/** Remove the Node serve entry a static build left in the client directory. */
const finishStaticOutput = (output: BuildOutput) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.remove(path.join(output.clientDirectory!, NODE_SERVE_ENTRY_FILE_NAME), {
      force: true,
    });
    return {
      ...output,
      serverModules: undefined,
      nodeServe: undefined,
    } satisfies BuildOutput;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new DeployTargetError({
          platform: "azure",
          message: "Failed to remove the Node serve entry from the static Astro build.",
          cause,
        }),
    ),
  );

/**
 * A static build's Node output points `distDirectory` at the client
 * directory (the serve entry sits beside the pages); a server build keeps
 * them apart (`dist/` and `dist/client/`).
 */
const isStaticOutput = (output: BuildOutput) =>
  output.clientDirectory !== undefined && output.distDirectory === output.clientDirectory;

/** Build the Azure Functions {@link AstroNodeTarget}. See the module doc. */
export const makeAzureTarget = (config: AstroNodeConfig = {}): AstroNodeTarget => {
  const node = makeNodeTarget(config);
  return {
    ...wrapAzureTarget(node),
    build: (context) =>
      node.build!(context).pipe(
        Effect.flatMap((output) =>
          isStaticOutput(output) ? finishStaticOutput(output) : finishAzureOutput(output),
        ),
      ),
  };
};

export const target = makeAzureTarget;

export default makeAzureTarget;
