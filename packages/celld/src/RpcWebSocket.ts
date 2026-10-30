import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Shared from "alchemy/Workers/Workerd/RpcWebSocket";
import * as Effect from "effect/Effect";
import type * as RpcSerialization from "effect/rpc/RpcSerialization";
import { DurableObjectState } from "./DurableObjectState.ts";

export type { Transport } from "alchemy/Workers/Workerd/RpcWebSocket";

/** Internal, per-activation transport over the current object's hibernatable WebSockets. */
export const make: Effect.Effect<
  Shared.Transport,
  never,
  DurableObjectState | RuntimeContext | RpcSerialization.RpcSerialization
> = DurableObjectState.pipe(Effect.flatMap(Shared.make));
