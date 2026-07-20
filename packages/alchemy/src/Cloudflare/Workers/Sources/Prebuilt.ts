import * as Effect from "effect/Effect";
import * as Artifacts from "../../../Artifacts.ts";
import type { SourceDevHandle, SourceProvider } from "../Source.ts";
import {
  readPrebuiltWorkerBundle,
  watchPrebuiltWorkerBundle,
  type ModuleRule,
} from "../WorkerBundle.ts";

/**
 * Source provider for prebuilt workers (`bundle: false`): the entry and
 * every file matching the module rules are uploaded byte-for-byte — no
 * bundling, no minification. `hash()` is a cheap re-read (IO + sha256,
 * no bundling), cached per run under the shared `"build"` artifact key.
 *
 * Local dev honors the same byte-for-byte contract: the entry directory
 * is fs-watched and re-read on change — never re-bundled with rolldown,
 * which would violate the prebuilt contract ("re-bundling such artifacts
 * is unsafe").
 */
export const makePrebuiltSource = (options: {
  main: string;
  rules: ModuleRule[] | undefined;
}): SourceProvider => {
  const build = readPrebuiltWorkerBundle({
    main: options.main,
    rules: options.rules,
  }).pipe(Artifacts.cached("build"));
  return {
    ownsAssets: false,
    build: () =>
      build.pipe(
        Effect.map((output) => ({
          bundle: output,
          assets: undefined,
          hash: {
            bundle: output.hash,
            assets: undefined,
            input: undefined,
            additionalWorkspaces: undefined,
          },
        })),
      ),
    hash: () => build.pipe(Effect.map((output) => ({ bundle: output.hash }))),
    dev: () =>
      Effect.succeed({
        mode: "bundle",
        bundles: watchPrebuiltWorkerBundle({
          main: options.main,
          rules: options.rules,
        }),
      } satisfies SourceDevHandle),
  };
};
