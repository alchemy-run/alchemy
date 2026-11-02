import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
/**
 * The Kafka protocol through `kafkajs`, an optional peer dependency. Kafka is a binary
 * socket protocol, so it isn't a distilled service. `kafkajs` is pure JavaScript with no
 * dependencies, and has SASL SCRAM-SHA-512 over TLS, which is what the client configuration
 * STACKIT's spec shows for an intake user. Not exported from the namespace barrel.
 */
import type { EachMessagePayload, KafkaConfig, Message } from "kafkajs";

/**
 * A Kafka connection failed, or the broker refused something: the password is wrong, the
 * user's type doesn't allow the topic, the runner's buffer is full.
 */
export class KafkaError extends Data.TaggedError("Stackit.Intake.KafkaError")<{
  readonly message: string;
}> {}

/** What it takes to reach an intake's topics. */
export interface KafkaAccess {
  /** The Kafka endpoint, `host:port`. */
  readonly uri: string;
  /** SASL user name. */
  readonly user: string;
  /** SASL password. */
  readonly password: Redacted.Redacted<string>;
}

/** A message to publish. */
export interface ProducedMessage {
  /** Message body. An intake takes JSON; anything else goes to its dead letter topic. */
  readonly value: string;
  /** Message key, which picks the partition. */
  readonly key?: string;
  /** Message headers. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** Where the broker put a batch of messages. */
export interface ProducedRecord {
  /** Topic it went to. */
  readonly topic: string;
  /** Partition it went to. */
  readonly partition: number;
  /** Offset of the first message of the batch in that partition. */
  readonly offset: string | undefined;
}

/** A message taken off a topic. */
export interface ConsumedKafkaMessage {
  /** Topic it came from. */
  readonly topic: string;
  /** Partition it came from. */
  readonly partition: number;
  /** Offset in that partition. */
  readonly offset: string;
  /** Message key decoded as UTF-8. */
  readonly key: string | undefined;
  /** Message body. */
  readonly body: Uint8Array;
  /** Message body decoded as UTF-8. */
  readonly text: string;
  /** Message headers decoded as UTF-8. A repeated header keeps its first value. */
  readonly headers: Readonly<Record<string, string>>;
}

export interface KafkaConsumeOptions<E, R> {
  /** Topic to read. */
  readonly topic: string;
  /** Consumer group, which keeps the position in the topic across runs. */
  readonly groupId: string;
  /**
   * Where a group with no position starts.
   * @default true
   */
  readonly fromBeginning?: boolean;
  /**
   * How many partitions are handled at once.
   * @default 1
   */
  readonly concurrency?: number;
  /**
   * What happens to a message whose handler fails: `retry` delivers it again, so a message
   * that always fails holds its partition, and `skip` logs it and moves on, whether the
   * handler failed or died.
   * @default "retry"
   */
  readonly onFailure?: "retry" | "skip";
  /** Handles one message. A success moves the group past it. */
  readonly handler: (message: ConsumedKafkaMessage) => Effect.Effect<void, E, R>;
  /** Runs once the consumer has joined its group. */
  readonly onConsuming?: Effect.Effect<void>;
}

/** Attempts of one driver request before it reports failure, with its own backoff. */
const DRIVER_RETRIES = 5;

/**
 * Load `kafkajs` with a descriptive failure when it isn't installed. CJS/ESM interop is
 * normalized: callers always get the module's named surface.
 */
const importKafkajs = Effect.tryPromise({
  try: () =>
    import("kafkajs").then((mod) =>
      (mod as { default?: { Kafka?: unknown } }).default?.Kafka !== undefined
        ? // The compiler sees only the module's named surface, not its CJS default.
          (mod as unknown as { default: typeof import("kafkajs") }).default
        : mod,
    ),
  catch: () =>
    new KafkaError({
      message:
        "Failed to load the 'kafkajs' driver. Install the optional peer dependency 'kafkajs' to use Kafka with STACKIT Intake.",
    }),
});

/** A driver error as text. The password never gets through. */
const describe = (cause: unknown, access: KafkaAccess): string => {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.replaceAll(Redacted.value(access.password), "***");
};

const toConfig = (access: KafkaAccess, logLevel: KafkaConfig["logLevel"]): KafkaConfig => ({
  clientId: "alchemy-stackit-intake",
  brokers: [access.uri],
  ssl: true,
  sasl: {
    mechanism: "scram-sha-512",
    username: access.user,
    password: Redacted.value(access.password),
  },
  // Failures reach the caller as `KafkaError`; the driver's own logs stay out of the host's.
  logLevel,
  retry: { retries: DRIVER_RETRIES },
});

const toMessage = (message: ProducedMessage): Message => ({
  value: message.value,
  ...(message.key !== undefined ? { key: message.key } : {}),
  ...(message.headers !== undefined ? { headers: { ...message.headers } } : {}),
});

/**
 * Publish messages over one connection, closed when the call ends. A connection never
 * outlives the call, so this holds nothing across requests.
 */
export const produce = (
  access: KafkaAccess,
  topic: string,
  messages: ReadonlyArray<ProducedMessage>,
): Effect.Effect<ReadonlyArray<ProducedRecord>, KafkaError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const driver = yield* importKafkajs;
      const failed = (step: string) => (cause: unknown) =>
        new KafkaError({ message: `Kafka ${step} failed: ${describe(cause, access)}` });
      const client = new driver.Kafka(toConfig(access, driver.logLevel.NOTHING));
      // The topics of an intake exist; creating one is never what a typo should do.
      const producer = client.producer({ allowAutoTopicCreation: false });
      yield* Effect.acquireRelease(
        Effect.tryPromise({ try: () => producer.connect(), catch: failed("connection") }),
        () => Effect.tryPromise(() => producer.disconnect()).pipe(Effect.ignore),
      );
      const records = yield* Effect.tryPromise({
        try: () => producer.send({ topic, messages: messages.map(toMessage) }),
        catch: failed(`publish to ${topic}`),
      });
      return records.map((record) => ({
        topic: record.topicName,
        partition: record.partition,
        offset: record.baseOffset,
      }));
    }),
  );

const headerText = (value: unknown): string | undefined => {
  const first = Array.isArray(value) ? value[0] : value;
  if (first === undefined || first === null) return undefined;
  return typeof first === "string" ? first : new TextDecoder().decode(first as Uint8Array);
};

const toConsumed = ({ topic, partition, message }: EachMessagePayload): ConsumedKafkaMessage => {
  const body = message.value ?? new Uint8Array();
  return {
    topic,
    partition,
    offset: message.offset,
    key: message.key === null ? undefined : new TextDecoder().decode(message.key),
    body: new Uint8Array(body),
    text: new TextDecoder().decode(body),
    headers: Object.fromEntries(
      Object.entries(message.headers ?? {}).flatMap(([name, value]) => {
        const text = headerText(value);
        return text === undefined ? [] : [[name, text] as const];
      }),
    ),
  };
};

/**
 * Consume a topic until the fiber is interrupted, or the driver gives up on the consumer,
 * which fails with {@link KafkaError}. A handler's success moves the group past its
 * message. The connection is closed when the effect ends, and a message that wasn't
 * finished is delivered again.
 */
export const consume = <E, R>(
  access: KafkaAccess,
  options: KafkaConsumeOptions<E, R>,
): Effect.Effect<never, KafkaError, R> =>
  Effect.scoped(
    Effect.gen(function* () {
      const driver = yield* importKafkajs;
      const failed = (step: string) => (cause: unknown) =>
        new KafkaError({ message: `Kafka ${step} failed: ${describe(cause, access)}` });
      const context = yield* Effect.context<R>();
      const lost = yield* Queue.unbounded<string>();
      const client = new driver.Kafka(toConfig(access, driver.logLevel.NOTHING));
      const consumer = client.consumer({
        groupId: options.groupId,
        allowAutoTopicCreation: false,
      });
      // The driver restarts a consumer by itself after a retriable failure. This is the
      // one it won't come back from.
      consumer.on(consumer.events.CRASH, ({ payload }) => {
        if (!payload.restart) {
          Queue.offerUnsafe(lost, `Kafka consumer stopped: ${describe(payload.error, access)}`);
        }
      });
      yield* Effect.acquireRelease(
        Effect.tryPromise({ try: () => consumer.connect(), catch: failed("connection") }),
        () => Effect.tryPromise(() => consumer.disconnect()).pipe(Effect.ignore),
      );
      yield* Effect.tryPromise({
        try: () =>
          consumer.subscribe({
            topics: [options.topic],
            fromBeginning: options.fromBeginning ?? true,
          }),
        catch: failed(`subscribe to ${options.topic}`),
      });
      const handle = (payload: EachMessagePayload): Effect.Effect<void, E, R> => {
        const handled = options
          .handler(toConsumed(payload))
          .pipe(
            Effect.tapCause((cause) =>
              Effect.logError(`Handler failed on a message from ${options.topic}`, cause),
            ),
          );
        return options.onFailure === "skip"
          ? // A defect counts too. An interruption is a shutdown, not a verdict on the message:
            // it stays unfinished, so it is delivered again.
            handled.pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.void,
              ),
            )
          : handled;
      };
      yield* Effect.tryPromise({
        try: () =>
          consumer.run({
            partitionsConsumedConcurrently: options.concurrency ?? 1,
            eachMessage: (payload) => Effect.runPromiseWith(context)(handle(payload)),
          }),
        catch: failed(`consume of ${options.topic}`),
      });
      if (options.onConsuming !== undefined) yield* options.onConsuming;
      const reason = yield* Queue.take(lost);
      return yield* new KafkaError({ message: reason });
    }),
  );
