import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";
import * as Binding from "../../Binding.ts";
import * as Namespace from "../../Namespace.ts";
import { ServerHost } from "../../Server/Process.ts";
import { decodeWithSchema } from "./K2Codec.ts";
import type { ConsumedRecord, DecodedRecord, RecordSchema, StartAt } from "./K2Types.ts";
import { ReadSubscription } from "./ReadSubscription.ts";
import type { Stream as K2Stream } from "./Stream.ts";
import { pollSubscription } from "./StreamPoller.ts";
import { Subscription } from "./Subscription.ts";

/** Settings for {@link consumeStreamRecords}. */
export interface ConsumeStreamRecordsProps {
  /**
   * Read through this subscription. Hosts sharing one subscription compete
   * for batches. When omitted, a subscription owned by the consuming host is
   * created, so every host reads every record.
   */
  subscription?: Subscription;
  /**
   * Where the auto-created subscription starts reading. Ignored when
   * `subscription` is passed.
   * @default "latest"
   */
  startAt?: StartAt;
  /**
   * At most this many records per batch, from 1 to 10000.
   * @default 100
   */
  maxRecords?: number;
  /**
   * Number of concurrent pollers in this process, each with its own worker
   * id (and lease).
   * @default 1
   */
  concurrency?: number;
  /**
   * How long to wait after an empty batch (or a failed poll) before polling
   * again.
   * @default "1 second"
   */
  idleBackoff?: Duration.Input;
  /**
   * Prefix of the pollers' worker ids. Must be unique per process.
   * @default `${hostLogicalId}-${random}`
   */
  workerId?: string;
}

/** {@link ConsumeStreamRecordsProps} with a schema decoding JSON content into `record.value`. */
export interface ConsumeStreamRecordsSchemaProps<A> extends ConsumeStreamRecordsProps {
  schema: RecordSchema<A>;
}

type Handler<Rec, Req> = (records: Stream.Stream<Rec>) => Effect.Effect<void, unknown, Req>;

export type StreamEventSourceService = (
  stream: K2Stream,
  props: ConsumeStreamRecordsProps & { schema?: RecordSchema<any> },
  process: Handler<any, any>,
) => Effect.Effect<void, never, never>;

/**
 * Event source connecting a K2 {@link Stream} to the hosting compute. The
 * only implementation is {@link StreamEventSourcePolling}, a pull loop for
 * long-running hosts. Consume it through {@link consumeStreamRecords}.
 *
 * :::note
 * TODO: Workers cannot consume K2 yet — K2 has no push consumers (they are
 * on Cloudflare's roadmap), so no Worker layer ships.
 * :::
 */
export class StreamEventSource extends Context.Service<
  StreamEventSource,
  StreamEventSourceService
>()("Cloudflare.K2.StreamEventSource") {}

/**
 * Subscribe a long-running host to a K2 stream with an Effect stream
 * handler.
 *
 * - **Deploy-time**: creates a {@link Subscription} owned by the host
 *   (unless `subscription` is passed — hosts sharing one compete for
 *   batches).
 * - **Runtime**: `concurrency` pollers lease batches of records, run the
 *   handler, and acknowledge each batch when the handler succeeds. A failed
 *   handler is logged and the batch is released for redelivery. Leases are
 *   extended every two minutes while the handler runs.
 *
 * Provide {@link StreamEventSourcePolling} together with a
 * `ReadSubscription` implementation (`ReadSubscriptionHttp` on a deployed
 * host). It runs on hosts with a long-lived process — Fly, ECS, EC2,
 * Railway, Hetzner, Docker.
 *
 * :::note
 * TODO: Workers cannot consume K2 yet — K2 has no push consumers (they are
 * on Cloudflare's roadmap), so no Worker layer ships.
 * :::
 * ### Consuming a Stream
 * **Example:** Log every record
 * ```typescript
 * yield* Cloudflare.K2.consumeStreamRecords(Orders, (records) =>
 *   records.pipe(
 *     Stream.runForEach((record) =>
 *       Effect.log(new TextDecoder().decode(record.content)),
 *     ),
 *   ),
 * );
 * ```
 *
 * ### Typed Records
 * **Example:** Decode JSON records with a Schema
 * ```typescript
 * yield* Cloudflare.K2.consumeStreamRecords(
 *   Orders,
 *   { schema: Order, startAt: "earliest", concurrency: 4 },
 *   (records) =>
 *     records.pipe(Stream.runForEach((record) => Effect.log(record.value.id))),
 * );
 * ```
 *
 * ### Providing the Layers
 * **Example:** Poll from a container host
 * ```typescript
 * Effect.gen(function* () {
 *   yield* Cloudflare.K2.consumeStreamRecords(Orders, handler);
 * }).pipe(
 *   Effect.provide(
 *     Layer.provideMerge(
 *       Cloudflare.K2.StreamEventSourcePolling,
 *       Cloudflare.K2.ReadSubscriptionHttp,
 *     ),
 *   ),
 * );
 * ```
 *
 * @binding
 * @product K2
 * @category Storage & Databases
 */
export function consumeStreamRecords<Req = never>(
  stream: K2Stream,
  process: Handler<ConsumedRecord, Req>,
): Effect.Effect<void, never, StreamEventSource>;
export function consumeStreamRecords<A, Req = never>(
  stream: K2Stream,
  props: ConsumeStreamRecordsSchemaProps<A>,
  process: Handler<DecodedRecord<A>, Req>,
): Effect.Effect<void, never, StreamEventSource>;
export function consumeStreamRecords<Req = never>(
  stream: K2Stream,
  props: ConsumeStreamRecordsProps,
  process: Handler<ConsumedRecord, Req>,
): Effect.Effect<void, never, StreamEventSource>;
export function consumeStreamRecords(
  stream: K2Stream,
  propsOrProcess: (ConsumeStreamRecordsProps & { schema?: RecordSchema<any> }) | Handler<any, any>,
  maybeProcess?: Handler<any, any>,
): Effect.Effect<void, never, StreamEventSource> {
  const [props, process] =
    typeof propsOrProcess === "function"
      ? [{} as ConsumeStreamRecordsProps, propsOrProcess]
      : [propsOrProcess, maybeProcess!];
  return StreamEventSource.use((source) => source(stream, props, process));
}

/**
 * Polling implementation of {@link StreamEventSource} for hosts with a
 * long-lived process (any host providing `ServerHost`: Fly, ECS, EC2,
 * Railway, Hetzner, Docker). Requires a `ReadSubscription` implementation.
 *
 * :::note
 * TODO: Workers cannot consume K2 yet — K2 has no push consumers (they are
 * on Cloudflare's roadmap), so no Worker layer ships.
 * :::
 * ### Providing the Layer
 * **Example:** Poll with a scoped token
 * ```typescript
 * Effect.gen(function* () {
 *   yield* Cloudflare.K2.consumeStreamRecords(Orders, handler);
 * }).pipe(
 *   Effect.provide(
 *     Layer.provideMerge(
 *       Cloudflare.K2.StreamEventSourcePolling,
 *       Cloudflare.K2.ReadSubscriptionHttp,
 *     ),
 *   ),
 * );
 * ```
 *
 * @layer
 * @provides Cloudflare.K2.StreamEventSource
 * @product K2
 * @category Storage & Databases
 */
export const StreamEventSourcePolling = Layer.effect(
  StreamEventSource,
  Effect.gen(function* () {
    const { run } = yield* ServerHost;
    const readSubscription = yield* ReadSubscription;

    return Effect.fn(function* (
      stream: K2Stream,
      props: ConsumeStreamRecordsProps & { schema?: RecordSchema<any> },
      process: Handler<any, any>,
    ) {
      const host = yield* Binding.Host;
      const hostId = host?.LogicalId ?? "Host";
      // Declared in both phases: at runtime the declaration resolves to the
      // deployed subscription's outputs, which the client reads.
      const subscription =
        props.subscription ??
        (yield* Namespace.push(
          hostId,
          Subscription(`${stream.LogicalId}Subscription`, {
            streamId: stream.streamId,
            startAt: props.startAt,
          }),
        ));
      const client = yield* readSubscription(subscription);
      const decode = props.schema
        ? decodeWithSchema(props.schema)
        : (records: ReadonlyArray<ConsumedRecord>) => Effect.succeed(records);

      yield* run(
        Effect.gen(function* () {
          const workerId =
            props.workerId ??
            `${hostId}-${(yield* Effect.sync(() => crypto.randomUUID())).slice(0, 8)}`;
          yield* pollSubscription({
            client,
            workerId,
            maxRecords: props.maxRecords,
            idleBackoff: props.idleBackoff,
            concurrency: props.concurrency,
            decode,
            process,
          });
        }),
      );
    }) as StreamEventSourceService;
  }),
);
