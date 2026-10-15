import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import { Group1, Group20, Group100, handlersFor } from "./rpc-schema.ts";

const objectRuntime = (group: typeof Group1) =>
  Effect.gen(function* () {
    const version = yield* Cloudflare.Workers.VersionMetadata();
    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      const handlers = handlersFor(group, state.id.toString(), version);
      return RpcServer.toHttpEffect(group).pipe(
        Effect.provide(Layer.mergeAll(handlers, RpcSerialization.layerNdjson)),
      );
    });
  });

export class RpcObject1 extends Cloudflare.RpcDurableObject<RpcObject1>()(
  "RpcObject1",
  { schema: Group1 },
  objectRuntime(Group1),
) {}
export class RpcObject20 extends Cloudflare.RpcDurableObject<RpcObject20>()(
  "RpcObject20",
  { schema: Group20 },
  objectRuntime(Group20),
) {}
export class RpcObject100 extends Cloudflare.RpcDurableObject<RpcObject100>()(
  "RpcObject100",
  { schema: Group100 },
  objectRuntime(Group100),
) {}
