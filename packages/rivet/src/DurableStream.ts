import * as Output from "alchemy/Output";
import { RuntimeContext, sanitizeKey } from "alchemy/RuntimeContext";
import type * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Effectable from "effect/Effectable";
import { Base64 } from "effect/encoding";
import * as Sse from "effect/encoding/Sse";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { gatewaySend } from "./internal/Gateway.ts";
import { Services, SERVICES_POOL } from "./Services.ts";
import {
  StreamFormat,
  type MessageSchema,
  type StreamFormatError,
  type StreamFormatShape,
} from "./StreamFormat.ts";

export interface DurableStreamProps<A> {
  /** The Schema every message is written and read with. */
  schema: MessageSchema<A>;
  /**
   * Delete a stream after this long with no reads or writes. Set when the
   * stream is created; leave both this and {@link expiresAt} unset to keep
   * it until it's deleted.
   */
  ttl?: Duration.Input;
  /** Delete a stream at this time. Set when the stream is created. */
  expiresAt?: Date;
  /**
   * This stream's format, when it differs from the one provided to the
   * runtime: a `StreamFormat` Layer, such as `StreamFormat.SchemaBinary()`.
   */
  format?: Layer.Layer<StreamFormat>;
}

/**
 * Where to start reading: `"start"` for the beginning, `"now"` for only
 * what's appended from here on, or an offset a read or tail returned.
 */
export type Offset = "start" | "now" | (string & {});

export interface AppendOptions {
  /**
   * An idempotent writer: `id` names it, `epoch` goes up when it restarts,
   * and `seq` goes up by one per append within an epoch. Appending the same
   * `seq` again writes nothing.
   */
  readonly producer?: { readonly id: string; readonly epoch: number; readonly seq: number };
}

export interface ReadResult<A> {
  readonly messages: ReadonlyArray<A>;
  /** Where the next read starts. */
  readonly next: string;
  /** Whether this read reached the end of the stream. */
  readonly upToDate: boolean;
  /** Whether the stream is closed: nothing more will ever be appended. */
  readonly closed: boolean;
}

/** The stream doesn't exist: never appended to, deleted, or expired. */
export class DurableStreamNotFound extends Data.TaggedError("Rivet.DurableStreamNotFound")<{
  readonly message: string;
}> {}

/**
 * The stream refused the write: it's closed, it was created with another
 * format or retention, or a `Stream-Seq` went backwards.
 */
export class DurableStreamConflict extends Data.TaggedError("Rivet.DurableStreamConflict")<{
  readonly message: string;
}> {}

/** An idempotent writer appended with an epoch older than the stream has seen. */
export class DurableStreamStaleProducer extends Data.TaggedError(
  "Rivet.DurableStreamStaleProducer",
)<{
  readonly message: string;
}> {}

/** The request failed: the control plane couldn't be reached, or answered with an error. */
export class DurableStreamRequestError extends Data.TaggedError("Rivet.DurableStreamRequestError")<{
  readonly message: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {}

/** A stream declared outside any runtime was called. */
export class DurableStreamCalledOutsideRuntime extends Data.TaggedError(
  "Rivet.DurableStreamCalledOutsideRuntime",
)<{
  readonly message: string;
}> {}

export type DurableStreamError =
  | DurableStreamNotFound
  | DurableStreamConflict
  | DurableStreamStaleProducer
  | DurableStreamRequestError
  | DurableStreamCalledOutsideRuntime
  | StreamFormatError;

/**
 * Every stream of one declaration, addressed by key. Calls only work inside
 * a runtime, and travel through the control plane's gateway with its token.
 */
export interface DurableStreamClient<A> {
  /** The declaration's name; each stream's path starts with it. */
  readonly name: string;
  /** Append one message, creating the stream on first use. */
  append(
    key: string,
    message: A,
    options?: AppendOptions,
  ): Effect.Effect<void, DurableStreamError, RuntimeContext>;
  /** Append several messages in one request, in order. */
  appendAll(
    key: string,
    messages: Arr.NonEmptyReadonlyArray<A>,
    options?: AppendOptions,
  ): Effect.Effect<void, DurableStreamError, RuntimeContext>;
  /** Read what's there from `from` (the start, by default), and where to read next. */
  read(
    key: string,
    options?: { readonly from?: Offset },
  ): Effect.Effect<ReadResult<A>, DurableStreamError, RuntimeContext>;
  /**
   * Every message from `from` (the start, by default), then each new one as
   * it's appended. It ends when the stream is closed, and reconnects on its
   * own whenever the connection drops.
   */
  tail(
    key: string,
    options?: { readonly from?: Offset },
  ): Stream.Stream<A, DurableStreamError, RuntimeContext>;
  /** Close the stream: reads keep working, appends fail with a conflict. */
  close(key: string): Effect.Effect<void, DurableStreamError, RuntimeContext>;
  /** Delete the stream and its history. Deleting a missing stream succeeds. */
  delete(key: string): Effect.Effect<void, DurableStreamError, RuntimeContext>;
}

/** The stream path every stream key is derived from. */
const STREAM_PATH = "/durable-streams/v1/stream/";

/** What a caller needs to reach the gateway. */
interface Target {
  readonly endpoint: string;
  readonly token: string;
  readonly namespace: string;
}

/** A live `control` event: where the next connection resumes, and whether the stream closed. */
const parseControl = (data: string): { streamNextOffset?: string; streamClosed?: boolean } => {
  try {
    const value: unknown = JSON.parse(data);
    return typeof value === "object" && value !== null ? value : {};
  } catch {
    return {};
  }
};

const encodeOffset = (from: Offset | undefined) =>
  from === undefined || from === "start" ? "-1" : from;

/**
 * The actor key Rivet Services gives a stream: a SHA-256 of its tenant
 * scope and path. Matching it lets a caller reach the stream through the
 * gateway, behind its token check, rather than the node's own unauthenticated
 * port, and still meet the same stream the node serves.
 */
const actorKey = (path: string) =>
  Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(`default\0${STREAM_PATH}${path}`)),
  ).pipe(
    Effect.map((hash) =>
      Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    ),
  );

const makeClient = <A>(
  name: string,
  props: DurableStreamProps<A>,
  format: StreamFormatShape,
  target: Target | undefined,
): DurableStreamClient<A> => {
  const outside = Effect.fail(
    new DurableStreamCalledOutsideRuntime({
      message: `Rivet.DurableStream '${name}' can only be called inside a runtime.`,
    }),
  );
  const pathOf = (key: string) => `${encodeURIComponent(name)}/${encodeURIComponent(key)}`;

  const request = Effect.fn(function* (
    key: string,
    init: {
      readonly method: string;
      readonly query?: Record<string, string>;
      readonly headers?: Record<string, string>;
      readonly body?: Uint8Array;
    },
  ) {
    if (target === undefined) return yield* outside;
    const path = pathOf(key);
    const query = new URLSearchParams({
      ...init.query,
      "rvt-namespace": target.namespace,
      "rvt-method": "getOrCreate",
      "rvt-runner": SERVICES_POOL,
      "rvt-key": yield* actorKey(path),
      "rvt-crash-policy": "sleep",
    });
    const url = `${target.endpoint.replace(/\/+$/, "")}/gateway/durableStream/request${STREAM_PATH}${path}?${query}`;
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        gatewaySend(url, target.token, {
          method: init.method,
          headers: init.headers,
          body: init.body,
          signal,
        }),
      catch: (cause) =>
        new DurableStreamRequestError({
          message: `${init.method} ${name}/${key} failed: ${String(cause)}`,
          cause,
        }),
    });
    if (response.ok) return response;
    const text = yield* Effect.promise(() => response.text().catch(() => ""));
    const message = `${init.method} ${name}/${key}: ${response.status} ${text}`.trim();
    switch (response.status) {
      case 404:
        return yield* new DurableStreamNotFound({ message });
      case 409:
        return yield* new DurableStreamConflict({ message });
      case 403:
        return yield* new DurableStreamStaleProducer({ message });
      default:
        return yield* new DurableStreamRequestError({ message, status: response.status });
    }
  });

  const create = (key: string) => {
    const headers: Record<string, string> = { "content-type": format.contentType };
    if (props.ttl !== undefined) {
      headers["Stream-TTL"] = String(
        Math.ceil(Duration.toSeconds(Duration.fromInputUnsafe(props.ttl))),
      );
    }
    if (props.expiresAt !== undefined) headers["Stream-Expires-At"] = props.expiresAt.toISOString();
    return request(key, { method: "PUT", headers });
  };

  const appendAll = (
    key: string,
    messages: Arr.NonEmptyReadonlyArray<A>,
    options?: AppendOptions,
  ) =>
    Effect.gen(function* () {
      const body = yield* format.encode(props.schema, messages);
      const headers: Record<string, string> = { "content-type": format.contentType };
      if (options?.producer !== undefined) {
        headers["Producer-Id"] = options.producer.id;
        headers["Producer-Epoch"] = String(options.producer.epoch);
        headers["Producer-Seq"] = String(options.producer.seq);
      }
      const post = request(key, { method: "POST", headers, body });
      // A stream is created on its first append.
      yield* post.pipe(
        Effect.catchTag("Rivet.DurableStreamNotFound", () =>
          create(key).pipe(Effect.andThen(post)),
        ),
      );
    });

  /** A response body as a stream of bytes. */
  const bodyOf = (response: Response) =>
    response.body === null
      ? Stream.empty
      : Stream.fromReadableStream({
          evaluate: () => response.body as ReadableStream<Uint8Array<ArrayBuffer>>,
          onError: (cause) =>
            new DurableStreamRequestError({ message: `reading ${name}: ${String(cause)}`, cause }),
        });

  const read = (key: string, options?: { readonly from?: Offset }) =>
    Effect.gen(function* () {
      const response = yield* request(key, {
        method: "GET",
        query: { offset: encodeOffset(options?.from) },
      });
      const messages = yield* bodyOf(response).pipe(format.decode(props.schema), Stream.runCollect);
      return {
        messages,
        next: response.headers.get("Stream-Next-Offset") ?? encodeOffset(options?.from),
        upToDate: response.headers.get("Stream-Up-To-Date") === "true",
        closed: response.headers.get("Stream-Closed") === "true",
      } satisfies ReadResult<A>;
    });

  /** One live connection's events, from `offset`. */
  const connect = (key: string, offset: string) =>
    Stream.unwrap(
      Effect.map(request(key, { method: "GET", query: { offset, live: "sse" } }), (response) => {
        const base64 = response.headers.get("stream-sse-data-encoding") === "base64";
        return bodyOf(response).pipe(
          Stream.decodeText,
          Stream.pipeThroughChannel(Sse.decode()),
          // A `retry:` field ends the connection early, like a dropped one.
          Stream.catchTag("Retry", () => Stream.empty),
          Stream.mapError((error) =>
            error._tag === "SseError"
              ? new DurableStreamRequestError({ message: error.message, cause: error })
              : error,
          ),
          Stream.map((event) => ({ event: event.event, data: event.data, base64 })),
        );
      }),
    );

  const tail = (key: string, options?: { readonly from?: Offset }) => {
    // Offsets and closure come in `control` events; the server drops
    // connections now and then, and the next one resumes from the offset.
    let offset = encodeOffset(options?.from);
    let closed = false;
    const loop: Stream.Stream<
      Uint8Array<ArrayBuffer>,
      DurableStreamError,
      RuntimeContext
    > = Stream.suspend(() =>
      connect(key, offset).pipe(
        Stream.filterMap((event) => {
          if (event.event === "control") {
            const control = parseControl(event.data);
            if (control.streamNextOffset !== undefined) offset = control.streamNextOffset;
            if (control.streamClosed === true) closed = true;
            return Result.fail(event);
          }
          if (event.event !== "data") return Result.fail(event);
          const bytes = event.base64
            ? Base64.decode(event.data).pipe((result) =>
                result._tag === "Success" ? result.success : new Uint8Array(),
              )
            : new TextEncoder().encode(event.data);
          return Result.succeed(bytes as Uint8Array<ArrayBuffer>);
        }),
        Stream.concat(Stream.suspend(() => (closed ? Stream.empty : loop))),
      ),
    );
    const decode = format.decode(props.schema);
    return format.framing === "messages"
      ? // Every event is a whole JSON array of messages.
        loop.pipe(Stream.flatMap((bytes) => decode(Stream.make(bytes))))
      : // Events continue one run of bytes.
        decode(loop);
  };

  return {
    name,
    append: (key, message, options) => appendAll(key, [message], options),
    appendAll,
    read,
    tail,
    close: (key) =>
      request(key, {
        method: "POST",
        headers: { "content-type": format.contentType, "Stream-Closed": "true" },
      }).pipe(Effect.asVoid),
    delete: (key) =>
      request(key, { method: "DELETE" }).pipe(
        Effect.asVoid,
        Effect.catchTag("Rivet.DurableStreamNotFound", () => Effect.void),
      ),
  };
};

/**
 * A Durable Stream declaration: an append-only log of typed messages, one
 * per key, kept by Rivet Services. Streams are created on their first append.
 */
export interface DurableStream<A, Format = StreamFormat> extends Effect.Effect<
  DurableStreamClient<A>,
  never,
  Services | Format
> {
  new (_: never): DurableStreamClient<A>;
  readonly LogicalId: string;
  readonly props: DurableStreamProps<A>;
}

/**
 * A Durable Stream: an append-only log with a durable, replayable history,
 * one per key, served by Rivet Services. Each stream is its own Rivet actor.
 * Declare it once with its message Schema; `yield*` it in any runtime for a
 * typed client that appends, reads, and follows each stream live.
 *
 * The messages' wire format is a Layer, `StreamFormat.Json` or another, so
 * a program only bundles the format it uses. It's fixed when a stream is
 * created.
 *
 * ### Declaring a stream
 * **Example:** A chat room's messages
 * ```typescript
 * import * as Rivet from "@alchemy.run/rivet";
 * import * as Schema from "effect/Schema";
 *
 * export const Message = Schema.Struct({ user: Schema.String, text: Schema.String });
 *
 * export class ChatLog extends Rivet.DurableStream<ChatLog>()("ChatLog", {
 *   schema: Message,
 *   ttl: "7 days",
 * }) {}
 * ```
 *
 * ### Writing and reading
 * **Example:** Append, read, and follow a room's stream
 * ```typescript
 * const log = yield* ChatLog;
 * yield* log.append("lobby", { user: "sam", text: "hello" });
 * const { messages, next } = yield* log.read("lobby");
 * const live = log.tail("lobby", { from: next });
 * ```
 *
 * ### Choosing a format
 * **Example:** JSON, provided once
 * ```typescript
 * import * as StreamFormat from "@alchemy.run/rivet/StreamFormat";
 *
 * Effect.provide(Layer.mergeAll(Default, Services, StreamFormat.Json));
 * ```
 *
 * @primitive
 */
export const DurableStream =
  <_Self>() =>
  <A, const P extends DurableStreamProps<A>>(
    id: string,
    props: P & DurableStreamProps<A>,
  ): DurableStream<A, P["format"] extends Layer.Layer<StreamFormat> ? never : StreamFormat> =>
    Object.assign(
      class {},
      { LogicalId: id, props },
      Effectable.Prototype({
        label: `Rivet.DurableStream<${id}>`,
        evaluate: () => clientOf(id, props),
      }),
    ) as unknown as DurableStream<
      A,
      P["format"] extends Layer.Layer<StreamFormat> ? never : StreamFormat
    >;

const clientOf = <A>(name: string, props: DurableStreamProps<A>) =>
  Effect.gen(function* () {
    const format =
      props.format === undefined
        ? yield* StreamFormat
        : yield* StreamFormat.pipe(Effect.provide(props.format));
    const services = yield* Services;
    const ctx = Option.getOrUndefined(yield* Effect.serviceOption(RuntimeContext));
    // Outside a runtime (the stack itself) there is nothing to call from.
    if (ctx === undefined) return makeClient(name, props, format, undefined);
    // Bound as environment values while deploying; read back at runtime.
    const bind = <T>(key: string, value: unknown) =>
      ctx
        .set(
          sanitizeKey(`RIVET_SERVICES_${key}`),
          Output.isOutput(value) ? value : Output.literal(value),
        )
        .pipe(Effect.flatMap((bound) => ctx.get<T>(bound)));
    const token = yield* bind<Redacted.Redacted<string> | string>("TOKEN", services.token);
    return makeClient(name, props, format, {
      endpoint: (yield* bind<string>("ENDPOINT", services.endpoint)) ?? "",
      namespace: (yield* bind<string>("NAMESPACE", services.namespace)) ?? "",
      token: token === undefined ? "" : Redacted.isRedacted(token) ? Redacted.value(token) : token,
    });
  });
