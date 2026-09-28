import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { RpcObjectMetrics } from "./metrics.ts";

const makeStatsApi = Effect.gen(function* () {
  const metrics = yield* RpcObjectMetrics;
  return {
    ready: () => metrics.getByName("readiness").ready(),
    record: () => Effect.succeed({ forwarded: true, nested: { value: 42 } }),
    append: (id: string, event: string) => metrics.getByName(id).append(event),
    read: (id: string) => metrics.getByName(id).read(),
  };
});

export class RpcObjectStatsWorker extends Cloudflare.Worker<
  RpcObjectStatsWorker,
  Effect.Success<typeof makeStatsApi>
>()("RpcObjectStatsWorker") {}

export default RpcObjectStatsWorker.make(
  { main: import.meta.url },
  makeStatsApi,
);
