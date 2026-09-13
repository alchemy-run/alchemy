import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Tasks, type TaskStatus } from "./Tasks.ts";
import { Triage } from "./Triage.ts";

/**
 * The engineering ledgers, read-only:
 *
 * - `GET /api/tasks`  — the task ledger (`?status=` filters)
 * - `GET /api/triage` — how many inbound items wait in the queue
 */
export const TasksApi = Effect.gen(function* () {
  const tasks = yield* Tasks;
  const triage = yield* Triage;

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
    HttpRouter.add(
      "GET",
      "/api/triage",
      Effect.gen(function* () {
        return yield* HttpServerResponse.json({
          waiting: yield* triage.waiting(),
        });
      }),
    ),
  );
});
