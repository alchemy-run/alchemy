import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AlchemyContext from "../AlchemyContext.ts";
import * as Lock from "./Lock.ts";
import * as RpcPaths from "./RpcPaths.ts";

export const layer = (main: string) =>
  Layer.provideMerge(
    Lock.LockLive,
    Layer.provideMerge(
      RpcPaths.layer(main),
      Layer.mergeAll(
        AlchemyContext.AlchemyContextLive,
        Layer.unwrap(
          Effect.promise(() => {
            if ("Bun" in globalThis) {
              return import("./RpcServerBun.ts").then((m) => m.RpcServerBun);
            } else {
              return import("./RpcServerNode.js").then((m) => m.RpcServerNode);
            }
          }),
        ),
      ),
    ),
  );
