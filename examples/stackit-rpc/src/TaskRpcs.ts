import { Rpc, RpcGroup } from "effect/rpc";
import * as Schema from "effect/Schema";

export class Task extends Schema.Class<Task>("Task")({
  id: Schema.String,
  title: Schema.String,
}) {}

export class TaskNotFound extends Schema.TaggedClass<TaskNotFound>()("TaskNotFound", {
  id: Schema.String,
}) {}

const getTask = Rpc.make("getTask", {
  payload: { id: Schema.String },
  success: Task,
  error: TaskNotFound,
});

const createTask = Rpc.make("createTask", {
  payload: { title: Schema.String },
  success: Task,
});

/** A plain value, so a server and a typed client can both import it. */
export class TaskRpcs extends RpcGroup.make(getTask, createTask) {}
