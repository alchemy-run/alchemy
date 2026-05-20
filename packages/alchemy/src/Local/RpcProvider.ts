import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { Platform } from "../Platform.ts";
import * as Provider from "../Provider.ts";
import type { ResourceClass, ResourceLike } from "../Resource.ts";
import { RpcProviderClient } from "./RpcProviderClient.ts";

export const effect = <
  R extends ResourceLike,
  Req = never,
  ReadReq = never,
  DiffReq = never,
  PrecreateReq = never,
  ReconcileReq = never,
  DeleteReq = never,
  TailReq = never,
  LogsReq = never,
>(
  cls: ResourceClass<R> | Platform<R, any, any, any, any>,
  mainUrl: string,
  eff: Effect.Effect<
    Provider.ProviderService<
      R,
      ReadReq,
      DiffReq,
      PrecreateReq,
      ReconcileReq,
      DeleteReq,
      TailReq,
      LogsReq
    >,
    never,
    Req
  >,
) =>
  Provider.effect(
    cls,
    Effect.gen(function* () {
      const rpcProviderClient = yield* Effect.serviceOption(
        RpcProviderClient,
      ).pipe(Effect.map(Option.getOrUndefined));
      if (!rpcProviderClient) {
        console.log("no rpc provider client");
        return yield* eff;
      }
      console.time("register");
      const provider = yield* rpcProviderClient
        .get(mainUrl, cls.Type)
        .pipe(Effect.orDie);
      console.timeEnd("register");
      return provider as any;
    }),
  );
