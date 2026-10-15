import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import R2Worker from "./src/r2-worker.ts";
import { CpuCopyBucket } from "./src/r2-workloads.ts";

/**
 * Separate test-owned R2 copy stack. Preserve this stage for baseline/candidate.
 *
 * Deploy: bun alchemy deploy benchmark/cloudflare-cpu/r2.run.ts --stage cpu-r2-preview --yes --no-input
 * Cleanup: bun alchemy destroy benchmark/cloudflare-cpu/r2.run.ts --stage cpu-r2-preview --yes --no-input
 * The bucket is forceDestroy: cleanup removes its fixed seed/copy objects too.
 */
export default Alchemy.Stack(
  "CloudflareR2CopyBenchmark",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const worker = yield* R2Worker;
    const bucket = yield* CpuCopyBucket;
    return {
      workerUrl: worker.url.as<string>(),
      workerName: worker.workerName,
      workerId: worker.workerId,
      bucketName: bucket.bucketName,
    };
  }),
);
