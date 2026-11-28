import type { ScopedPlanStatusSession } from "alchemy/Report";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type { WorkerBinding } from "./WorkerBinding.ts";

/**
 * A Durable Object class a Worker still exports only so its objects can move
 * to another class. Bound onto the Worker as `retiringClasses`:
 *
 * ```ts
 * yield* worker.bind`Billing.Retire`({
 *   retiringClasses: [{ group: "Billing", className: "Billing.AccountAggregate", binding: "Billing.AccountAggregate" }],
 * });
 * ```
 *
 * Cloudflare deletes a class only once an upload stops exporting it, and its
 * objects must move out before then. So a deploy of a Worker with retiring
 * classes uploads twice: once with them, so the uploaded code can move their
 * objects, and once without each class {@link DurableObjectRetirement}
 * reports empty, which deletes it. A class the Worker doesn't have yet is
 * never created just to retire it.
 */
export interface RetiringClass {
  /** The classes one {@link DurableObjectRetirement} call retires together. */
  readonly group: string;
  readonly className: string;
  /** The binding the Worker's code reaches the class by. */
  readonly binding: string;
  /** What the retirement needs to know of the class (where its objects move), opaque to the Worker. */
  readonly data?: Readonly<Record<string, unknown>>;
}

/** One group of a Worker's retiring classes, as the Worker deploy hands it over. */
export interface RetirementRequest {
  readonly scriptName: string;
  readonly group: string;
  /** The group's classes the Worker has. */
  readonly classes: ReadonlyArray<RetiringClass>;
  /** The Worker's bindings in this upload. */
  readonly bindings: ReadonlyArray<WorkerBinding>;
  /** The classes the Worker had before this deploy. */
  readonly deployedClasses: ReadonlySet<string>;
  /** The Worker's Durable Object namespace ids by class, from its last upload. */
  readonly namespaces: Readonly<Record<string, string>>;
  readonly session: ScopedPlanStatusSession;
}

/** Moving a retiring class's objects failed, or took longer than the deploy waits. */
export interface RetirementError {
  readonly _tag: string;
  readonly message: string;
}

/**
 * Moves the objects out of a Worker's retiring classes during its deploy (see
 * {@link RetiringClass}). The package that binds `retiringClasses` provides
 * it with its Stack's providers.
 */
export class DurableObjectRetirement extends Context.Service<
  DurableObjectRetirement,
  {
    /** Before the first upload: the classes already empty, which this upload deletes. */
    readonly settled: (
      request: RetirementRequest,
    ) => Effect.Effect<ReadonlySet<string>, RetirementError>;
    /** After the first upload: move the classes' objects, and return the classes now empty. */
    readonly retire: (
      request: RetirementRequest,
    ) => Effect.Effect<ReadonlySet<string>, RetirementError>;
  }
>()("Cloudflare.DurableObjectRetirement") {}

/** A Worker binds `retiringClasses`, and no {@link DurableObjectRetirement} is provided to move them. */
export class MissingDurableObjectRetirement extends Data.TaggedError(
  "MissingDurableObjectRetirement",
)<{ readonly message: string }> {}
