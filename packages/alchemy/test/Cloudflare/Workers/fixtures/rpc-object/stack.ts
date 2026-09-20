import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import RpcObjectCaller from "./caller-worker.ts";
import RpcObjectStatsWorkerLive from "./stats-worker.ts";
import RpcObjectTargetWorkerLive from "./target-worker.ts";

export default Alchemy.Stack(
  "RpcObjectStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const caller = yield* RpcObjectCaller;
    return { url: caller.url.as<string>() };
  }).pipe(
    Effect.provide(
      RpcObjectTargetWorkerLive.pipe(
        Layer.provideMerge(RpcObjectStatsWorkerLive),
      ),
    ),
  ),
);
