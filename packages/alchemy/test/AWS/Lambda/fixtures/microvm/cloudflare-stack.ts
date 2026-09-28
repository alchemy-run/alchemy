import * as AWS from "@/AWS";
import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import SandboxLive from "./sandbox.ts";
import MicrovmWorker from "./worker.ts";

/**
 * Cross-cloud MicroVM stack: deploys the bundled {@link SandboxLive} image
 * plus {@link MicrovmWorker}, a Cloudflare Worker orchestrator (Alchemy mints
 * an IAM User + AccessKey + assume-role Role and the worker assumes it).
 *
 * Needs BOTH provider sets and real Cloudflare credentials, so it is separate
 * from the AWS-only `./stack.ts`.
 */
export default Alchemy.Stack(
  "MicrovmCloudflareStack",
  {
    providers: Layer.mergeAll(AWS.providers(), Cloudflare.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const worker = yield* MicrovmWorker;
    return {
      workerUrl: worker.url.as<string>(),
    };
  }).pipe(Effect.provide(SandboxLive)),
);
