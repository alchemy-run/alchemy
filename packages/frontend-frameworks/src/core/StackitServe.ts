import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { toOutputFile, type BuildOutput } from "./BuildOutput.ts";
import { DeployTargetError, type DeployTarget } from "./DeployTarget.ts";
import { makeNodeServeEntrySource, pinNodeServeModule } from "./NodeServe.ts";

/**
 * The suffix of the hostnames STACKIT assigns to a CDN distribution
 * (`{uid}.{zone}.cdn.onstackit.cloud`). A forwarded host is only believed when it
 * has this suffix, which every customer's distribution shares: it can't prove the host
 * is this site's. `ALCHEMY_SITE_HOST` does, and takes precedence.
 */
export const STACKIT_CDN_HOST_SUFFIX = ".cdn.onstackit.cloud";

/**
 * Replace the serve entry of a build with one for a STACKIT Function behind the CDN.
 * Without a source, the build keeps the entry it has.
 */
export const writeStackitEntry = (output: BuildOutput, source: string | undefined) =>
  Effect.gen(function* () {
    const entry = output.serverModules?.[0];
    if (output.distDirectory === undefined || entry === undefined || source === undefined) {
      return output;
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(path.join(output.distDirectory, entry.name), source);
    return pinNodeServeModule(output, yield* toOutputFile(entry.name, source));
  }).pipe(
    Effect.mapError(
      (cause) =>
        new DeployTargetError({
          platform: "stackit",
          message: "Failed to emit the STACKIT serve entry.",
          cause,
        }),
    ),
  );

/**
 * Rewrite a Node target's serve entry in place for a STACKIT Function behind the
 * CDN. A STACKIT Function is a container serving HTTP, so the Node server is the
 * handler. A distribution has one origin, so this server also serves the assets,
 * which is what `behindCdn` is for.
 *
 * A target whose server isn't described by `nodeServe` (vinext starts its own
 * production server) keeps its entry here, and calls {@link writeStackitEntry} itself.
 */
export const finishStackitOutput = (output: BuildOutput) => {
  const nodeServe = output.nodeServe && {
    ...output.nodeServe,
    behindCdn: { forwardedHostSuffix: STACKIT_CDN_HOST_SUFFIX },
  };
  return writeStackitEntry(
    nodeServe ? { ...output, nodeServe } : output,
    nodeServe && makeNodeServeEntrySource(nodeServe),
  );
};

/** Reuse a Node target's build and configuration, finishing for a STACKIT Function. */
export const makeStackitTarget = <T extends DeployTarget>(node: T): T => ({
  ...node,
  platform: "stackit",
  ...(node.build
    ? {
        build: (context) => node.build!(context).pipe(Effect.flatMap(finishStackitOutput)),
      }
    : {}),
  ...(node.finish
    ? {
        finish: (output, context) =>
          node.finish!(output, context).pipe(Effect.flatMap(finishStackitOutput)),
      }
    : {}),
});
