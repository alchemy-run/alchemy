import * as Cloudflare from "@/Cloudflare";
import type * as Effect from "effect/Effect";
import { makeApi } from "./api.ts";

export class RpcObjectTargetWorker extends Cloudflare.Worker<
  RpcObjectTargetWorker,
  Effect.Success<typeof makeApi>
>()("RpcObjectTargetWorker") {}

export default RpcObjectTargetWorker.make({ main: import.meta.url }, makeApi);
