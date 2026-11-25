import * as Output from "alchemy/Output";
import { sanitizeKey } from "alchemy/RuntimeContext";
import { isYieldableEffectLike, yieldDeclared } from "alchemy/Util/effect";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { isWorker, type Worker } from "../../Workers/Worker.ts";
import { isWorkerEntrypoint } from "../../Workers/WorkerEntrypoint.ts";
import { type DispatchNamespace, isDispatchNamespace } from "../DispatchNamespace.ts";
import type { DispatchNamespaceInput, DispatchOutbound } from "../Get.ts";

/**
 * An outbound target that isn't a Worker. It is a defect, not a failure: the
 * type already refuses it, and nothing can recover from it at deploy time.
 */
export class InvalidOutboundWorker extends Data.TaggedError("InvalidOutboundWorker")<{
  readonly message: string;
}> {}

/** An outbound target with its Worker resolved. */
export interface ResolvedOutbound {
  readonly worker: Worker;
  readonly parameters: ReadonlyArray<string>;
}

/** Resolve a dispatch namespace given as a resource or its declaration. */
export const resolveDispatchNamespace = (
  namespace: DispatchNamespaceInput,
): Effect.Effect<DispatchNamespace> =>
  // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- a declaration's requirements are the stack's, satisfied when the binding is made; `any` until core types them (alchemy/Input.ts)
  isDispatchNamespace(namespace) ? Effect.succeed(namespace) : yieldDeclared(namespace);

/**
 * Resolve the outbound Worker of a dispatch binding: a Worker or a ref as
 * given, a declaration by yielding it; an entrypoint is refused.
 */
export const resolveOutbound = (outbound: DispatchOutbound) =>
  Effect.gen(function* () {
    const parameters = outbound.parameters;
    const target = outbound.worker;
    // An untyped `Cloudflare.WorkerEntrypoint`: Cloudflare accepts an
    // entrypoint on the outbound Worker but doesn't store it.
    if (isWorkerEntrypoint(target)) {
      return yield* Effect.die(
        new InvalidOutboundWorker({
          message:
            "An outbound Worker is a Worker, not an entrypoint: Cloudflare accepts an entrypoint on a dispatch binding's outbound Worker but doesn't keep it, and calls its default export. Pass the Worker, and route inside its default export.",
        }),
      );
    }
    // A `Worker.ref(...)` is typed as a Worker but is a ref expression, not a
    // declaration: only a declaration is yielded.
    const worker =
      // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- a declaration's requirements are the stack's, satisfied when the binding is made; `any` until core types them (alchemy/Input.ts)
      isWorker(target) || !isYieldableEffectLike(target) ? target : yield* yieldDeclared(target);
    return { worker, parameters } satisfies ResolvedOutbound;
  });

/**
 * The binding name of an Effect-native outbound dispatch binding. It carries
 * the target and the parameter names, so two `Get`s on one namespace with
 * different outbound Workers are two bindings instead of one.
 */
export const outboundBindingName = (namespace: DispatchNamespace, outbound: ResolvedOutbound) =>
  sanitizeKey(
    [namespace.LogicalId, "outbound", workerId(outbound.worker), ...outbound.parameters]
      .filter((part) => part !== undefined)
      .join("_"),
  );

/**
 * A `Worker.ref(...)` serves only its `Type` statically, so its id comes from
 * the ref expression rather than `LogicalId`.
 */
const workerId = (worker: Worker): string => {
  if (Output.isRefExpr(worker)) {
    return [worker.stack, worker.stage, worker.resourceId]
      .filter((part) => part !== undefined)
      .join("_");
  }
  return worker.LogicalId;
};

/**
 * The wire shape of the binding's `outbound`. `worker.environment` is left
 * out: it addresses the legacy service-environments model.
 */
export const toWireOutbound = (outbound: ResolvedOutbound) => ({
  worker: { service: outbound.worker.workerName },
  ...(outbound.parameters.length === 0
    ? {}
    : { params: outbound.parameters.map((name) => ({ name })) }),
});
