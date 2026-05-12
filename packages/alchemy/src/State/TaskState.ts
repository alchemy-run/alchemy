import type { NamespaceNode } from "../Namespace.ts";

/**
 * Persisted state for a {@link Task}. Tasks share the same FQN namespace as
 * resources but are discriminated by `kind: "task"`. The engine keys task
 * state in the {@link State} store under the same `fqn` field as resources.
 */
export type TaskState = RunningTaskState | RanTaskState;

export type TaskStatus = TaskState["status"];

interface BaseTaskState {
  readonly kind: "task";
  /** Type of the Task (e.g. "NightlySync"). Mirrors `resourceType` for resources. */
  taskType: string;
  /** Namespace of the Task. */
  namespace: NamespaceNode | undefined;
  /** Fully qualified name (namespace + logical id). */
  fqn: string;
  /** Logical id of the Task (stable across runs). */
  logicalId: string;
  /** Current status. */
  status: TaskStatus;
  /** FQNs of nodes that depend on this Task's output. */
  downstream: string[];
  /** Hash of the resolved input, used to skip noop runs. */
  inputHash: string;
  /** Resolved input snapshot from the most recent attempt. */
  input: unknown;
}

/**
 * The Task body has started but persistence after success has not yet
 * occurred. On resume the engine treats this as "should run" since the
 * effect may have completed but the output wasn't durably recorded.
 */
export interface RunningTaskState extends BaseTaskState {
  status: "running";
}

/**
 * The Task body completed and its output is durably persisted. Future
 * plans skip the body when `inputHash` matches the new resolved input
 * (unless `--force` is set).
 */
export interface RanTaskState extends BaseTaskState {
  status: "ran";
  /** Materialized output value returned by the Task body. */
  output: unknown;
}
