import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { CAPACITY, CATALOG, PASSWORD } from "./constants.ts";

export const Ingest = Stackit.Intake.Runner("IntakeBindingsRunner", CAPACITY);

export const Events = Ingest.pipe(
  Effect.flatMap((runner) =>
    Stackit.Intake.Intake("IntakeBindingsIntake", { runnerId: runner.runnerId, catalog: CATALOG }),
  ),
);

export const Producer = Events.pipe(
  Effect.flatMap((pipeline) =>
    Stackit.Intake.User("IntakeBindingsUser", { intakeId: pipeline.intakeId, password: PASSWORD }),
  ),
);

/**
 * A Cloudflare Worker with every Intake binding that goes through STACKIT's API. One route
 * per binding; each answers `{ ok, result | error }` so a failure surfaces the STACKIT error
 * in the test. The Kafka bindings run on a host in `kafka-host.ts`.
 */
export default class IntakeBindingsWorker extends Cloudflare.Worker<IntakeBindingsWorker>()(
  "StackitIntakeBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const runner = yield* Ingest;
    const pipeline = yield* Events;
    const user = yield* Producer;
    const getRunner = yield* Stackit.Intake.GetRunner(runner);
    const listRunners = yield* Stackit.Intake.ListRunners(runner);
    const updateRunner = yield* Stackit.Intake.UpdateRunner(runner);
    const getIntake = yield* Stackit.Intake.GetIntake(pipeline);
    const listIntakes = yield* Stackit.Intake.ListIntakes(runner);
    const getUser = yield* Stackit.Intake.GetUser(user);
    const listUsers = yield* Stackit.Intake.ListUsers(pipeline);
    const updateUser = yield* Stackit.Intake.UpdateUser(user);

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
        switch (url.pathname) {
          case "/get-runner":
            return yield* respond(
              getRunner({}).pipe(Effect.map((live) => ({ id: live.id, uri: live.uri }))),
            );
          case "/list-runners":
            return yield* respond(
              listRunners({ pageSize: 100 }).pipe(
                Effect.map(({ intakeRunners }) => intakeRunners.map((live) => live.id)),
              ),
            );
          case "/update-runner":
            return yield* respond(
              updateRunner({ description: url.searchParams.get("description") ?? "" }).pipe(
                Effect.map((live) => ({ id: live.id })),
              ),
            );
          case "/get-intake":
            return yield* respond(
              getIntake({}).pipe(Effect.map((live) => ({ id: live.id, topic: live.topic }))),
            );
          case "/list-intakes":
            return yield* respond(
              listIntakes({ pageSize: 100 }).pipe(
                Effect.map(({ intakes }) => intakes.map((live) => live.id)),
              ),
            );
          case "/get-user":
            return yield* respond(
              getUser({}).pipe(Effect.map((live) => ({ id: live.id, user: live.user }))),
            );
          case "/list-users":
            return yield* respond(
              listUsers({ pageSize: 100 }).pipe(
                Effect.map(({ intakeUsers }) => intakeUsers.map((live) => live.id)),
              ),
            );
          case "/update-user":
            return yield* respond(
              updateUser({ description: url.searchParams.get("description") ?? "" }).pipe(
                Effect.map((live) => ({ id: live.id })),
              ),
            );
          default:
            return HttpServerResponse.text("ok");
        }
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Stackit.Intake.GetRunnerHttp,
        Stackit.Intake.ListRunnersHttp,
        Stackit.Intake.UpdateRunnerHttp,
        Stackit.Intake.GetIntakeHttp,
        Stackit.Intake.ListIntakesHttp,
        Stackit.Intake.GetUserHttp,
        Stackit.Intake.ListUsersHttp,
        Stackit.Intake.UpdateUserHttp,
      ),
    ),
  ),
) {}
