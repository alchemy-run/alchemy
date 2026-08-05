import * as Alchemy from "@/index.ts";
import { providers } from "@/Prisma/Providers.ts";
import * as Effect from "effect/Effect";
import ReadCompute from "./read-compute.ts";
import ReadWriteCompute from "./readwrite-compute.ts";
import WriteCompute from "./write-compute.ts";

/**
 * Deploys three Prisma Compute apps that all bind one shared Object Store
 * bucket — read / write / read-write — over the native Compute binding.
 * Extracted into its own stack file so it can be deployed by the test suite
 * AND inspected directly, e.g.
 *
 * ```sh
 * alchemy tail --stage test ./test/Prisma/fixtures/stack.ts
 * ```
 */
export default Alchemy.Stack(
  "PrismaBucketBindingStack",
  { providers: providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const read = yield* ReadCompute;
    const write = yield* WriteCompute;
    const readWrite = yield* ReadWriteCompute;
    return {
      read: read.url.as<string>(),
      write: write.url.as<string>(),
      readWrite: readWrite.url.as<string>(),
    };
  }),
);
