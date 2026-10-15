import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import { Group1, handlersFor } from "./rpc-schema.ts";

export const backendRuntime = (group: typeof Group1) =>
  Effect.gen(function* () {
    const version = yield* Cloudflare.Workers.VersionMetadata();
    const handlers = handlersFor(group, "", version);
    return RpcServer.toHttpEffect(group).pipe(
      Effect.provide(Layer.mergeAll(handlers, RpcSerialization.layerNdjson)),
    );
  }).pipe(Effect.provide(Cloudflare.Workers.VersionMetadataBinding));
