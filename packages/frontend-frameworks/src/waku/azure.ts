/**
 * `@alchemy.run/frontend-frameworks/waku/azure` — the Azure Functions deploy
 * target for the Waku integration (`Azure.Website.Waku`).
 *
 * It reuses the Node target's build (waku's `node` adapter in a child
 * process) and replaces the listening serve entry with a Fetch module
 * (`dist/server/serve-azure.mjs`, `export default { fetch }`) that calls
 * `INTERNAL_runFetch`. `Azure.Functions.Function` bundles that module for a
 * Flex Consumption app; Front Door serves `dist/public` from Blob Storage.
 *
 * Front Door sends each top-level entry of the client directory to Blob
 * Storage, and it cannot fall back to the Function when a blob is missing.
 * The prerendered RSC payloads (`dist/public/RSC/`) share their path prefix
 * with the payloads of dynamic pages, which only the server renders, so the
 * build removes that directory: the Function answers every `/RSC/*` request
 * (it renders prerendered pages from the build metadata it bundles).
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { makeAzureTarget } from "../core/AzureServe.ts";
import type { BuildOutput } from "../core/BuildOutput.ts";
import { DeployTargetError } from "../core/DeployTarget.ts";
import { makeNodeTarget, type WakuNodeTargetConfig } from "./node.ts";
import type { WakuTarget } from "./Waku.ts";

export type { WakuNodeTargetConfig as WakuAzureTargetConfig } from "./node.ts";

/** Waku's default `rscBase`: the URL prefix of RSC payloads. */
const RSC_BASE = "RSC";

/**
 * Remove the prerendered RSC payloads from the client directory, so Front
 * Door sends `/RSC/*` to the Function. A project that changes `rscBase`
 * keeps its payloads on Blob Storage.
 */
export const removeStaticRscPayloads = (output: BuildOutput) =>
  Effect.gen(function* () {
    if (output.clientDirectory === undefined) return output;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.remove(path.join(output.clientDirectory, RSC_BASE), {
      recursive: true,
      force: true,
    });
    return output;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new DeployTargetError({
          platform: "azure",
          message: "Failed to remove the prerendered RSC payloads from the client directory.",
          cause,
        }),
    ),
  );

/** Waku React Server Components served by an Azure Functions Fetch handler. */
export const target = (
  config?: WakuNodeTargetConfig,
): WakuTarget<WakuNodeTargetConfig | undefined> => {
  const azure = makeAzureTarget(makeNodeTarget(config));
  return {
    ...azure,
    build: (context) => azure.build!(context).pipe(Effect.flatMap(removeStaticRscPayloads)),
  };
};

export const makeAzureWakuTarget = target;

export default target;
