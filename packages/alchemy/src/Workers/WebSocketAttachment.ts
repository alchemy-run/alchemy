import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const rpcKey = "__alchemyRpcWebSocket";
const applicationKey = "__alchemyWebSocketAttachment";

/** An attachment codec or native persistence operation failed. */
export class WebSocketAttachmentError extends Data.TaggedError(
  "WebSocketAttachmentError",
)<{
  readonly reason: "encode" | "decode" | "missing" | "read" | "write";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface AttachmentMethods {
  /** Encode and persist an application attachment without replacing RPC metadata. */
  setAttachment<S extends Schema.Constraint>(
    schema: S,
    value: NoInfer<S["Type"]>,
  ): Effect.Effect<void, WebSocketAttachmentError, S["EncodingServices"]>;
  /** Decode a retained attachment. Applications own schema migration policy. */
  getAttachment<S extends Schema.Constraint>(
    schema: S,
  ): Effect.Effect<S["Type"], WebSocketAttachmentError, S["DecodingServices"]>;
  serializeAttachment<T>(value: T): void;
  deserializeAttachment<T>(): T | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Distinguish fresh attachments from an invalid reserved recovery envelope. */
export const hasRpcMetadata = (value: unknown): boolean =>
  isRecord(value) && Object.hasOwn(value, rpcKey);

/** Raw reserved metadata, for native RPC transport adapters only. */
export const readRpcMetadata = (value: unknown): unknown =>
  isRecord(value) ? value[rpcKey] : undefined;

/** Preserve existing application attachments while updating recovery metadata. */
export const writeRpcMetadata = (
  value: unknown,
  metadata: unknown,
): unknown => {
  if (isRecord(value) && Object.hasOwn(value, rpcKey)) {
    return { ...value, [rpcKey]: metadata };
  }
  return { [rpcKey]: metadata, [applicationKey]: value };
};

const readApplication = (value: unknown): unknown => {
  if (!isRecord(value) || !Object.hasOwn(value, rpcKey)) return value;
  if (Object.hasOwn(value, applicationKey)) return value[applicationKey];
  // Older RPC attachments stored application fields beside metadata.
  const { [rpcKey]: _, ...application } = value;
  return Object.keys(application).length === 0 ? null : application;
};

/** Native structured-clone or JSON persistence is supplied by the provider. */
export const makeAttachmentMethods = (storage: {
  readonly read: () => unknown;
  readonly write: (value: unknown) => void;
}): AttachmentMethods => {
  const read = () => readApplication(storage.read());
  const write = (value: unknown) => {
    const previous = storage.read();
    storage.write(
      isRecord(previous) && Object.hasOwn(previous, rpcKey)
        ? { [rpcKey]: previous[rpcKey], [applicationKey]: value }
        : value,
    );
  };
  return {
    serializeAttachment: write,
    deserializeAttachment: <T>() => read() as T | null,
    setAttachment: (schema, value) =>
      Schema.encodeEffect(schema)(value).pipe(
        Effect.mapError(
          (cause) =>
            new WebSocketAttachmentError({
              reason: "encode",
              message: "Could not encode WebSocket attachment",
              cause,
            }),
        ),
        Effect.flatMap((encoded) =>
          Effect.try({
            try: () => write(encoded),
            catch: (cause) =>
              new WebSocketAttachmentError({
                reason: "write",
                message: "Could not write WebSocket attachment",
                cause,
              }),
          }),
        ),
      ),
    getAttachment: (schema) =>
      Effect.try({
        try: read,
        catch: (cause) =>
          new WebSocketAttachmentError({
            reason: "read",
            message: "Could not read WebSocket attachment",
            cause,
          }),
      }).pipe(
        Effect.flatMap((encoded) =>
          encoded === null || encoded === undefined
            ? Effect.fail(
                new WebSocketAttachmentError({
                  reason: "missing",
                  message: "WebSocket attachment is missing",
                }),
              )
            : Schema.decodeUnknownEffect(schema)(encoded).pipe(
                Effect.mapError(
                  (cause) =>
                    new WebSocketAttachmentError({
                      reason: "decode",
                      message: "Could not decode WebSocket attachment",
                      cause,
                    }),
                ),
              ),
        ),
      ),
  };
};
