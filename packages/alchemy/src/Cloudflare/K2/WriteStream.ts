import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type {
  EncodedRecord,
  K2SchemaError,
  ProduceError,
  Record as K2Record,
  RecordSchema,
} from "./K2Types.ts";
import type { Stream } from "./Stream.ts";

/** Options accepted by `WriteStream(stream, options)` and `StreamSink(stream, options)`. */
export interface WriteStreamOptions<A> {
  /**
   * Encode every value with this schema and send it as JSON with a
   * `content-type: application/json` header. Without a schema, `send`
   * takes raw {@link K2Record}s.
   */
  schema: RecordSchema<A>;
}

/**
 * Binding service that turns a K2 {@link Stream} into a typed
 * {@link WriteStreamClient} you can call from a Worker's (or any host's)
 * runtime Effect.
 *
 * `send` appends a batch of records atomically: all of them are stored, or
 * none. A batch can be at most 5 MB and each record at most 1 MB.
 * ### Sending Records
 * **Example:** Producer route
 * ```typescript
 * const orders = yield* Cloudflare.K2.WriteStream(Orders);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     yield* orders.send([
 *       { content: JSON.stringify({ id: 1 }), headers: { source: "api" } },
 *       { content: new Uint8Array([1, 2, 3]) },
 *     ]);
 *     return HttpServerResponse.empty({ status: 202 });
 *   }),
 * };
 * ```
 *
 * ### Typed Records
 * **Example:** Encode values with a Schema
 * ```typescript
 * const Order = Schema.Struct({ id: Schema.Number, total: Schema.Number });
 * const orders = yield* Cloudflare.K2.WriteStream(Orders, { schema: Order });
 * // JSON-encoded, sent with `content-type: application/json`
 * yield* orders.send([{ id: 1, total: 42 }]);
 * ```
 *
 * ### Handling Errors
 * **Example:** Retry only when the batch was not stored
 * ```typescript
 * yield* orders.send(records).pipe(
 *   // K2Unavailable: the batch was NOT stored. Never retry
 *   // K2AppendOutcomeUnknown — the batch may have been stored.
 *   Effect.retry({
 *     while: (e) => e._tag === "K2Unavailable",
 *     times: 3,
 *   }),
 * );
 * ```
 *
 * Provide {@link WriteStreamBinding} (native `k2` Worker binding),
 * {@link WriteStreamHttp} (scoped `K2 Produce` token over the stream's HTTP
 * input) or {@link WriteStreamLocal} (current credentials, for Actions).
 *
 * @binding
 * @product K2
 * @category Storage & Databases
 */
export interface WriteStream extends Binding.Service<
  WriteStream,
  "Cloudflare.K2.WriteStream",
  (stream: Stream, options?: WriteStreamOptions<any>) => Effect.Effect<WriteStreamClient<any>>
> {
  <A>(
    stream: Stream,
    options: WriteStreamOptions<A>,
  ): Effect.Effect<WriteStreamClient<A>, never, WriteStream>;
  (stream: Stream): Effect.Effect<WriteStreamClient<K2Record>, never, WriteStream>;
}

export const WriteStream = Binding.Service<WriteStream>("Cloudflare.K2.WriteStream");

/**
 * Producer client for a K2 stream. `A` is {@link K2Record} without a
 * schema, or the schema's type with one.
 */
export interface WriteStreamClient<A> {
  /** Append a batch of records atomically. */
  send(records: ReadonlyArray<A>): Effect.Effect<void, ProduceError, RuntimeContext>;
  /** Encode values into the bytes + headers shape `sendEncoded` accepts. */
  encode(records: ReadonlyArray<A>): Effect.Effect<ReadonlyArray<EncodedRecord>, K2SchemaError>;
  /** Append already-encoded records atomically. */
  sendEncoded(
    records: ReadonlyArray<EncodedRecord>,
  ): Effect.Effect<void, ProduceError, RuntimeContext>;
}
