import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { Fields } from "./Event.ts";
import * as Telemetry from "./Telemetry.ts";

type OpImpl = (args: unknown) => Effect.Effect<unknown, unknown, unknown>;

/**
 * Trace every call to an external system: one client span per call, named
 * after the system and operation, plus a call count by outcome.
 *
 * @internal
 */
export const observeOps = (
  system: string,
  impl: Readonly<Record<string, OpImpl>>,
): Record<string, OpImpl> =>
  Object.fromEntries(
    Object.entries(impl).map(([op, call]) => [
      op,
      (args: unknown) =>
        call(args).pipe(
          Effect.onExit((exit) =>
            Telemetry.record(Telemetry.externalCalls, {
              "domain.system": system,
              "domain.operation": op,
              "domain.outcome": Exit.isSuccess(exit) ? "ok" : "failed",
            }),
          ),
          Effect.withSpan(`Domain.external ${system}.${op}`, {
            kind: "client",
            attributes: { "domain.system": system, "domain.operation": op },
          }),
        ),
    ]),
  );

/**
 * Sees every call to an implemented external system. A story provides one, so
 * it can assert what each real call was sent and what it returned.
 *
 * @internal
 */
export interface CallRecorder {
  readonly record: (
    system: string,
    op: string,
    args: unknown,
    call: Effect.Effect<unknown, unknown, unknown>,
  ) => Effect.Effect<unknown, unknown, unknown>;
}

/** @internal */
export const CallRecorder = Context.Reference<CallRecorder | undefined>(
  "alchemy/Domain/ExternalSystem/CallRecorder",
  { defaultValue: () => undefined },
);

const recordOps = (
  system: string,
  impl: Readonly<Record<string, OpImpl>>,
): Record<string, OpImpl> =>
  Object.fromEntries(
    Object.entries(impl).map(([op, call]) => [
      op,
      Effect.fn(function* (args: unknown) {
        const recorder = yield* CallRecorder;
        return yield* recorder ? recorder.record(system, op, args, call(args)) : call(args);
      }),
    ]),
  );

/**
 * One operation of an external system: its arguments, success value and business errors.
 */
export interface OpSpec {
  readonly args?: Fields;
  readonly success?: Fields | Schema.Top;
  readonly error?: Schema.Top;
}

type ArgsOf<S extends OpSpec> = S["args"] extends Fields ? Schema.Struct<S["args"]>["Type"] : void;
type SuccessOf<S extends OpSpec> = S["success"] extends Schema.Top
  ? S["success"]["Type"]
  : S["success"] extends Fields
    ? Schema.Struct<S["success"]>["Type"]
    : void;
type ErrorOf<S extends OpSpec> = S["error"] extends Schema.Top ? S["error"]["Type"] : never;

/**
 * The service shape of an external system: one Effect-returning function per operation.
 */
export type Shape<Ops extends Record<string, OpSpec>> = {
  readonly [K in keyof Ops]: (
    args: ArgsOf<Ops[K]>,
  ) => Effect.Effect<SuccessOf<Ops[K]>, ErrorOf<Ops[K]>>;
};

/**
 * A reference to one external system operation, used by stories (`call`, `succeed`, `fail`).
 */
export interface Op<Args = unknown, Success = unknown, Error = unknown> {
  readonly kind: "ExternalSystemOp";
  readonly system: string;
  readonly op: string;
  readonly "~args"?: Args;
  readonly "~success"?: Success;
  readonly "~error"?: Error;
}

/**
 * Structural constraint satisfied by every external system class.
 */
export interface Any extends Context.Key<unknown, unknown> {
  readonly kind: "ExternalSystem";
  readonly systemName: string;
  readonly ops: Record<string, OpSpec>;
}

/** The requirement identifier of an external system class. */
export type Identifier<P extends Any> = P extends Context.Key<infer I, unknown> ? I : never;

/**
 * Type-level identity of an external system in an Effect's requirements.
 */
export interface ExternalSystemKey<Name extends string> {
  readonly "~alchemy/Domain/ExternalSystem": Name;
}

const RESERVED = new Set([
  "name",
  "length",
  "prototype",
  "kind",
  "systemName",
  "ops",
  "toLayer",
  "key",
]);

/**
 * An outside system your model calls, such as a payment provider or a fraud
 * scorer, declared as the operations the model uses. It's an Effect service:
 * policies `yield*` it, an adapter implements it with `toLayer`, and stories
 * answer its calls themselves, so the model depends on what it asks for and
 * never on a vendor.
 *
 * ### Declaring an external system and an adapter
 * **Example:** A fraud scorer
 * ```typescript
 * import * as Domain from "@alchemy.run/domain";
 * import * as Effect from "effect/Effect";
 * import * as Schema from "effect/Schema";
 *
 * export class FraudCheck extends Domain.ExternalSystem("FraudCheck", {
 *   score: { args: { accountId: Schema.String, amount: Schema.Int }, success: { risk: Schema.Number } },
 * }) {}
 *
 * export const SiftFraudCheck = FraudCheck.toLayer(
 *   Effect.succeed({
 *     score: ({ amount }) => Effect.succeed({ risk: amount >= 80_000 ? 0.95 : 0.05 }),
 *   }),
 * );
 * ```
 *
 * @primitive
 */
export const make = <const Name extends string, const Ops extends Record<string, OpSpec>>(
  name: Name,
  ops: Ops,
): ExternalSystemClass<Name, Ops> => {
  const Tag = Context.Service<ExternalSystemKey<Name>, Shape<Ops>>()(
    `alchemy/Domain/ExternalSystem/${name}`,
  );
  const cls = class extends Tag {
    static readonly kind = "ExternalSystem" as const;
    static readonly systemName: Name = name;
    static readonly ops: Ops = ops;
    /** Implement the external system with an Effect that builds its service. */
    static toLayer<E, R>(
      build: Effect.Effect<Shape<Ops>, E, R>,
    ): Layer.Layer<ExternalSystemKey<Name>, E, R> {
      return Layer.effect(
        Tag,
        Effect.map(
          build,
          (impl) => observeOps(name, recordOps(name, impl as Record<string, OpImpl>)) as never,
        ),
      );
    }
  };
  for (const op of Object.keys(ops)) {
    if (RESERVED.has(op)) {
      throw new Error(`ExternalSystem '${name}' cannot declare an operation named '${op}'`);
    }
    Object.defineProperty(cls, op, {
      value: { kind: "ExternalSystemOp", system: name, op } satisfies Op,
      enumerable: true,
    });
  }
  return cls as unknown as ExternalSystemClass<Name, Ops>;
};

/**
 * The class type returned by {@link make}.
 */
export type ExternalSystemClass<
  Name extends string,
  Ops extends Record<string, OpSpec>,
> = Context.ServiceClass<ExternalSystemKey<Name>, string, Shape<Ops>> & {
  readonly kind: "ExternalSystem";
  readonly systemName: Name;
  readonly ops: Ops;
  /** Implement the external system with an Effect that builds its service. */
  toLayer<E, R>(build: Effect.Effect<Shape<Ops>, E, R>): Layer.Layer<ExternalSystemKey<Name>, E, R>;
} & {
  readonly [K in keyof Ops]: Op<ArgsOf<Ops[K]>, SuccessOf<Ops[K]>, ErrorOf<Ops[K]>>;
};

/** @internal */
export const successSchema = (spec: OpSpec): Schema.Top =>
  spec.success === undefined
    ? Schema.Void
    : "ast" in (spec.success as object)
      ? (spec.success as Schema.Top)
      : Schema.Struct(spec.success as Fields);
