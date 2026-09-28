import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type { RuntimeContext } from "../../RuntimeContext.ts";

/** A native Workflow API call failed. */
export class WorkflowError extends Data.TaggedError(
  "Celld.Workflows.WorkflowError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Fail a durable task without further native retries. Celld recognizes this name. */
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}

/** Retry backoff supported by Celld v0.5. */
export type WorkflowBackoff = "constant" | "linear" | "exponential";

/** Context passed to each durable task attempt. */
export interface WorkflowStepContextData {
  /** Name and occurrence count of this step. */
  step: { name: string; count: number };
  /** One-based attempt count. */
  attempt: number;
  /** Effective policy; a dynamic delay is omitted from this context. */
  config: {
    retries: {
      limit: number;
      delay?: string | number;
      backoff?: WorkflowBackoff;
    };
    timeout: string | number;
  };
}

/** Durable task policy. Rollback and sensitive output are not supported by Celld. */
export interface WorkflowTaskConfig<R = never> {
  /** Retry limit and delay; numbers are milliseconds. */
  retries?: {
    limit: number;
    delay:
      | string
      | number
      | ((options: {
          ctx: WorkflowStepContextData;
          error: Error;
        }) => Effect.Effect<string | number, never, R>);
    backoff?: WorkflowBackoff;
  };
  /** Attempt timeout; numbers are milliseconds. */
  timeout?: string | number;
}

/** Options for waiting on an instance event. */
export interface WorkflowWaitForEventOptions {
  /** Event type to receive. */
  type: string;
  /** Maximum wait; numbers are milliseconds. */
  timeout?: string | number;
}

/** Persisted external event returned by waitForEvent. */
export interface WorkflowStepEvent<T = unknown> {
  /** Event payload. */
  payload: T;
  /** Event timestamp. */
  timestamp: Date;
  /** Event type. */
  type: string;
}

/** Options for creating an instance. */
export interface WorkflowInstanceCreateOptions<Input = unknown> {
  /** Stable ID; omit for a generated ID. */
  id?: string;
  /** Workflow input. */
  params?: Input;
  /** Terminal state retention, at most 30 days. Numbers are milliseconds. */
  retention?: {
    successRetention?: string | number;
    errorRetention?: string | number;
  };
  /** Native placement hint, not a residency guarantee. */
  locationHint?:
    | "wnam"
    | "enam"
    | "sam"
    | "weur"
    | "eeur"
    | "apac"
    | "apac-ne"
    | "apac-se"
    | "oc"
    | "afr"
    | "me";
}

/** Restart the full history or from a selected step occurrence. */
export interface WorkflowInstanceRestartOptions {
  /** The step to replay; omitted count defaults to one and type to do. */
  from?: {
    name: string;
    count?: number;
    type?: "do" | "sleep" | "waitForEvent";
  };
}

/** An event sent to an existing instance. */
export interface WorkflowInstanceEvent<T = unknown> {
  /** Event type. */
  type: string;
  /** Serializable event payload. */
  payload?: T;
}

/** Native status snapshot. */
export interface WorkflowInstanceStatus<Result = unknown> {
  /** Current state. */
  status:
    | "queued"
    | "running"
    | "paused"
    | "errored"
    | "terminated"
    | "complete"
    | "waiting"
    | "waitingForPause";
  /** Workflow return value on completion. */
  output?: Result;
  /** Terminal failure, when present. */
  error?: { name: string; message: string } | null;
  /** Celld v0.5 does not implement rollback. */
  rollback?: null;
}

/** Result of native best-effort batch deletion, including per-ID failures. */
export interface WorkflowDeleteBatchResult {
  /** Successfully deleted IDs, preserving native result order. */
  deleted: { id: string }[];
  /** Failed IDs with native error codes and messages. */
  errors: { id: string; code: number; message: string }[];
}

type Call<A> = Effect.Effect<A, WorkflowError, RuntimeContext>;

/** Request-scoped operations on one workflow instance. */
export interface WorkflowInstance<Result = unknown> {
  /** Native instance ID. */
  readonly id: string;
  /** Read current state. */
  status(): Call<WorkflowInstanceStatus<Result>>;
  /** Pause execution. */
  pause(): Call<void>;
  /** Resume a paused instance. */
  resume(): Call<void>;
  /** Restart, optionally selecting a step occurrence. */
  restart(options?: WorkflowInstanceRestartOptions): Call<void>;
  /** Terminate without rollback. */
  terminate(): Call<void>;
  /** Send an event to waitForEvent. */
  sendEvent<T>(event: WorkflowInstanceEvent<T>): Call<void>;
  /** Delete this instance's persisted history. */
  delete(): Call<void>;
}

/** Request-scoped operations on a native workflow binding. */
export interface WorkflowHandle<Input = unknown, Result = unknown> {
  /** Provider-owned runtime handle discriminator. */
  readonly Type: "Celld.Workflow";
  /** Binding name. */
  readonly name: string;
  /** Create one instance; an existing ID is an error. */
  create(
    options?: WorkflowInstanceCreateOptions<Input>,
  ): Call<WorkflowInstance<Result>>;
  /** Create 1–100 instances; existing IDs and uncloneable params are skipped natively. */
  createBatch(
    batch: WorkflowInstanceCreateOptions<Input>[],
  ): Call<WorkflowInstance<Result>[]>;
  /** Find an existing instance; does not create missing IDs. */
  get(id: string): Call<WorkflowInstance<Result>>;
  /** Delete 1–100 IDs with native per-ID results. */
  deleteBatch(ids: string[]): Call<WorkflowDeleteBatchResult>;
}

/** Native Celld instance interface, separate from Effect clients. @internal */
export interface NativeWorkflowInstance<Result = unknown> {
  id: string;
  status(): Promise<WorkflowInstanceStatus<Result>>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  restart(options?: WorkflowInstanceRestartOptions): Promise<void>;
  terminate(): Promise<void>;
  sendEvent<T>(event: WorkflowInstanceEvent<T>): Promise<void>;
  delete(): Promise<void>;
}

/** Native binding surface verified against the v0.5 harness. @internal */
export interface NativeWorkflow<Input = unknown, Result = unknown> {
  create(
    options?: WorkflowInstanceCreateOptions<Input>,
  ): Promise<NativeWorkflowInstance<Result>>;
  createBatch(
    batch: WorkflowInstanceCreateOptions<Input>[],
  ): Promise<NativeWorkflowInstance<Result>[]>;
  get(id: string): Promise<NativeWorkflowInstance<Result>>;
  deleteBatch(ids: string[]): Promise<WorkflowDeleteBatchResult>;
}

/** Native durable-step surface; no rollback or sensitive-output overload. @internal */
export interface NativeWorkflowStep {
  do<T>(
    name: string,
    config: {
      retries?: {
        limit: number;
        delay:
          | string
          | number
          | ((options: {
              ctx: WorkflowStepContextData;
              error: Error;
            }) => Promise<string | number>);
        backoff?: WorkflowBackoff;
      };
      timeout?: string | number;
    },
    callback: (context: WorkflowStepContextData) => Promise<T>,
  ): Promise<T>;
  sleep(name: string, duration: string | number): Promise<void>;
  sleepUntil(name: string, timestamp: Date | number): Promise<void>;
  waitForEvent<T>(
    name: string,
    options: WorkflowWaitForEventOptions,
  ): Promise<WorkflowStepEvent<T>>;
}
