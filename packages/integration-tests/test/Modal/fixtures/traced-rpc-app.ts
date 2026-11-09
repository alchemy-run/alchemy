import * as Modal from "@alchemy.run/modal";
import * as Effect from "effect/Effect";

/** The App the traced RPC callers and callees run in. */
export const TracedRpcApp = Effect.gen(function* () {
  const environment = yield* Modal.Environment("TracedRpcEnv", {});
  return yield* Modal.App("TracedRpcApp", { environment });
});
