import type { RpcCompatible } from "capnweb";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { flow } from "effect/Function";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeUtil from "node:util";
import * as Output from "../Output.ts";

type RpcHandler<Args extends Array<any>, Success, Error> = (
  ...args: Args
) => Effect.Effect<Success, Error>;
type SerializedRpcHandler<Args extends Array<any>, Success, Error> = (
  args: Args,
) => Promise<SerializedExit<Success, Error>>;
type RpcStreamHandler<Args extends Array<any>, Success, Error> = (
  ...args: Args
) => Stream.Stream<Success, Error>;
type SerializedRpcStreamHandler<Args extends Array<any>, Success, Error> = (
  args: Args,
) => ReadableStream<Success>;

export type SerializedRpc<T> =
  T extends RpcHandler<infer Args, infer Success, infer Error>
    ? SerializedRpcHandler<Args, Success, Error>
    : T extends RpcStreamHandler<infer Args, infer Success, infer Error>
      ? SerializedRpcStreamHandler<Args, Success, Error>
      : T;

type SerializedExit<Success, Error> =
  | { _tag: "Success"; value: Success }
  | {
      _tag: "Failure";
      cause: Array<SerializedCause<Error>>;
    };

type SerializedCause<Error> =
  | { _tag: "Fail"; error: Error }
  | { _tag: "Die"; defect: unknown }
  | { _tag: "Interrupt"; fiberId: number | undefined };

const encodeError = Schema.encodeSync(Schema.Defect);

export type RpcHandlers = Record<string, RpcHandler<any, any, any> | undefined>;

export type SerializedRpcHandlers<T extends RpcHandlers> = {
  [K in keyof T]: T[K] extends RpcHandler<
    infer Args,
    infer Success,
    infer Error
  >
    ? SerializedRpcHandler<Args, Success, Error>
    : T[K] extends RpcStreamHandler<infer Args, infer Success, infer Error>
      ? SerializedRpcStreamHandler<Args, Success, Error>
      : never;
} extends infer O extends object & RpcCompatible<O>
  ? O
  : never;

export const serializeRpcStreamHandler = <
  Args extends Array<any>,
  Success,
  Error,
>(
  handler: RpcStreamHandler<Args, Success, Error>,
): SerializedRpcStreamHandler<Args, Success, Error> =>
  flow(
    (args): Args => encodeRpcArgs(args) as Args,
    (args) => handler(...args),
    (stream) => Stream.toReadableStream(stream),
  );

export const deserializeRpcStreamHandler = <
  Args extends Array<any>,
  Success,
  Error,
>(
  handler: SerializedRpcStreamHandler<Args, Success, Error>,
): RpcStreamHandler<Args, Success, Error> =>
  flow(
    (...args): Args => decodeRpcArgs(args) as Args,
    (args) => handler(args),
    (stream) =>
      Stream.fromReadableStream({
        evaluate: () => stream,
        onError: (error) => error as Error,
      }),
  );

export const serializeRpcHandlers = <T extends RpcHandlers>(
  handlers: T,
): SerializedRpcHandlers<T> =>
  Object.fromEntries(
    Object.entries(handlers).map(([key, value]) => [
      key,
      value ? encodeRpcHandler(value) : undefined,
    ]),
  ) as SerializedRpcHandlers<T>;

export const deserializeRpcHandlers = <T extends RpcHandlers>(
  handlers: SerializedRpcHandlers<T>,
): T =>
  Object.fromEntries(
    Object.entries(handlers).map(([key, value]) => [
      key,
      value ? decodeRpcHandler(value) : undefined,
    ]),
  ) as T;

export const encodeRpcHandler = <Args extends Array<any>, Success, Error>(
  handler: RpcHandler<Args, Success, Error>,
): SerializedRpcHandler<Args, Success, Error> =>
  flow(
    (args): Args => decodeRpcArgs(args) as Args,
    (args) => handler(...args),
    encodeRpcResult<Success, Error>,
  );

export const decodeRpcHandler = <Args extends Array<any>, Success, Error>(
  handler: SerializedRpcHandler<Args, Success, Error>,
): RpcHandler<Args, Success, Error> =>
  flow(
    (...args): Args => encodeRpcArgs(args) as Args,
    (args) => handler(args),
    decodeRpcResult<Success, Error>,
  );

export const encodeRpcResult = <Success, Error>(
  self: Effect.Effect<Success, Error>,
): Promise<SerializedExit<Success, Error>> =>
  self.pipe(
    Effect.exit,
    Effect.map((exit): SerializedExit<Success, Error> => {
      if (exit._tag === "Success") {
        return { _tag: "Success", value: exit.value };
      }
      return {
        _tag: "Failure",
        cause: exit.cause.reasons.map((reason): SerializedCause<Error> => {
          switch (reason._tag) {
            case "Fail":
              return { _tag: "Fail", error: encodeError(reason.error) };
            case "Die":
              return { _tag: "Die", defect: encodeError(reason.defect) };
            case "Interrupt":
              return { _tag: "Interrupt", fiberId: reason.fiberId };
          }
        }),
      };
    }),
    Effect.runPromise,
  );

export const decodeRpcResult = <Success, Error>(
  self: Promise<SerializedExit<Success, Error>>,
): Effect.Effect<Success, Error> =>
  Effect.promise(() => self).pipe(
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

export const encodeRpcArgs = (value: unknown): unknown => {
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

export const decodeRpcArgs = (value: unknown): unknown => {
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
