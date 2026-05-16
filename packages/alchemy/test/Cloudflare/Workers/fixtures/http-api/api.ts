import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";

export class Task extends Schema.Class<Task>("Task")({
  id: Schema.String,
  title: Schema.String,
  completed: Schema.Boolean,
}) {}

export class TaskNotFound extends Schema.TaggedErrorClass<TaskNotFound>()(
  "TaskNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

const TaskParams = Schema.Struct({
  id: Schema.String,
});

const getTask = HttpApiEndpoint.get("getTask", "/:id", {
  params: TaskParams,
  success: Task,
  error: TaskNotFound,
});

const createTask = HttpApiEndpoint.post("createTask", "/", {
  success: Task,
  payload: Schema.Struct({
    title: Schema.String,
  }),
});

export class TasksGroup extends HttpApiGroup.make("Tasks")
  .add(getTask)
  .add(createTask) {}

export class TaskApi extends HttpApi.make("TaskApi").add(TasksGroup) {}
