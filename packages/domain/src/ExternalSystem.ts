import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
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

/**
 * One case of a contract: call an operation with these arguments, and expect
 * a value or a declared error. Build it with {@link returns} or {@link fails}.
 */
export interface ContractCase {
  readonly kind: "ExternalSystemContractCase";
  readonly op: Op;
  readonly args: unknown;
  readonly expected:
    | { readonly _tag: "Success"; readonly check: Expectation }
    | { readonly _tag: "Failure"; readonly check: Expectation };
}

type Expectation =
  | { readonly _tag: "Any" }
  | { readonly _tag: "Tag"; readonly tag: string }
  | { readonly _tag: "Partial"; readonly value: unknown }
  | { readonly _tag: "Predicate"; readonly test: (value: unknown) => boolean | void };

/** A partial value to match, or a check that returns `false` (or throws) to reject. */
export type Expect<A> = Partial<A> | ((value: A) => boolean | void);

const expectation = (expected: unknown): Expectation =>
  expected === undefined
    ? { _tag: "Any" }
    : typeof expected === "function"
      ? { _tag: "Predicate", test: expected as (value: unknown) => boolean | void }
      : typeof expected === "string"
        ? { _tag: "Tag", tag: expected }
        : { _tag: "Partial", value: expected };

/**
 * A contract case that expects the call to return a value its success schema
 * accepts and, when given, that matches `expected`: a partial value, or a
 * check that returns `false` (or throws) to reject it.
 */
export const returns = <Args, Success>(
  op: Op<Args, Success, any>,
  args: NoInfer<Args>,
  expected?: NoInfer<Expect<Success>>,
): ContractCase => ({
  kind: "ExternalSystemContractCase",
  op,
  args,
  expected: { _tag: "Success", check: expectation(expected) },
});

/**
 * A contract case that expects the call to fail with an error its error schema
 * accepts and, when given, that matches `expected`: the error's `_tag`, a
 * partial error, or a check.
 */
export const fails = <Args, Error>(
  op: Op<Args, any, Error>,
  args: NoInfer<Args>,
  expected?: NoInfer<(Error extends { readonly _tag: infer T } ? T : never) | Expect<Error>>,
): ContractCase => ({
  kind: "ExternalSystemContractCase",
  op,
  args,
  expected: { _tag: "Failure", check: expectation(expected) },
});

/** A contract case an adapter broke. */
export class ContractFailure extends Data.TaggedError("ContractFailure")<{
  readonly system: string;
  readonly op: string;
  /** The name of the case. */
  readonly case: string;
  readonly message: string;
}> {}

const show = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

const matchesPartial = (expected: unknown, actual: unknown): boolean => {
  if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
    if (actual === null || typeof actual !== "object") return false;
    return Object.keys(expected).every((k) =>
      matchesPartial((expected as any)[k], (actual as any)[k]),
    );
  }
  return show(expected) === show(actual);
};

/**
 * One shared set of cases every implementation of an external system must
 * pass: the vendor adapter, an in-memory fake, a no-op. Each case calls one
 * operation and checks the outcome against the operation's schemas and the
 * case's expectation.
 *
 * It returns one Effect per case, keyed by the case name, that needs the
 * system. Provide each adapter's Layer and run them with your test runner.
 *
 * ```typescript
 * const SmsContract = ExternalSystem.contract(Sms, {
 *   "sends a message": ExternalSystem.returns(Sms.send, { to: "+15550100", body: "hi" }),
 *   "refuses a landline": ExternalSystem.fails(Sms.send, { to: "+15550199", body: "hi" }, "Undeliverable"),
 * });
 *
 * for (const [adapter, layer] of [["Twilio", TwilioSms], ["fake", FakeSms]] as const) {
 *   describe(`Sms contract: ${adapter}`, () => {
 *     for (const [name, test] of Object.entries(SmsContract)) {
 *       it.effect(name, () => test.pipe(Effect.provide(layer)));
 *     }
 *   });
 * }
 * ```
 */
export const contract = <S extends Any, const Names extends string>(
  system: S,
  cases: Readonly<Record<Names, ContractCase>>,
): { readonly [K in Names]: Effect.Effect<void, ContractFailure, Identifier<S>> } => {
  for (const [name, c] of Object.entries<ContractCase>(cases)) {
    if (c.op.system !== system.systemName) {
      throw new Error(
        `contract for ${system.systemName} has a case for ${c.op.system}.${c.op.op}: "${name}"`,
      );
    }
  }
  return Object.fromEntries(
    Object.entries<ContractCase>(cases).map(([name, c]) => {
      const { op } = c.op;
      const spec = system.ops[op] ?? {};
      const failure = (message: string) =>
        new ContractFailure({
          system: system.systemName,
          op,
          case: name,
          message: `${system.systemName}.${op} "${name}": ${message}`,
        });
      const conforms = (schema: Schema.Top | undefined, value: unknown, what: string) =>
        schema === undefined
          ? Effect.void
          : (
              Schema.decodeUnknownEffect(Schema.toType(schema)) as (
                value: unknown,
              ) => Effect.Effect<unknown, Schema.SchemaError>
            )(value).pipe(
              Effect.asVoid,
              Effect.mapError((error) => failure(`${what}\n${error.message}`)),
            );
      const check = (expected: Expectation, value: unknown, noun: "value" | "error") =>
        Effect.suspend(() => {
          const article = noun === "value" ? "a" : "an";
          switch (expected._tag) {
            case "Any":
              return Effect.void;
            case "Tag":
              return (value as { readonly _tag?: unknown })._tag === expected.tag
                ? Effect.void
                : Effect.fail(failure(`expected ${expected.tag}, got ${show(value)}`));
            case "Partial":
              return matchesPartial(expected.value, value)
                ? Effect.void
                : Effect.fail(
                    failure(
                      `expected ${article} ${noun} matching ${show(expected.value)}, got ${show(value)}`,
                    ),
                  );
            case "Predicate":
              return expected.test(value) === false
                ? Effect.fail(failure(`the check rejected the ${noun} ${show(value)}`))
                : Effect.void;
          }
        });
      const test = Effect.gen(function* () {
        const service = yield* system as unknown as Effect.Effect<Record<string, OpImpl>>;
        const exit = yield* Effect.exit(service[op]!(c.args));
        if (Exit.isSuccess(exit)) {
          if (c.expected._tag === "Failure") {
            return yield* failure(`expected it to fail, but it returned ${show(exit.value)}`);
          }
          yield* conforms(
            spec.success === undefined ? undefined : successSchema(spec),
            exit.value,
            "returned a value its success schema rejects",
          );
          return yield* check(c.expected.check, exit.value, "value");
        }
        const error = Cause.findErrorOption(exit.cause);
        if (error._tag === "None") {
          return yield* failure(`died with ${String(Cause.squash(exit.cause))}`);
        }
        if (c.expected._tag === "Success") {
          return yield* failure(`expected a value, but it failed with ${show(error.value)}`);
        }
        yield* conforms(
          spec.error ?? Schema.Never,
          error.value,
          "failed with an error its error schema rejects",
        );
        return yield* check(c.expected.check, error.value, "error");
      });
      return [name, test];
    }),
  ) as never;
};
