import { newWebSocketRpcSession } from "capnweb";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { Platform } from "../Platform.ts";
import type { ProviderService } from "../Provider.ts";
import * as Provider from "../Provider.ts";
import type { ResourceClass, ResourceLike } from "../Resource.ts";
import { RpcProviderClient } from "./RpcProviderClient.ts";
import {
  deserializeRpcHandlers,
  deserializeRpcStreamHandler,
} from "./RpcSerialization.ts";
import type { RpcApi, RpcProvider } from "./RpcServer.ts";

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
      const url = yield* rpcProviderClient.register(mainUrl).pipe(Effect.orDie);
      console.timeEnd("register");
      const session = newWebSocketRpcSession<RpcApi>(url);
      console.time(`getProvider ${cls.Type}`);
      const { version, stables, tail, ...handlers } = yield* Effect.promise(
        (): Promise<RpcProvider> => session.getProvider(cls.Type),
      );
      const deserializedHandlers = deserializeRpcHandlers(handlers);
      console.timeEnd(`getProvider ${cls.Type}`);
      console.log(handlers);
      return {
        version,
        stables,
        tail: tail ? deserializeRpcStreamHandler(tail) : undefined,
        ...deserializeRpcHandlers(handlers),
      } as ProviderService<
        R,
        ReadReq,
        DiffReq,
        PrecreateReq,
        ReconcileReq,
        DeleteReq,
        TailReq,
        LogsReq
      >;
    }),
  );
