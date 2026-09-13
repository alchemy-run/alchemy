import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Tasks, type TaskStatus } from "./Tasks.ts";

/**
 * The engineering ledgers, read-only:
 *
 * - `GET /api/tasks`  — the task ledger (`?status=` filters)
 */
export const TasksApi = Effect.gen(function* () {
  const tasks = yield* Tasks;

  return Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/api/tasks",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const status = new URL(request.url, "http://worker").searchParams.get(
          "status",
        );
        return yield* HttpServerResponse.json({
          tasks: yield* tasks.list(
            status === null ? undefined : (status as TaskStatus),
          ),
        });
      }),
    ),
  );
});
