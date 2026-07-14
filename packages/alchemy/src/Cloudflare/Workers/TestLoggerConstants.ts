/**
 * Shared constants for the test-logging pipeline.
 *
 * Kept in a dependency-free file because both sides import it:
 * - `TestLoggerRuntime.ts` is bundled INTO deployed Workers (imports
 *   `cloudflare:workers`, must not drag in node/distilled code), and
 * - `TestLoggerWorker.ts` is deploy-side (distilled API + file locking,
 *   must not import `cloudflare:workers`).
 */
export const Constants = {
  /** Account-level singleton worker hosting the log-buffer Durable Object. */
  TEST_LOGGER_WORKER_NAME: "alchemy-test-logger",
  /** The Durable Object class exported by the logger worker. */
  TEST_LOGGER_CLASS_NAME: "AlchemyTestLogger",
  /** DO namespace binding injected into workers deployed with test logging. */
  TEST_LOGGER_DO_BINDING: "ALCHEMY_TEST_LOGGER",
  /** Plain-text binding carrying the host worker's own script name. */
  TEST_LOGGER_WORKER_NAME_BINDING: "ALCHEMY_TEST_LOGGER_WORKER_NAME",
} as const;

/**
 * The Durable Object instance name for a stack+stage. One DO instance per
 * deployed stack instance keeps runs isolated and bounds each instance's
 * SQLite buffer to its own stack's logs.
 */
export const testLoggerInstanceName = (stack: {
  name: string;
  stage: string;
}): string => `${stack.name}/${stack.stage}`;

/** The shape of a buffered log row, as stored and streamed by the DO. */
export interface TestLogRow {
  id: number;
  worker: string;
  message: string;
  method: string;
  timestamp: number;
}
