import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { type DurableDeferred, Workflow, WorkflowEngine } from "effect/workflow";
import { targetId } from "./Aggregate.ts";
import type * as Rejection from "./Rejection.ts";

type Fields = Schema.Struct.Fields;

/** The schema of a saga's key: a string id, usually an aggregate's id schema. */
export type KeySchema = Schema.Top & { readonly Type: string };

/** The rejections a saga declares, as one union schema. */
type RejectsSchema<Rejects extends ReadonlyArray<Rejection.Any>> = Rejects extends readonly []
  ? typeof Schema.Never
  : Schema.Union<Rejects>;

type ResultSchema<R extends Fields | undefined> = R extends Fields
  ? Schema.Struct<R>
  : typeof Schema.Void;

/** The payload a saga's workflow runs with: its key, plus its input. */
type PayloadFields<K extends KeySchema, I extends Fields> = { readonly key: K } & I;

/**
 * The pure definition of a saga: its invariants.
 */
export interface Definition<
  K extends KeySchema,
  I extends Fields,
  R extends Fields | undefined,
  Rejects extends ReadonlyArray<Rejection.Any>,
> {
  /**
   * What identifies one run, usually the id of the aggregate the saga is
   * about. Starting a saga again with the same key returns the same run.
   */
  readonly key: K;
  /** What a run is started with, besides its key. */
  readonly input?: I;
  /** What a run that completes returns. */
  readonly result?: R;
  /** Every way a run can be refused. */
  readonly rejects?: Rejects;
}

/** Where a saga run is. */
export type Status<A, E> =
  | { readonly _tag: "NotStarted" }
  | { readonly _tag: "Running" }
  | { readonly _tag: "Completed"; readonly result: A }
  | { readonly _tag: "Rejected"; readonly rejection: E }
  | { readonly _tag: "Interrupted" };

/** What starting a saga returns. */
export interface Receipt {
  /** The run's id: the saga's key. */
  readonly executionId: string;
}

/**
 * A saga's client, provided by the model that lists it. Every method is
 * addressed by the saga's key.
 */
export interface Client<Key, Input, A, E> {
  /** Start a run, or return the run already started with this key. */
  readonly start: (key: Key | { readonly id: Key }, input: Input) => Effect.Effect<Receipt>;
  /** Where the run is now. */
  readonly status: (key: Key | { readonly id: Key }) => Effect.Effect<Status<A, E>>;
  /** Wait for the run to finish: its result, or its rejection. */
  readonly result: (key: Key | { readonly id: Key }) => Effect.Effect<A, E>;
  /** Complete a `DurableDeferred` the run waits on. */
  readonly signal: <S extends Schema.Constraint, Er extends Schema.Constraint>(
    key: Key | { readonly id: Key },
    deferred: DurableDeferred.DurableDeferred<S, Er>,
    value: S["Type"],
  ) => Effect.Effect<void>;
  /** Stop the run: it fails where it waits, and its compensations run. */
  readonly interrupt: (key: Key | { readonly id: Key }) => Effect.Effect<void>;
}

/**
 * Structural constraint satisfied by every saga class.
 */
export interface Any extends Context.Key<unknown, unknown> {
  readonly kind: "Saga";
  readonly sagaName: string;
  readonly workflow: Workflow.Workflow<string, any, any, any>;
  readonly Implementation: Context.Key<unknown, true>;
}

/** The requirement identifier of a saga's client. */
export type Identifier<S extends Any> = S extends Context.Key<infer I, unknown> ? I : never;

/** The requirement identifier of a saga's implementation. */
export type ImplementationIdentifier<S extends Any> = S extends Any
  ? S["Implementation"] extends Context.Key<infer I, unknown>
    ? I
    : never
  : never;

/** Type-level identity of a saga's client in an Effect's requirements. */
export interface SagaKey<Name extends string> {
  readonly "~alchemy/Domain/Saga": Name;
}

/** Type-level identity of a saga's implementation in an Effect's requirements. */
export interface ImplementationKey<Name extends string> {
  readonly "~alchemy/Domain/Saga/Implementation": Name;
}

/**
 * A process that spans several aggregates and takes time: a transfer that
 * debits one account and credits another, or an order that waits for
 * payment. Each step runs once and its result is kept, so a run that's
 * interrupted picks up where it left off. A step that fails after earlier
 * ones succeeded can undo them with compensations.
 *
 * A saga is an Effect workflow. Its steps are `Activity`s, it waits with
 * `DurableClock` and `DurableDeferred`, and it undoes steps with
 * `withCompensation`. A policy usually decides when to start one.
 *
 * ### Declaring a saga
 * **Example:** A transfer between two accounts
 * ```typescript
 * import * as Domain from "alchemy/Domain";
 * import * as Schema from "effect/Schema";
 * import { AccountId } from "./AccountId.ts";
 * import { TransferId } from "./TransferId.ts";
 *
 * export class DestinationClosed extends Domain.Rejection("DestinationClosed") {}
 *
 * export class ExecuteTransfer extends Domain.Saga("ExecuteTransfer", {
 *   key: TransferId,
 *   input: { from: AccountId, to: AccountId, amount: Schema.Int },
 *   rejects: [DestinationClosed],
 * }) {}
 * ```
 *
 * ### Implementing it
 * **Example:** Debit, credit, and refund if the credit fails
 * ```typescript
 * import * as Effect from "effect/Effect";
 * import { Activity } from "effect/workflow";
 * import { Account } from "./Account.ts";
 *
 * export const ExecuteTransferLive = ExecuteTransfer.toLayer(
 *   Effect.gen(function* () {
 *     const accounts = yield* Account;
 *     return Effect.fn(function* ({ key, from, to, amount }) {
 *       yield* Activity.make({
 *         name: "debit",
 *         execute: accounts.send(from, new DebitTransfer({ transferId: key, amount })).pipe(Effect.orDie),
 *       }).pipe(
 *         ExecuteTransfer.withCompensation(() =>
 *           Activity.make({
 *             name: "refund",
 *             execute: accounts.send(from, new RefundTransfer({ transferId: key, amount })).pipe(Effect.orDie),
 *           }),
 *         ),
 *       );
 *       yield* Activity.make({
 *         name: "credit",
 *         error: DestinationClosed,
 *         execute: accounts
 *           .send(to, new CreditTransfer({ transferId: key, amount }))
 *           .pipe(Effect.catchTag("NotOpen", () => new DestinationClosed()), Effect.orDie),
 *       });
 *     });
 *   }),
 * );
 * ```
 *
 * ### Starting it
 * **Example:** From a policy
 * ```typescript
 * export const TransferExecutionLive = TransferExecution.toLayer(
 *   Effect.gen(function* () {
 *     const executions = yield* ExecuteTransfer;
 *     return Effect.fn(function* ({ source, event }) {
 *       yield* executions.start(source, { from: event.from, to: event.to, amount: event.amount });
 *     });
 *   }),
 * );
 * ```
 *
 * @primitive
 */
export const make = <
  const Name extends string,
  K extends KeySchema,
  const I extends Fields = {},
  const R extends Fields | undefined = undefined,
  const Rejects extends ReadonlyArray<Rejection.Any> = readonly [],
>(
  name: Name,
  definition: Definition<K, I, R, Rejects>,
): SagaClass<Name, K, I, R, Rejects> => {
  const rejects = definition.rejects ?? [];
  const workflow = Workflow.make(name, {
    payload: { key: definition.key, ...definition.input } as PayloadFields<K, I>,
    idempotencyKey: (payload) => (payload as { readonly key: string }).key,
    success: (definition.result ? Schema.Struct(definition.result) : Schema.Void) as Schema.Top,
    error: (rejects.length > 0 ? Schema.Union(rejects) : Schema.Never) as Schema.Top,
  });
  const Tag = Context.Service<SagaKey<Name>, Client<unknown, unknown, unknown, unknown>>()(
    `alchemy/Domain/Saga/${name}`,
  );
  const Implementation = Context.Service<ImplementationKey<Name>, true>()(
    `alchemy/Domain/Saga/${name}/Implementation`,
  );
  return class extends Tag {
    static readonly kind = "Saga" as const;
    static readonly sagaName: Name = name;
    static readonly definition = definition;
    static readonly workflow = workflow;
    static readonly Implementation = Implementation;
    static readonly withCompensation = workflow.withCompensation;
    static toLayer<E, Req>(build: Effect.Effect<Handler<any, any, any, any>, E, Req>) {
      const register = Layer.unwrap(
        Effect.map(build, (handle) =>
          workflow.toLayer((payload) => handle(payload as never) as Effect.Effect<any, any, any>),
        ),
      );
      return Layer.merge(register, Layer.succeed(Implementation, true as const));
    }
  } as unknown as SagaClass<Name, K, I, R, Rejects>;
};

/** What a saga's implementation runs for each run: its key and input. */
export type Handler<Payload, A, E, Req> = (payload: Payload) => Effect.Effect<A, E, Req>;

/** The services Effect workflows provide to a run, which a handler may use freely. */
type RunServices =
  | WorkflowEngine.WorkflowEngine
  | WorkflowEngine.WorkflowInstance
  | Workflow.Execution<string>
  | Scope.Scope;

/**
 * The class type returned by {@link make}.
 */
export interface SagaClass<
  Name extends string,
  K extends KeySchema,
  I extends Fields,
  R extends Fields | undefined,
  Rejects extends ReadonlyArray<Rejection.Any>,
> extends Context.ServiceClass<
  SagaKey<Name>,
  string,
  Client<K["Type"], Schema.Struct.Type<I>, ResultSchema<R>["Type"], RejectsSchema<Rejects>["Type"]>
> {
  readonly kind: "Saga";
  readonly sagaName: Name;
  readonly definition: Definition<K, I, R, Rejects>;
  /** The Effect workflow the saga runs as. */
  readonly workflow: Workflow.Workflow<
    Name,
    Schema.Struct<PayloadFields<K, I>>,
    ResultSchema<R>,
    RejectsSchema<Rejects>
  >;
  /** Provided by {@link toLayer}; a model that lists the saga requires it. */
  readonly Implementation: Context.Key<ImplementationKey<Name>, true>;
  /**
   * Undo a step if the run fails later: `compensation` runs with the step's
   * result. Use it on a top-level step, usually an `Activity`.
   */
  readonly withCompensation: Workflow.Workflow<
    Name,
    Schema.Struct<PayloadFields<K, I>>,
    ResultSchema<R>,
    RejectsSchema<Rejects>
  >["withCompensation"];
  /**
   * Implement the saga. The construction Effect runs once, resolving the
   * services its steps use (aggregate clients, external systems); the handler
   * it returns runs each run, with its key and input.
   */
  toLayer<E, Req, HandlerReq>(
    build: Effect.Effect<
      Handler<
        Schema.Struct.Type<PayloadFields<K, I>>,
        ResultSchema<R>["Type"],
        RejectsSchema<Rejects>["Type"],
        HandlerReq
      >,
      E,
      Req
    >,
  ): Layer.Layer<
    ImplementationKey<Name>,
    E,
    Req | WorkflowEngine.WorkflowEngine | Exclude<HandlerReq, RunServices>
  >;
}

// ---------------------------------------------------------------- the client

/** Poll a run every so often while waiting for it to finish. */
const POLL = Schedule.min([Schedule.exponential("50 millis"), Schedule.spaced("1 second")]);

/** @internal Build a saga's client over a workflow engine. */
export const client = (
  saga: Any,
  engine: WorkflowEngine.WorkflowEngine["Service"],
): Client<unknown, unknown, unknown, unknown> => {
  const workflow = saga.workflow;
  const poll = (executionId: string) => engine.poll(workflow, executionId);
  return {
    start: (key, input) =>
      Effect.gen(function* () {
        const executionId = targetId(key);
        yield* engine.execute(workflow, {
          executionId,
          payload: { ...(input as object), key: executionId },
          discard: true,
        });
        return { executionId };
      }) as Effect.Effect<Receipt>,
    status: (key) =>
      Effect.map(poll(targetId(key)), (result): Status<unknown, unknown> => {
        if (Option.isNone(result)) return { _tag: "NotStarted" };
        if (result.value._tag === "Suspended") return { _tag: "Running" };
        const exit = result.value.exit;
        if (Exit.isSuccess(exit)) return { _tag: "Completed", result: exit.value };
        const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");
        return failure?._tag === "Fail"
          ? { _tag: "Rejected", rejection: failure.error }
          : { _tag: "Interrupted" };
      }) as Effect.Effect<Status<unknown, unknown>>,
    result: (key) =>
      poll(targetId(key)).pipe(
        Effect.flatMap((result) =>
          Option.isSome(result) && result.value._tag === "Complete"
            ? Effect.succeed(result.value.exit)
            : Effect.fail("running" as const),
        ),
        Effect.retry({ schedule: POLL }),
        Effect.orDie,
        Effect.flatten,
      ) as Effect.Effect<unknown, unknown>,
    signal: (key, deferred, value) =>
      engine.deferredDone(deferred, {
        workflowName: workflow._tag,
        executionId: targetId(key),
        deferredName: deferred.name,
        exit: Exit.succeed(value),
      }) as Effect.Effect<void>,
    interrupt: (key) => engine.interrupt(workflow, targetId(key)),
  };
};
