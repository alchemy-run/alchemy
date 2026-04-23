import type { RpcCompatible } from "capnweb";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

type RpcHandler<Args extends Array<any>, Success, Error> = (
  ...args: Args
) => Effect.Effect<Success, Error>;

type SerializedRpcHandler<Args extends Array<any>, Success, Error> = (
  ...args: Args
) => Promise<SerializedExit<RpcCompatible<Success>, RpcCompatible<Error>>>;

type SerializedCause<Error> =
  | { _tag: "Fail"; error: Error }
  | { _tag: "Die"; defect: unknown }
  | { _tag: "Interrupt"; fiberId: number | undefined };

type SerializedExit<Success, Error> =
  | { _tag: "Success"; value: Success }
  | {
      _tag: "Failure";
      cause: Array<SerializedCause<Error>>;
    };

export type RpcHandlers = Record<string, RpcHandler<any, any, any>>;

export type SerializedRpcHandlers<T extends RpcHandlers> = {
  [K in keyof T]: T[K] extends RpcHandler<
    infer Args,
    infer Success,
    infer Error
  >
    ? SerializedRpcHandler<Args, Success, Error>
    : never;
} extends infer O extends object & RpcCompatible<O>
  ? O
  : never;

type RpcHandlerEncoder<Success, Error> = {
  success: Schema.Encoder<Success>;
  error: Schema.Encoder<Error>;
};

export type RpcHandlerEncoders<T extends RpcHandlers> = {
  [K in keyof T]: T[K] extends RpcHandler<any, infer Success, infer Error>
    ? RpcHandlerEncoder<Success, Error>
    : never;
};

type RpcHandlerDecoder<Success, Error> = {
  success: Schema.Decoder<Success>;
  error: Schema.Decoder<Error>;
};

export type RpcHandlerDecoders<T extends RpcHandlers> = {
  [K in keyof T]: T[K] extends RpcHandler<any, infer Success, infer Error>
    ? RpcHandlerDecoder<Success, Error>
    : never;
};

const serializeRpcHandler =
  <Args extends Array<any>, Success, Error>(
    handler: RpcHandler<Args, Success, Error>,
    schema: RpcHandlerEncoder<Success, Error>,
  ): SerializedRpcHandler<Args, Success, Error> =>
  (...args) =>
    handler(...args).pipe(
      Effect.exit,
      Effect.map((exit): SerializedExit<Success, Error> => {
        if (exit._tag === "Success") {
          return {
            _tag: "Success",
            value: Schema.encodeSync(schema.success)(exit.value),
          } as const;
        }
        return {
          _tag: "Failure",
          cause: exit.cause.reasons.map((reason): SerializedCause<Error> => {
            switch (reason._tag) {
              case "Fail":
                return {
                  _tag: "Fail",
                  error: Schema.encodeSync(schema.error)(reason.error),
                };
              case "Die":
                return {
                  _tag: "Die",
                  defect: Schema.encodeSync(Schema.DefectWithStack)(
                    reason.defect,
                  ),
                };
              case "Interrupt":
                return { _tag: "Interrupt", fiberId: reason.fiberId };
            }
          }),
        } as const;
      }),
      Effect.runPromise,
    );

export const serializeRpcHandlers = <T extends RpcHandlers>(
  handlers: T,
  schema: RpcHandlerEncoders<T>,
): SerializedRpcHandlers<T> =>
  Object.fromEntries(
    Object.entries(schema).map(([key, schema]) => [
      key,
      serializeRpcHandler(handlers[key], schema),
    ]),
  ) as SerializedRpcHandlers<T>;

const deserializeRpcHandler =
  <Args extends Array<any>, Success, Error>(
    handler: SerializedRpcHandler<Args, Success, Error>,
    schema: RpcHandlerDecoder<Success, Error>,
  ): RpcHandler<Args, Success, Error> =>
  (...args) =>
    Effect.promise(async () => {
      try {
        return await handler(...args);
      } catch (error) {
        console.error("Error calling handler", error);
        throw error;
      }
    }).pipe(
      Effect.map((exit): Exit.Exit<Success, Error> => {
        if (exit._tag === "Success") {
          return Exit.succeed(Schema.decodeSync(schema.success)(exit.value));
        }
        return Exit.failCause(
          Cause.fromReasons(
            exit.cause.map((reason): Cause.Reason<Error> => {
              switch (reason._tag) {
                case "Fail":
                  return Cause.makeFailReason(
                    Schema.decodeSync(schema.error)(reason.error),
                  );
                case "Die":
                  return Cause.makeDieReason(
                    Schema.decodeSync(Schema.DefectWithStack)(reason.defect),
                  );
                case "Interrupt":
                  return Cause.makeInterruptReason(reason.fiberId);
              }
            }),
          ),
        );
      }),
      Effect.flatMap((exit) => exit),
    );

export const deserializeRpcHandlers = <T extends RpcHandlers>(
  handlers: SerializedRpcHandlers<T>,
  schema: RpcHandlerDecoders<T>,
): T =>
  Object.fromEntries(
    Object.entries(schema).map(([key, schema]) => [
      key,
      deserializeRpcHandler(handlers[key as never], schema),
    ]),
  ) as T;

export const defineSchema = <T extends RpcHandlers>(schema: {
  [K in keyof T]: T[K] extends RpcHandler<any, infer Success, infer Error>
    ? { success: Schema.Codec<Success, any>; error: Schema.Codec<Error, any> }
    : never;
}) => schema as RpcHandlerEncoders<T> & RpcHandlerDecoders<T>;
