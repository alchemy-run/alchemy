import * as Cloudflare from "@/Cloudflare";
import * as Prisma from "@/Prisma";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import ReadCompute from "./read-compute.ts";
import ReadWriteCompute from "./readwrite-compute.ts";
import ReadWriteWorker from "./readwrite-worker.ts";
import WriteCompute from "./write-compute.ts";

// Both providers, because the stack mixes Prisma Compute apps with a Worker.
const providers = Layer.merge(Cloudflare.providers(), Prisma.providers());

/**
 * Deploys three Prisma Compute apps and one Cloudflare Worker that all bind
 * one shared Prisma Object Store bucket — read / write / read-write on
 * Compute, read-write on the Worker. Extracted into its own stack file so it
 * can be deployed by the test suite AND inspected directly, e.g.
 *
 * ```sh
 * alchemy tail --stage test ./test/Prisma/fixtures/stack.ts
 * ```
 */
export default Alchemy.Stack(
  "PrismaBucketBindingStack",
  { providers, state: Cloudflare.state() },
  Effect.gen(function* () {
    const read = yield* ReadCompute;
    const write = yield* WriteCompute;
    const readWrite = yield* ReadWriteCompute;
    const worker = yield* ReadWriteWorker;
    return {
      read: read.url.as<string>(),
      write: write.url.as<string>(),
      readWrite: readWrite.url.as<string>(),
      worker: worker.url.as<string>(),
    };
  }),
);
