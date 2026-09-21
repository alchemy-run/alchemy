/** Native Celld queue producer; no pull-consumer API is available. */
export interface NativeQueue {
  send(body: unknown, options?: QueueSendOptions): Promise<void>;
  sendBatch(
    messages: QueueSendMessage[],
    options?: { delaySeconds?: number },
  ): Promise<void>;
}

/** Encoding and delivery options accepted by Celld v0.5. */
export interface QueueSendOptions {
  /** Encoding; the default depends on the queue_json_messages compatibility flag. */
  contentType?: "json" | "text" | "bytes" | "v8";
  /** Delay in seconds, between 0 and 86400. */
  delaySeconds?: number;
}

/** A batch item whose delay overrides the batch-wide default. */
export interface QueueSendMessage extends QueueSendOptions {
  /** Structured-clone, JSON, text, or byte payload. */
  body: unknown;
}

/** Retry the current delivery after an optional delay in seconds. */
export interface RetryOptions {
  /** Delay before redelivery. */
  delaySeconds?: number;
}

/** A message whose settlement methods are valid only during its queue event. */
export interface Message<Body = unknown> {
  /** Stable native message identifier. */
  readonly id: string;
  /** Enqueue time. */
  readonly timestamp: Date;
  /** Decoded payload. */
  readonly body: Body;
  /** Delivery attempt count. */
  readonly attempts: number;
  /** Acknowledge this message. An earlier retry remains authoritative. */
  ack(): void;
  /** Retry this message. An earlier acknowledgement remains authoritative. */
  retry(options?: RetryOptions): void;
}

/** Native push batch delivered to a Worker's queue handler. */
export interface MessageBatch<Body = unknown> {
  /** Fleet-wide queue name. */
  readonly queue: string;
  /** Messages leased for this invocation. */
  readonly messages: readonly Message<Body>[];
  /** Queue backlog when the batch was assembled. */
  readonly metadata: {
    metrics: {
      backlogCount: number;
      backlogBytes: number;
      oldestMessageTimestamp?: Date;
    };
  };
  /** Acknowledge the batch. */
  ackAll(): void;
  /** Retry the batch. */
  retryAll(options?: RetryOptions): void;
}
