import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { flow } from "effect/Function";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeUtil from "node:util";
import * as Output from "../Output.ts";

export declare namespace Rpc {
  type EffectHandler<Args extends Array<any>, Success, Error> = (
    ...args: Args
  ) => Effect.Effect<Success, Error>;

  type SerializedEffectHandler<Args extends Array<any>, Success, Error> = (
    args: Args,
  ) => Promise<SerializedExit<Success, Error>>;

  type StreamHandler<Args extends Array<any>, Success, Error> = (
    ...args: Args
  ) => Stream.Stream<Success, Error>;

  type SerializedStreamHandler<Args extends Array<any>, Success, Error> = (
    args: Args,
  ) => SerializedStream<Success, Error>;

  type SerializedStream<Success, _Error> = ReadableStream<Success>;

  type SerializedExit<Success, Error> =
    | { _tag: "Success"; value: Success }
    | { _tag: "Failure"; cause: Array<SerializedCause<Error>> };

  type SerializedCause<Error> =
    | { _tag: "Fail"; error: Error }
    | { _tag: "Die"; defect: unknown }
    | { _tag: "Interrupt"; fiberId: number | undefined };

  type ToSerialized<T> =
    T extends EffectHandler<infer Args, infer Success, infer Error>
      ? SerializedEffectHandler<Args, Success, Error>
      : T extends StreamHandler<infer Args, infer Success, infer Error>
        ? SerializedStreamHandler<Args, Success, Error>
        : T;

  type FromSerialized<T> =
    T extends SerializedEffectHandler<infer Args, infer Success, infer Error>
      ? EffectHandler<Args, Success, Error>
      : T extends SerializedStreamHandler<
            infer Args,
            infer Success,
            infer Error
          >
        ? StreamHandler<Args, Success, Error>
        : T;

  type ToSerializedRecord<T extends Record<string, any>> = {
    [K in keyof T]: ToSerialized<T[K]>;
  };

  type FromSerializedRecord<T extends Record<string, any>> = {
    [K in keyof T]: FromSerialized<T[K]>;
  };
}

export const serializeRpcHandlers = <T extends Record<string, any>>(
  handlers: T,
  streamKeys?: Array<keyof T>,
): Rpc.ToSerializedRecord<T> => {
  return Object.fromEntries(
    Object.entries(handlers).map(([key, value]) => [
      key,
      typeof value === "function"
        ? streamKeys?.includes(key)
          ? serializeRpcStreamHandler(value)
          : serializeRpcEffectHandler(value)
        : typeof value === "object" && value !== null
          ? serializeRpcHandlers(value)
          : value,
    ]),
  ) as Rpc.ToSerializedRecord<T>;
};

export const deserializeRpcHandlers = <T extends Record<string, any>>(
  handlers: Rpc.ToSerializedRecord<T>,
  streamKeys?: Array<keyof T>,
): Rpc.FromSerializedRecord<T> => {
  return Object.fromEntries(
    Object.entries(handlers).map(([key, value]) => [
      key,
      typeof value === "function"
        ? streamKeys?.includes(key)
          ? deserializeRpcStreamHandler(value)
          : deserializeRpcEffectHandler(value)
        : typeof value === "object" && value !== null
          ? deserializeRpcHandlers(value)
          : value,
    ]),
  ) as Rpc.FromSerializedRecord<T>;
};

const serializeError = Schema.encodeSync(Schema.Defect);

export const serializeRpcEffectHandler = <
  Args extends Array<any>,
  Success,
  Error,
>(
  handler: Rpc.EffectHandler<Args, Success, Error>,
): Rpc.SerializedEffectHandler<Args, Success, Error> =>
  flow(
    (args): Args => decodeRpcArgs(args) as Args,
    (args) => handler(...args),
    Effect.exit,
    Effect.map((exit): Rpc.SerializedExit<Success, Error> => {
      if (exit._tag === "Success") {
        return { _tag: "Success", value: exit.value };
      }
      return {
        _tag: "Failure",
        cause: exit.cause.reasons.map((reason): Rpc.SerializedCause<Error> => {
          switch (reason._tag) {
            case "Fail":
              return { _tag: "Fail", error: serializeError(reason.error) };
            case "Die":
              return { _tag: "Die", defect: serializeError(reason.defect) };
            case "Interrupt":
              return { _tag: "Interrupt", fiberId: reason.fiberId };
          }
        }),
      };
    }),
    Effect.runPromise,
  );

export const serializeRpcStreamHandler = <
  Args extends Array<any>,
  Success,
  Error,
>(
  handler: Rpc.StreamHandler<Args, Success, Error>,
): Rpc.SerializedStreamHandler<Args, Success, Error> =>
  flow(
    (args): Args => decodeRpcArgs(args) as Args,
    (args) => handler(...args),
    (stream) => Stream.toReadableStream(stream),
  );

export const deserializeRpcEffectHandler = <
  Args extends Array<any>,
  Success,
  Error,
>(
  handler: Rpc.SerializedEffectHandler<Args, Success, Error>,
): Rpc.EffectHandler<Args, Success, Error> =>
  flow(
    (...args): Args => encodeRpcArgs(args) as Args,
    (args) => Effect.promise(() => handler(args)),
    Effect.flatMap((exit): Exit.Exit<Success, Error> => {
      if (exit._tag === "Success") {
        return Exit.succeed(exit.value);
      }
      return Exit.failCause(
        Cause.fromReasons(
          exit.cause.map((reason): Cause.Reason<Error> => {
            switch (reason._tag) {
              case "Fail":
                return Cause.makeFailReason(reason.error);
              case "Die":
                return Cause.makeDieReason(reason.defect);
              case "Interrupt":
                return Cause.makeInterruptReason(reason.fiberId);
            }
          }),
        ),
      );
    }),
  );

export const deserializeRpcStreamHandler = <
  Args extends Array<any>,
  Success,
  Error,
>(
  handler: Rpc.SerializedStreamHandler<Args, Success, Error>,
): Rpc.StreamHandler<Args, Success, Error> =>
  flow(
    (...args): Args => encodeRpcArgs(args) as Args,
    (args) => handler(args),
    (stream) =>
      Stream.fromReadableStream({
        evaluate: () => stream,
        onError: (error) => error as Error,
      }),
  );

const encodeRpcArgs = (value: unknown): unknown => {
  if (Redacted.isRedacted(value)) {
    return { _tag: "Redacted", value: Redacted.value(value) };
  }
  if (Output.isOutput(value)) {
    return {
      _tag: "Output",
      description: NodeUtil.inspect(value),
    };
  }
  if (Array.isArray(value)) {
    return value.map(encodeRpcArgs);
  }
  if (value && typeof value === "object" && !("toJSON" in value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, encodeRpcArgs(child)]),
    );
  }
  return value;
};

const decodeRpcArgs = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(decodeRpcArgs);
  } else if (typeof value === "object" && value !== null) {
    if ("_tag" in value && value._tag === "Redacted" && "value" in value) {
      return Redacted.make(value.value);
    } else if (
      "_tag" in value &&
      value._tag === "Output" &&
      "description" in value &&
      typeof value.description === "string"
    ) {
      return new Output.NamedExpr(
        new Output.EffectExpr(Output.VoidExpr, () => Effect.never),
        value.description,
      );
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, decodeRpcArgs(child)]),
    );
  }
  return value;
};
