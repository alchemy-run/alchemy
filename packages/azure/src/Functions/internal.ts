/**
 * Runtime registry shared by `Azure.Functions.Function`'s runtime context and
 * the bootstraps in `Bootstrap/`. The program's init fills it (the HTTP
 * dispatcher, one entry per trigger function); the bootstrap then registers
 * each entry with the Functions Node.js worker. Not exported from
 * `index.ts`, and free of Effect so the async bootstrap can import it.
 */

/** A Functions trigger binding (`{ type: "queueTrigger", queueName, … }`). */
export type TriggerBinding = { type: string } & Record<string, unknown>;

/** What the worker hands a trigger function. */
export interface TriggerInvocation {
  /** The trigger payload (message body, timer info, event, …). */
  input: unknown;
  /** Trigger metadata (`DequeueCount`, `EnqueuedTimeUtc`, …). */
  metadata: Record<string, unknown>;
  /** Invocation id assigned by the Functions host. */
  invocationId: string;
  /** Name of the function that ran. */
  functionName: string;
}

export interface RegisteredTrigger {
  readonly binding: TriggerBinding;
  /** Runs the handler; a rejection fails the invocation so the host retries it. */
  readonly run: (invocation: TriggerInvocation) => Promise<void>;
}

export interface FunctionRegistry {
  /** Web-standard dispatcher over the program's `fetch`, if it has one. */
  http: ((request: Request) => Promise<Response>) | undefined;
  readonly triggers: Map<string, RegisteredTrigger>;
}

const KEY = Symbol.for("alchemy.run/azure/Functions/registry");

/** The process-wide registry (one per Functions worker process). */
export const functionRegistry = (): FunctionRegistry => {
  const holder = globalThis as { [KEY]?: FunctionRegistry };
  holder[KEY] ??= { http: undefined, triggers: new Map() };
  return holder[KEY];
};

/** Function names: a letter first, then letters, digits, `_` and `-` (max 128). */
export const functionNameOf = (prefix: string, logicalId: string) =>
  `${prefix}-${logicalId}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 128);

/** App-setting-safe suffix derived from a logical ID (`Orders.v2` → `ORDERS_V2`). */
export const settingSuffix = (logicalId: string) =>
  logicalId.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
