import * as AWS from "@/AWS";
import * as Effect from "effect/Effect";
import { SandboxBuildRole } from "../microvm/sandbox.ts";

/**
 * Non-Effect ("external") MicroVM image for the benchmark — the AWS analog of
 * the Cloudflare Container benchmark's `bun`/`remote` variants. It is built
 * server-side from a plain Dockerfile (a tiny Python HTTP server on :8080);
 * no Effect program is bundled and no in-VM runtime is injected.
 *
 * The class is a typed handle imported by the orchestrators to bind the
 * MicroVM instance operations; the default-export Live layer (built via
 * `.make` with an empty runtime, since external mode bundles nothing) is what
 * provisions the image on the stack. Reuses the same {@link SandboxBuildRole}.
 */
export class BenchExternal extends AWS.Lambda.MicrovmImage<BenchExternal>()(
  "MicrovmBenchExternal",
) {}

export default BenchExternal.make(
  SandboxBuildRole.pipe(
    Effect.map((buildRole) => ({
      context: new URL("./external/", import.meta.url).pathname,
      buildRole,
      // Pin memory to match the effectful image so both fit the per-account
      // MicroVM memory quota at the benchmark's concurrency (an unpinned image
      // inherits a larger default and only ~1 fits, starving the run). Keep the
      // default x86_64 arch — forcing ARM_64 breaks the Python image build.
      resources: [{ minimumMemoryInMiB: 512 }],
    })),
  ),
  // External mode builds from the Dockerfile; there is no Effect runtime to
  // bundle, so the impl shape is empty (nothing is served at build time).
  Effect.succeed({}),
);
