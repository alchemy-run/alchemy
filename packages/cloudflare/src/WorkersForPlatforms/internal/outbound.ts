import { isYieldableEffectLike, yieldDeclared } from "alchemy/Util/effect";
import * as Effect from "effect/Effect";
import { isWorker, type Worker } from "../../Workers/Worker.ts";
import type { DispatchNamespace } from "../DispatchNamespace.ts";
import type { GetOptions } from "../Get.ts";

/**
 * The outbound Worker of a `Get`: a Worker or a `Worker.ref(...)` as
 * given, a declaration by yielding it.
 */
export const resolveOutboundWorker = (
  options: GetOptions<any> | undefined,
): Effect.Effect<Worker | undefined> => {
  const target = options?.outbound;
  // A `Worker.ref(...)` is typed as a Worker but isn't a declaration.
  // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- a declaration's requirements are the stack's, satisfied when the binding is made
  if (target === undefined || isWorker(target) || !isYieldableEffectLike(target)) {
    return Effect.succeed(target);
  }
  // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- as above
  return yieldDeclared(target);
};

/** The `dispatch_namespace` Worker binding of a `Get`. */
export const dispatchNamespaceBinding = (
  name: string,
  namespace: DispatchNamespace,
  outbound: Worker | undefined,
  options: GetOptions<any> | undefined,
) => ({
  type: "dispatch_namespace" as const,
  name,
  namespace: namespace.name,
  ...(outbound
    ? {
        outbound: {
          worker: { service: outbound.workerName },
          params: options?.parameters?.map((name) => ({ name })),
        },
      }
    : {}),
});
