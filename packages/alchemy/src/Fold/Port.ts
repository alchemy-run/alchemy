import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { Fields } from "./Event.ts";

/**
 * One operation of a Port: its arguments, success value and business errors.
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
 * The service shape of a Port: one Effect-returning function per operation.
 */
export type Shape<Ops extends Record<string, OpSpec>> = {
  readonly [K in keyof Ops]: (
    args: ArgsOf<Ops[K]>,
  ) => Effect.Effect<SuccessOf<Ops[K]>, ErrorOf<Ops[K]>>;
};

/**
 * A reference to one Port operation, used by stories (`expectCall`, `resolve`).
 */
export interface Op<Args = unknown, Success = unknown> {
  readonly kind: "PortOp";
  readonly port: string;
  readonly op: string;
  readonly "~args"?: Args;
  readonly "~success"?: Success;
}

/**
 * Structural constraint satisfied by every port class.
 */
export interface Any extends Context.Key<unknown, unknown> {
  readonly kind: "Port";
  readonly portName: string;
  readonly ops: Record<string, OpSpec>;
}

/** The requirement identifier of a port class. */
export type Identifier<P extends Any> = P extends Context.Key<infer I, unknown> ? I : never;

/**
 * Type-level identity of a port in an Effect's requirements.
 */
export interface PortKey<Name extends string> {
  readonly "~alchemy/Fold/Port": Name;
}

const RESERVED = new Set([
  "name",
  "length",
  "prototype",
  "kind",
  "portName",
  "ops",
  "toLayer",
  "key",
]);

/**
 * Declare a Port: the interface of an external system a policy calls.
 *
 * Ports are declared with Schema so stories can intercept their calls
 * (`expectCall` / `resolve`) without mocks. Production adapters are Layers
 * built with `toLayer`.
 *
 * **Example:** Declaring a port and an adapter
 * ```typescript
 * export class FraudCheck extends Port.make("FraudCheck", {
 *   score: { args: { accountId: AccountId, amount: Cents }, success: { risk: Schema.Number } },
 * }) {}
 *
 * export const SiftFraudCheck = FraudCheck.toLayer(
 *   Effect.succeed({ score: ({ amount }) => Effect.succeed({ risk: amount > 50_000 ? 0.9 : 0.1 }) }),
 * );
 * ```
 */
export const make = <const Name extends string, const Ops extends Record<string, OpSpec>>(
  name: Name,
  ops: Ops,
): PortClass<Name, Ops> => {
  const Tag = Context.Service<PortKey<Name>, Shape<Ops>>()(`alchemy/Fold/Port/${name}`);
  const cls = class extends Tag {
    static readonly kind = "Port" as const;
    static readonly portName: Name = name;
    static readonly ops: Ops = ops;
    /** Implement the port with an Effect that builds its service. */
    static toLayer<E, R>(build: Effect.Effect<Shape<Ops>, E, R>): Layer.Layer<PortKey<Name>, E, R> {
      return Layer.effect(Tag, build);
    }
  };
  for (const op of Object.keys(ops)) {
    if (RESERVED.has(op)) {
      throw new Error(`Port '${name}' cannot declare an operation named '${op}'`);
    }
    Object.defineProperty(cls, op, {
      value: { kind: "PortOp", port: name, op } satisfies Op,
      enumerable: true,
    });
  }
  return cls as unknown as PortClass<Name, Ops>;
};

/**
 * The class type returned by {@link make}.
 */
export type PortClass<
  Name extends string,
  Ops extends Record<string, OpSpec>,
> = Context.ServiceClass<PortKey<Name>, string, Shape<Ops>> & {
  readonly kind: "Port";
  readonly portName: Name;
  readonly ops: Ops;
  /** Implement the port with an Effect that builds its service. */
  toLayer<E, R>(build: Effect.Effect<Shape<Ops>, E, R>): Layer.Layer<PortKey<Name>, E, R>;
} & {
  readonly [K in keyof Ops]: Op<ArgsOf<Ops[K]>, SuccessOf<Ops[K]>>;
};

/** @internal */
export const successSchema = (spec: OpSpec): Schema.Top =>
  spec.success === undefined
    ? Schema.Void
    : "ast" in (spec.success as object)
      ? (spec.success as Schema.Top)
      : Schema.Struct(spec.success as Fields);
