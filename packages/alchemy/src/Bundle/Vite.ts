import * as Effect from "effect/Effect";
import {
  viteBuildOutputPlugin as collectViteOutput,
  type ViteBuildOutput as FrameworkViteBuildOutput,
} from "@alchemy.run/cloudflare-runtime/vite/build-output";
import {
  bundleErrorFromUnknown,
  type BundleError,
  type BundleOutput,
} from "./Bundle.ts";
export interface ViteBuildOutput extends Omit<
  FrameworkViteBuildOutput,
  "serverBundle"
> {
  readonly serverBundle: Effect.Effect<BundleOutput | undefined, BundleError>;
}
export const adaptViteBuildOutput = (
  output: FrameworkViteBuildOutput,
): ViteBuildOutput => ({
  ...output,
  serverBundle: output.serverBundle.pipe(
    Effect.mapError(bundleErrorFromUnknown),
  ),
});
export const viteBuildOutputPlugin = Effect.fn(function* (options: {
  entryEnvironment?: string;
}) {
  const { plugin, output } = yield* collectViteOutput(options);
  return { plugin, output: output.pipe(Effect.map(adaptViteBuildOutput)) };
});
