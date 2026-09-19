import * as Cloudflare from "@/Cloudflare";
import type { SubscriptionResourceSource } from "@/Cloudflare/Queues/Subscription";
import * as Effect from "effect/Effect";

type Assert<T extends true> = T;
type Accepts<T> = T extends SubscriptionResourceSource ? true : false;
type _Variant = Assert<Accepts<Cloudflare.Images.Variant>>;
type _Namespace = Assert<Accepts<Cloudflare.KV.Namespace>>;
type _Bucket = Assert<Accepts<Cloudflare.R2.Bucket>>;
type _Job = Assert<Accepts<Cloudflare.R2.SuperSlurperJob>>;
type _Index = Assert<Accepts<Cloudflare.Vectorize.Index>>;
type _Model = Assert<Accepts<Cloudflare.AI.ModelResource>>;
type _Worker = Assert<Accepts<Cloudflare.Worker>>;

const references = Effect.gen(function* () {
  const queue = yield* Cloudflare.Queues.Queue("EventsQueue");
  const sources = [
    yield* Cloudflare.Images.Variant.ref("Image"),
    yield* Cloudflare.KV.Namespace.ref("Cache"),
    yield* Cloudflare.R2.Bucket.ref("Uploads"),
    yield* Cloudflare.R2.SuperSlurperJob.ref("Migration"),
    yield* Cloudflare.Vectorize.Index.ref("Search"),
    yield* Cloudflare.AI.ModelResource.ref("Embeddings"),
    yield* Cloudflare.Worker.ref("Website"),
  ];
  const Subscription = yield* Cloudflare.Queues.Subscription;
  for (const [index, source] of sources.entries()) {
    yield* Subscription(
      `Events${index}`,
      Effect.succeed({
        source,
        events: ["product.event"],
        queueId: queue.queueId,
      }),
    );
  }
  yield* Subscription("Invalid", {
    // @ts-expect-error arbitrary account-bearing objects are not resource sources
    source: { accountId: "account", modelName: "model" },
    events: ["batch.queued"],
    queueId: queue.queueId,
  });
});
void references;
