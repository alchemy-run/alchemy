/**
 * The standard connection-env convention a caller binding uses to reach a
 * network-hosted worker (a Celld fleet worker, a Rivet cluster worker):
 * `bindWorker` binds the worker's URL and auth secret into the caller's
 * environment under these keys, and the runtime stub reads them back.
 *
 * @internal shared by `Celld.bindWorker` and `Rivet.bindWorker`; not
 * exported from the package barrel.
 */
import * as Redacted from "effect/Redacted";
import { sanitizeKey } from "./RuntimeContext.ts";

/** The standard env keys a caller binding stores the worker connection under. */
export const workerConnectionKeys = (workerLogicalId: string) => ({
  urlKey: sanitizeKey(`ALCHEMY_WORKER_${workerLogicalId}_URL`),
  secretKey: sanitizeKey(`ALCHEMY_WORKER_${workerLogicalId}_SECRET`),
});

/** Unwrap a possibly-`Redacted` env value to its raw string. */
export const rawEnvValue = (value: unknown): string | undefined =>
  value === undefined
    ? undefined
    : Redacted.isRedacted(value)
      ? String(Redacted.value(value))
      : String(value);

/**
 * A reference to a worker: the platform class itself (statically carries
 * `LogicalId`), a deployed worker resource, or a thunk for forward
 * references / import cycles.
 */
export type WorkerRefLike =
  | { readonly LogicalId: string }
  | (() => WorkerRefLike);

/** @internal */
export const resolveWorkerRef = (
  ref: WorkerRefLike,
  depth = 0,
): { LogicalId: string } => {
  if (
    ref !== null &&
    typeof (ref as { LogicalId?: unknown }).LogicalId === "string"
  ) {
    return ref as { LogicalId: string };
  }
  if (typeof ref === "function" && depth < 8) {
    return resolveWorkerRef((ref as () => WorkerRefLike)(), depth + 1);
  }
  throw new Error(
    "Invalid worker reference: pass the worker class (or a thunk of it).",
  );
};
