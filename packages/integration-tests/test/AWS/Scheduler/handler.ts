import * as IAM from "@alchemy.run/aws/IAM";
import * as Lambda from "@alchemy.run/aws/Lambda";
import * as Scheduler from "@alchemy.run/aws/Scheduler";
import * as SQS from "@alchemy.run/aws/SQS";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// Shared Lambda fixture for the EventBridge Scheduler runtime surface:
// - CreateSchedule / UpdateSchedule / GetSchedule / DeleteSchedule /
//   ListSchedules bindings, one HTTP route per operation. Runtime-minted
//   schedules target the sink queue, so the test can observe the fire
//   out-of-band.
// - consumeSchedule (the cron-handler DX): a rate(1 minute) schedule invokes
//   this same Lambda; the handler forwards the typed event into the cron
//   queue for out-of-band observation.
export class SchedulerTestFunction extends Lambda.Function<Lambda.Function>()(
  "SchedulerTestFunction",
) {}

export default SchedulerTestFunction.make(
  {
    main,
    functionUrl: true,
    // AWS's 3s default intermittently kills invocations that fan out SDK
    // calls (create + describe schedules) — always set an explicit timeout.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // Queue that runtime-minted one-shot schedules deliver into.
    const sinkQueue = yield* SQS.Queue("SchedulerSinkQueue");
    // Queue the consumeSchedule cron handler forwards its typed events into.
    const cronQueue = yield* SQS.Queue("SchedulerCronQueue");

    // An existing execution role, passed via `{ role }` to cover the
    // bring-your-own-role path. The bindings bound without it declare their
    // own role for the sink queue.
    const executionRole = yield* IAM.Role("SchedulerExecutionRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "scheduler.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
      inlinePolicies: {
        ScheduleTarget: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["sqs:SendMessage"],
              Resource: [sinkQueue.queueArn],
            },
          ],
        },
      },
    });

    const schedule = yield* Scheduler.CreateSchedule(sinkQueue);
    const reschedule = yield* Scheduler.UpdateSchedule(sinkQueue);
    const scheduleWithRole = yield* Scheduler.CreateSchedule(sinkQueue, { role: executionRole });
    // A delayed callback to this same Lambda: the Function target path.
    const self = yield* Lambda.Function;
    const callback = yield* Scheduler.CreateSchedule(self);
    // The route id the consumeSchedule registration below listens on, so a
    // callback carrying its envelope is forwarded into the cron queue.
    const cronRouteId = Scheduler.createScheduleRouteId({ expression: "rate(1 minute)" }, self);
    const getSchedule = yield* Scheduler.GetSchedule();
    const deleteSchedule = yield* Scheduler.DeleteSchedule();
    const listSchedules = yield* Scheduler.ListSchedules();
    const sendCron = yield* SQS.SendMessage(cronQueue);

    // The cron-handler DX: consume this Lambda's own scheduled invocations
    // and forward the typed event into the cron queue.
    yield* Scheduler.consumeSchedule(Scheduler.every("1 minute"), (event) =>
      sendCron({
        MessageBody: JSON.stringify({
          marker: "alch-schedtest-cron-fired",
          scheduleId: event.scheduleId,
          scheduleArn: event.scheduleArn,
          scheduledTime: event.scheduledTime,
          executionId: event.executionId,
        }),
      }).pipe(Effect.orDie, Effect.asVoid),
    );

    const sinkQueueArn = yield* sinkQueue.queueArn;
    const executionRoleArn = yield* executionRole.roleArn;
    const sinkQueueUrl = yield* sinkQueue.queueUrl;
    const cronQueueUrl = yield* cronQueue.queueUrl;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/info") {
          return yield* HttpServerResponse.json({
            ok: true,
            sinkQueueUrl: yield* sinkQueueUrl,
            sinkQueueArn: yield* sinkQueueArn,
            cronQueueUrl: yield* cronQueueUrl,
            executionRoleArn: yield* executionRoleArn,
          });
        }

        if (request.method === "GET" && pathname === "/schedules") {
          const namePrefix = url.searchParams.get("namePrefix") ?? undefined;
          // Surface the typed failure in the body (424 so the test's 5xx
          // retry doesn't mask a genuine error) instead of dying to a 500.
          return yield* listSchedules({ NamePrefix: namePrefix }).pipe(
            Effect.flatMap((listed) =>
              HttpServerResponse.json({
                names: (listed.Schedules ?? []).flatMap((s) => (s.Name ? [s.Name] : [])),
              }),
            ),
            Effect.catch((e) =>
              HttpServerResponse.json({ error: e._tag, message: String(e) }, { status: 424 }),
            ),
          );
        }

        // Raw CreateSchedule request through the `{ role }` binding: Target.Arn
        // and Target.RoleArn are left to the binding's defaults.
        if (request.method === "POST" && pathname.startsWith("/raw-schedules/")) {
          const name = pathname.slice("/raw-schedules/".length);
          const delaySeconds = Number(url.searchParams.get("delaySeconds") ?? "30");
          const fireAt = yield* Effect.sync(() => new Date(Date.now() + delaySeconds * 1000));
          const expression = `at(${fireAt.toISOString().slice(0, 19)})`;
          const created = yield* scheduleWithRole({
            Name: name,
            ScheduleExpression: expression,
            ActionAfterCompletion: "DELETE",
            Target: { Input: JSON.stringify({ marker: name }) },
          });
          return yield* HttpServerResponse.json({ scheduleArn: created.ScheduleArn, expression });
        }

        // One-shot callback into this Lambda. The payload is the cron route's
        // envelope with the schedule name as executionId, so the handler
        // forwards it into the cron queue where the test can see it.
        if (request.method === "POST" && pathname.startsWith("/callbacks/")) {
          const name = pathname.slice("/callbacks/".length);
          const fireAt = yield* Effect.sync(() => new Date(Date.now() + 15_000));
          return yield* callback
            .at(fireAt, {
              name,
              payload: {
                source: "alchemy.scheduler",
                scheduleId: cronRouteId,
                scheduleArn: "callback",
                scheduledTime: fireAt.toISOString(),
                executionId: name,
                attemptNumber: "1",
              },
            })
            .pipe(
              Effect.flatMap((created) =>
                HttpServerResponse.json({ scheduleArn: created.ScheduleArn }),
              ),
              // Surface the typed failure (424 so the 5xx retry doesn't mask it).
              Effect.catch((e) =>
                HttpServerResponse.json({ error: e._tag, message: String(e) }, { status: 424 }),
              ),
            );
        }

        // Recurring schedule through the `every` shortcut.
        if (request.method === "POST" && pathname.startsWith("/recurring-schedules/")) {
          const name = pathname.slice("/recurring-schedules/".length);
          const created = yield* schedule.every("1 day", {
            name,
            payload: { marker: name },
          });
          return yield* HttpServerResponse.json({ scheduleArn: created.ScheduleArn });
        }

        if (pathname.startsWith("/schedules/")) {
          const name = pathname.slice("/schedules/".length);

          if (request.method === "POST") {
            const delaySeconds = Number(url.searchParams.get("delaySeconds") ?? "30");
            const fireAt = yield* Effect.sync(() => new Date(Date.now() + delaySeconds * 1000));
            const expression = `at(${fireAt.toISOString().slice(0, 19)})`;

            // The `at` shortcut: one-shot, deletes itself after it fires.
            const created = yield* schedule
              .at(fireAt, { name, payload: { marker: name } })
              .pipe(Effect.catchTag("ConflictException", () => Effect.succeed(undefined)));

            if (created === undefined) {
              return yield* HttpServerResponse.json(
                { error: "Schedule already exists", name },
                { status: 409 },
              );
            }
            return yield* HttpServerResponse.json({
              scheduleArn: created.ScheduleArn,
              expression,
            });
          }

          if (request.method === "PUT") {
            const delaySeconds = Number(url.searchParams.get("delaySeconds") ?? "900");
            const description = url.searchParams.get("description") ?? undefined;
            const fireAt = yield* Effect.sync(() => new Date(Date.now() + delaySeconds * 1000));
            const expression = `at(${fireAt.toISOString().slice(0, 19)})`;

            // UpdateSchedule is a full PUT; the `at` shortcut sends it all.
            const updated = yield* reschedule
              .at(fireAt, { name, description, payload: { marker: name } })
              .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(undefined)));

            if (updated === undefined) {
              return yield* HttpServerResponse.json({ error: "Not found", name }, { status: 404 });
            }
            return yield* HttpServerResponse.json({
              scheduleArn: updated.ScheduleArn,
              expression,
            });
          }

          if (request.method === "GET") {
            const found = yield* getSchedule({ Name: name }).pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(undefined)),
            );
            if (found === undefined) {
              return yield* HttpServerResponse.json({ error: "Not found", name }, { status: 404 });
            }
            return yield* HttpServerResponse.json({
              arn: found.Arn,
              name: found.Name,
              state: found.State,
              expression: found.ScheduleExpression,
              actionAfterCompletion: found.ActionAfterCompletion,
              targetArn: found.Target?.Arn,
              roleArn: found.Target?.RoleArn,
            });
          }

          if (request.method === "DELETE") {
            const deleted = yield* deleteSchedule({ Name: name }).pipe(
              Effect.as(true),
              Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(false)),
            );
            return yield* HttpServerResponse.json({ deleted }, { status: deleted ? 200 : 404 });
          }
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Scheduler.CreateScheduleHttp,
        Scheduler.UpdateScheduleHttp,
        Scheduler.GetScheduleHttp,
        Scheduler.DeleteScheduleHttp,
        Scheduler.ListSchedulesHttp,
        Lambda.ScheduleEventSource,
        SQS.SendMessageHttp,
      ),
    ),
  ),
);
