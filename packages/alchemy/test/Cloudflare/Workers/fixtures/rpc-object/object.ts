import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { makeApi } from "./api.ts";

export class RpcObjectTarget extends Cloudflare.DurableObject<
  RpcObjectTarget,
  Effect.Success<typeof makeApi>
>()("RpcObjectTarget") {}

export const RpcObjectTargetLive = RpcObjectTarget.make(
  makeApi.pipe(Effect.map((api) => Effect.succeed(api))),
);
