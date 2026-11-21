import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import DomainConformanceWorkerV1 from "./conformance-worker-v1.ts";
import DomainConformanceWorker from "./conformance-worker.ts";

const stack = (worker: typeof DomainConformanceWorker | typeof DomainConformanceWorkerV1) =>
  Alchemy.Stack(
    "DomainConformanceStack",
    {
      providers: Layer.mergeAll(Cloudflare.providers(), DomainCloudflare.providers()),
      state: Cloudflare.state(),
    },
    Effect.gen(function* () {
      const front = yield* worker;
      return { url: front.url.as<string>() };
    }),
  );

export default stack(DomainConformanceWorker);

/** The same stack with the model at its next version. */
export const StackV1 = stack(DomainConformanceWorkerV1);
