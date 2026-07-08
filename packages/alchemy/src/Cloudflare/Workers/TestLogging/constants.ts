/**
 * Shared constants for the test-logging pipeline. This file must stay
 * dependency-free — it is imported both by Node-side deploy/test code and by
 * the worker-side runtime patch that gets bundled into every Worker.
 */

/** Cross-script Durable Object namespace binding injected into user workers. */
export const TEST_LOGGER_BINDING = "__ALCHEMY_TEST_LOGGER";

/** Plain-text binding carrying the host worker's script name. */
export const TEST_LOGGER_WORKER_NAME_ENV = "__ALCHEMY_TEST_LOG_WORKER";

/** Plain-text binding carrying the logger DO instance name (stack/stage). */
export const TEST_LOGGER_DO_NAME_ENV = "__ALCHEMY_TEST_LOG_DO";

/** Account-level singleton worker that hosts the logger Durable Object. */
export const TEST_LOGGER_SCRIPT_NAME = "alchemy-test-logger";

/** The Durable Object class exported by the logger worker. */
export const TEST_LOGGER_CLASS_NAME = "AlchemyTestLogger";

/** Header the test harness attaches to every HttpClient request. */
export const TEST_LOG_HEADER = "alchemy-request-id";

/** Bucket for logs that could not be correlated to a request ID. */
export const DEFAULT_REQUEST_ID = "default";

/** A single captured console call, as stored/streamed by the logger DO. */
export interface TestLogRow {
  id: number;
  /** Pre-rendered single-line message (args joined with a space). */
  message: string;
  /** The console method used (`log`, `error`, `warn`, ...). */
  method: string;
  /** Script name of the worker that produced the log. */
  workerName: string;
  /** Epoch millis at DO insert time. */
  timestamp: number;
  /** Correlated request ID, or {@link DEFAULT_REQUEST_ID}. */
  requestId: string;
}
