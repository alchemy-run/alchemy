import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as Schema from "effect/Schema";

export class Task extends Schema.Class<Task>("Task")({
  id: Schema.String,
  title: Schema.String,
}) {}

export class TaskNotFound extends Schema.TaggedError<TaskNotFound>()(
  "TaskNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

export const getTask = HttpApiEndpoint.get("getTask", "/tasks/:id", {
  params: { id: Schema.String },
  success: Task,
  error: TaskNotFound,
});

export const createTask = HttpApiEndpoint.post("createTask", "/tasks", {
  payload: Schema.Struct({ title: Schema.String }),
  success: Task,
});

/** A plain value, so a server and a typed client can both import it. */
export const TaskApi = HttpApi.make("TaskApi").add(
  HttpApiGroup.make("Tasks").add(getTask, createTask),
);
