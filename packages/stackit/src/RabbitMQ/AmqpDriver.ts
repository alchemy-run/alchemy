/**
 * AMQP 0-9-1 through `amqplib`, an optional peer dependency. AMQP is a binary socket
 * protocol, so it isn't a distilled service. Not exported from the namespace barrel.
 */
import type { ConsumeMessage, Channel, ChannelModel } from "amqplib";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";

/**
 * An AMQP connection failed, or the broker closed it or the consumer: the queue is
 * gone, the credential was refused, the host's IP isn't in the instance's `acl`.
 */
export class AmqpError extends Data.TaggedError("Stackit.RabbitMQ.AmqpError")<{
  readonly message: string;
}> {}

/** A message taken off a queue. */
export interface ConsumedMessage {
  /** Message body. */
  readonly body: Uint8Array;
  /** Message body decoded as UTF-8. */
  readonly text: string;
  /** Exchange it was published to; empty for the default exchange. */
  readonly exchange: string;
  /** Routing key it was published with. */
  readonly routingKey: string;
  /** Whether the broker delivered it before and it came back. */
  readonly redelivered: boolean;
  /** AMQP message properties, as `amqplib` names them. */
  readonly properties: ConsumeMessage["properties"];
}

export interface ConsumeOptions<E, R> {
  /** Queue to consume. It has to exist. */
  readonly queue: string;
  /**
   * Messages the broker hands out before earlier ones are finished, which is also how
   * many handlers run at once.
   * @default 1
   */
  readonly prefetch?: number;
  /**
   * What happens to a message whose handler fails: back on the queue, or dropped
   * (dead-lettered, when the queue has a dead-letter exchange).
   * @default true
   */
  readonly requeueOnFailure?: boolean;
  /** Handles one message. A success acknowledges it. */
  readonly handler: (message: ConsumedMessage) => Effect.Effect<void, E, R>;
  /** Runs once the broker has accepted the consumer. */
  readonly onConsuming?: Effect.Effect<void>;
}

const DEFAULT_PREFETCH = 1;

/**
 * Load `amqplib` with a descriptive failure when it isn't installed. CJS/ESM interop is
 * normalized: callers always get the module's named surface.
 */
const importAmqplib = Effect.tryPromise({
  try: () =>
    import("amqplib").then((mod) =>
      (mod as { default?: { connect?: unknown } }).default?.connect !== undefined
        ? // The compiler sees only the module's named surface, not its CJS default.
          (mod as unknown as { default: typeof import("amqplib") }).default
        : mod,
    ),
  catch: () =>
    new AmqpError({
      message:
        "Failed to load the 'amqplib' driver. Install the optional peer dependency 'amqplib' to consume from RabbitMQ.",
    }),
});

/** A driver error as text. The URI holds the password, so it never gets through. */
const describe = (cause: unknown, secrets: ReadonlyArray<string>): string => {
  const text = cause instanceof Error ? cause.message : String(cause);
  return secrets.reduce((message, secret) => message.replaceAll(secret, "***"), text);
};

type ConsumerEvent =
  | { readonly _tag: "Delivery"; readonly message: ConsumeMessage }
  | { readonly _tag: "Lost"; readonly message: string };

const toConsumed = (message: ConsumeMessage): ConsumedMessage => ({
  body: new Uint8Array(message.content),
  text: new TextDecoder().decode(message.content),
  exchange: message.fields.exchange,
  routingKey: message.fields.routingKey,
  redelivered: message.fields.redelivered,
  properties: message.properties,
});

/**
 * Open a connection and a channel on the ambient `Scope`. Connection and channel trouble
 * arrives as `Lost` on `events`: `amqplib` reports it through emitters, after the
 * connection is up.
 */
const openChannel = (
  uri: Redacted.Redacted<string>,
  events: Queue.Queue<ConsumerEvent>,
): Effect.Effect<Channel, AmqpError, Scope.Scope> =>
  Effect.gen(function* () {
    const amqp = yield* importAmqplib;
    const secret = Redacted.value(uri);
    const failed = (step: string) => (cause: unknown) =>
      new AmqpError({ message: `RabbitMQ ${step} failed: ${describe(cause, [secret])}` });
    const lost = (step: string) => (cause?: unknown) => {
      Queue.offerUnsafe(events, {
        _tag: "Lost",
        message:
          cause === undefined
            ? `RabbitMQ ${step} closed`
            : `RabbitMQ ${step} failed: ${describe(cause, [secret])}`,
      });
    };

    const connection: ChannelModel = yield* Effect.acquireRelease(
      Effect.tryPromise({ try: () => amqp.connect(secret), catch: failed("connection") }),
      (opened) => Effect.tryPromise(() => opened.close()).pipe(Effect.ignore),
    );
    connection.on("error", lost("connection"));
    connection.on("close", () => lost("connection")());

    const channel: Channel = yield* Effect.tryPromise({
      try: () => connection.createChannel(),
      catch: failed("channel"),
    });
    channel.on("error", lost("channel"));
    channel.on("close", () => lost("channel")());
    return channel;
  });

/**
 * Consume a queue until the fiber is interrupted, or the connection or the consumer is
 * lost, which fails with {@link AmqpError}. A handler's success acknowledges its message.
 * A failure or a defect is logged, and the message goes back or is dropped per
 * `requeueOnFailure`. Unfinished messages go back to the queue when the connection
 * closes, so an interrupted consumer loses nothing.
 */
export const consume = <E, R>(
  uri: Redacted.Redacted<string>,
  options: ConsumeOptions<E, R>,
): Effect.Effect<never, AmqpError, R> =>
  Effect.scoped(
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<ConsumerEvent>();
      const channel = yield* openChannel(uri, events);
      const requeue = options.requeueOnFailure ?? true;
      const operation = (step: string, run: () => Promise<unknown>) =>
        Effect.tryPromise({
          try: run,
          catch: (cause) =>
            new AmqpError({
              message: `RabbitMQ ${step} failed: ${describe(cause, [Redacted.value(uri)])}`,
            }),
        });

      yield* operation("prefetch", () => channel.prefetch(options.prefetch ?? DEFAULT_PREFETCH));
      yield* operation(`consume of ${options.queue}`, () =>
        channel.consume(options.queue, (message) => {
          // The broker cancelled the consumer: the queue was deleted.
          Queue.offerUnsafe(
            events,
            message === null
              ? { _tag: "Lost", message: `RabbitMQ cancelled the consumer of ${options.queue}` }
              : { _tag: "Delivery", message },
          );
        }),
      );
      if (options.onConsuming !== undefined) yield* options.onConsuming;

      const handle = (message: ConsumeMessage) =>
        options.handler(toConsumed(message)).pipe(
          Effect.tapCause((cause) =>
            Effect.logError(`Handler failed on a message from ${options.queue}`, cause),
          ),
          Effect.exit,
          Effect.flatMap((exit) =>
            Effect.try({
              try: () =>
                exit._tag === "Success"
                  ? channel.ack(message)
                  : channel.nack(message, false, requeue),
              // A closed channel: the broker puts the message back by itself, and the
              // consumer is told through `events`.
              catch: () => undefined,
            }).pipe(Effect.ignore),
          ),
        );

      // The broker hands out `prefetch` messages at a time, which bounds these fibers.
      return yield* Effect.forever(
        Effect.gen(function* () {
          const event = yield* Queue.take(events);
          if (event._tag === "Lost") {
            return yield* new AmqpError({ message: event.message });
          }
          yield* Effect.forkScoped(handle(event.message));
        }),
      );
    }),
  );

/** Consecutive lost connections a consumer survives before it gives up. */
const MAX_RECONNECTS = 20;

/** The longest wait between two attempts. */
const MAX_BACKOFF_MILLIS = 30_000;

/**
 * Keep a consumer running: reconnect after a lost connection, with a backoff that grows
 * from 1 second to 30. A broker restart or an update takes minutes, so the budget of 20
 * consecutive failures outlasts one. Past it this fails, for the host to stop and its
 * orchestrator to restart: a credential or ACL that stays wrong shouldn't look like a
 * running worker.
 *
 * A consumer that stayed up for longer than the longest backoff was healthy, so its loss
 * starts a new outage with the whole budget and the shortest wait. Otherwise a worker
 * would die on its 21st broker restart, however far apart they were.
 */
export const reconnecting = <E extends { readonly message: string }, R>(
  connect: (onConsuming: Effect.Effect<void>) => Effect.Effect<never, E, R>,
): Effect.Effect<never, E, R> =>
  Effect.gen(function* () {
    let failures = 0;
    while (true) {
      let consumingSince: number | undefined;
      const error = yield* connect(
        Clock.currentTimeMillis.pipe(
          Effect.map((now) => {
            consumingSince = now;
          }),
        ),
      ).pipe(Effect.flip);
      const now = yield* Clock.currentTimeMillis;
      const healthy = consumingSince !== undefined && now - consumingSince >= MAX_BACKOFF_MILLIS;
      failures = healthy ? 1 : failures + 1;
      yield* Effect.logWarning(error.message);
      if (failures > MAX_RECONNECTS) return yield* Effect.fail(error);
      yield* Effect.sleep(
        Duration.millis(Math.min(1000 * 2 ** (failures - 1), MAX_BACKOFF_MILLIS)),
      );
    }
  });
