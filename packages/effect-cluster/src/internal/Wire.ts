/**
 * What crosses between a caller and an entity's object: each call as JSON,
 * its reply as JSON. A host's object RPC hides a thrown error's type, so
 * failures of the object itself come back as data too.
 *
 * @internal
 */
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { Rpc, RpcSchema } from "effect/rpc";
import * as Schema from "effect/Schema";

/** One call to an entity, as it crosses to the entity's object. */
export interface Call {
  /** The caller's id for this call: what an interrupt names. */
  readonly requestId: string;
  readonly tag: string;
  readonly payload: unknown;
  readonly headers: Record<string, string>;
}

/** A failure of the object itself, returned as data. */
export const DEFECT = "~cluster/defect";

/** A cluster error the object answered with instead of running the call. */
export interface Rejection {
  readonly _tag: "MailboxFull" | "AlreadyProcessingMessage" | "PersistenceError";
  readonly message: string;
}

/**
 * The object's answer to a call: the encoded exit of an RPC, a rejection,
 * or the object's own defect. A stream answers with one of these per frame,
 * plus `{ chunk }` frames before its exit.
 */
export type Reply =
  | { readonly exit: unknown }
  | { readonly rejected: Rejection }
  | { readonly [DEFECT]: string };

export type Frame = Reply | { readonly chunk: ReadonlyArray<unknown> };

export const json = <S extends Schema.Top>(schema: S) =>
  Schema.toCodecJson(schema) as unknown as Schema.Codec<unknown, unknown>;

export const payloadCodec = (rpc: Rpc.AnyWithProps) => json(rpc.payloadSchema);
export const exitCodec = (rpc: Rpc.AnyWithProps) => json(Rpc.exitSchema(rpc as Rpc.Any));
export const chunkCodec = (rpc: Rpc.AnyWithProps) =>
  json(RpcSchema.isStreamSchema(rpc.successSchema) ? rpc.successSchema.success : Schema.Unknown);

export const encode = (codec: Schema.Codec<unknown, unknown>, value: unknown) =>
  Schema.encodeUnknownEffect(codec)(value).pipe(Effect.orDie);
export const decode = (codec: Schema.Codec<unknown, unknown>, value: unknown) =>
  Schema.decodeUnknownEffect(codec)(value).pipe(Effect.orDie);

/**
 * An RPC's exit, encoded. A stream's exit carries no value. An exit its
 * schema can't encode (a defect that isn't JSON) is sent as a defect with
 * its message.
 */
export const encodeExit = (rpc: Rpc.AnyWithProps, exit: Exit.Exit<unknown, unknown>) =>
  Schema.encodeUnknownEffect(exitCodec(rpc))(
    RpcSchema.isStreamSchema(rpc.successSchema) ? Exit.asVoid(exit) : exit,
  ).pipe(
    Effect.catchCause(() =>
      Schema.encodeUnknownEffect(exitCodec(rpc))(
        Exit.die(Exit.isFailure(exit) ? String(exit.cause) : "unencodable exit"),
      ),
    ),
    Effect.orDie,
  );

/** `(type, id)` as one object name, length-prefixed like Effect's: `7:Counter` + id. */
export const entityObjectName = (type: string, id: string) => `${type.length}:${type}${id}`;

export const parseEntityObjectName = (name: string) => {
  const colon = name.indexOf(":");
  const length = Number(name.slice(0, colon));
  return {
    type: name.slice(colon + 1, colon + 1 + length),
    id: name.slice(colon + 1 + length),
  };
};
