import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

export const Lakehouse = Stackit.Dremio.Instance("DremioBindingsInstance", {
  // No `acl`: any address may connect. A Worker's egress addresses aren't a fixed range, and
  // the data bindings have to reach the instance. Nothing but this suite's queries runs on it.
});

export const Analyst = Lakehouse.pipe(
  Effect.flatMap((lakehouse) =>
    Stackit.Dremio.User("DremioBindingsUser", {
      instanceId: lakehouse.instanceId,
      email: "alchemy-test@example.com",
      firstName: "Alchemy",
      lastName: "Test",
      password: Redacted.make("alchemy-test-Passw0rd-1"),
    }),
  ),
);

/**
 * A Cloudflare Worker with every Dremio binding. One route per binding; each answers
 * `{ ok, result | error }` so a failure surfaces the error in the test.
 */
export default class DremioBindingsWorker extends Cloudflare.Worker<DremioBindingsWorker>()(
  "StackitDremioBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const instance = yield* Lakehouse;
    const user = yield* Analyst;
    const getInstance = yield* Stackit.Dremio.GetInstance(instance);
    const listUsers = yield* Stackit.Dremio.ListUsers(instance);
    const getUser = yield* Stackit.Dremio.GetUser(user);
    const connect = yield* Stackit.Dremio.Connect(user);
    const executeSql = yield* Stackit.Dremio.ExecuteSql(user);
    const getJob = yield* Stackit.Dremio.GetJob(user);
    const getJobResults = yield* Stackit.Dremio.GetJobResults(user);
    const cancelJob = yield* Stackit.Dremio.CancelJob(user);

    const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
      effect.pipe(
        Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
        ),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const id = url.searchParams.get("id") ?? "";
        const sql = url.searchParams.get("sql") ?? "SELECT 1 AS answer";
        switch (url.pathname) {
          case "/get-instance":
            return yield* respond(getInstance({}));
          case "/list-users":
            return yield* respond(listUsers({ pageSize: 100 }));
          case "/get-user":
            return yield* respond(getUser({}));
          case "/connect":
            // The endpoints and user; the password and token never leave the Worker.
            return yield* respond(
              connect.pipe(
                Effect.map((info) => ({
                  uiUrl: info.uiUrl,
                  catalogUrl: info.catalogUrl,
                  arrowFlightUrl: info.arrowFlightUrl,
                  username: info.username,
                  hasPassword: Redacted.value(info.password).length > 0,
                  hasToken: Redacted.value(info.token).length > 0,
                })),
              ),
            );
          case "/execute-sql":
            return yield* respond(executeSql({ sql }));
          case "/get-job":
            return yield* respond(getJob({ id }));
          case "/get-job-results":
            return yield* respond(getJobResults({ id, limit: 10 }));
          case "/cancel-job":
            return yield* respond(cancelJob({ id }));
          // The typed error, not a generic one, is what these two pin.
          case "/get-missing-job":
            return yield* respond(
              getJob({ id: "00000000-0000-0000-0000-000000000000" }).pipe(
                Effect.as("found"),
                Effect.catchTag("JobNotFound", () => Effect.succeed("JobNotFound")),
              ),
            );
          case "/results-not-ready":
            return yield* respond(
              getJobResults({ id }).pipe(
                Effect.as("ready"),
                Effect.catchTag("JobResultsNotReady", () => Effect.succeed("JobResultsNotReady")),
              ),
            );
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Stackit.Dremio.GetInstanceHttp,
        Stackit.Dremio.ListUsersHttp,
        Stackit.Dremio.GetUserHttp,
        Stackit.Dremio.ConnectHttp,
        Stackit.Dremio.ExecuteSqlHttp,
        Stackit.Dremio.GetJobHttp,
        Stackit.Dremio.GetJobResultsHttp,
        Stackit.Dremio.CancelJobHttp,
      ),
    ),
  ),
) {}
