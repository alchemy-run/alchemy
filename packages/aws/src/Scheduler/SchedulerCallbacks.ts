import { createHash, randomUUID } from "node:crypto";
import * as scheduler from "@distilled.cloud/aws/scheduler";
import {
  type Callback,
  CallbackError,
  type CallbackFactory,
  Callbacks,
  type CallbackScheduleOptions,
  type CallbackStatus,
} from "alchemy/Callback";
import type * as Output from "alchemy/Output";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Tracer from "effect/Tracer";
import * as AWSBindings from "../AWSBindings.ts";
import { Role } from "../IAM/Role.ts";
import { eventSourceHost } from "../Lambda/Function.ts";
import {
  accountArn,
  bindAccountArn,
  hostRoleName,
  scheduleArnPattern,
  selfFunctionArn,
} from "./BindingHttp.ts";
import { ScheduleGroup } from "./ScheduleGroup.ts";

/**
 * The Lambda event a callback schedule delivers. The schedule's `Input` is
 * the whole envelope, so the job's state travels with it.
 */
interface CallbackEnvelope {
  source: "alchemy.callback";
  callback: string;
  id: string;
  /** Unique per write, so a delivery can tell whether its job was replaced. */
  token: string;
  payload: unknown;
  scheduledAt: number;
  progress?: number;
}

const isCallbackEnvelope = (event: any): event is CallbackEnvelope =>
  event?.source === "alchemy.callback" &&
  typeof event?.callback === "string" &&
  typeof event?.id === "string" &&
  typeof event?.token === "string";

/** `at(yyyy-mm-ddThh:mm:ss)` in UTC, Scheduler's one-time expression format. */
const atExpression = (ms: number) => `at(${new Date(ms).toISOString().slice(0, 19)})`;

const sanitize = (value: string) => value.replaceAll(/[^0-9a-zA-Z\-_.]/g, "_");

/**
 * The schedule name for a job: readable prefixes of the callback name and ID
 * plus a hash of both, so distinct jobs never share a name. At most 60
 * characters, within Scheduler's 64.
 */
const scheduleNameOf = (callback: string, id: string) =>
  `${sanitize(callback).slice(0, 16)}-${sanitize(id).slice(0, 30)}-${createHash("sha256")
    .update(`${callback}\u0000${id}`)
    .digest("hex")
    .slice(0, 12)}`;

const parseEnvelope = (input: string | undefined): CallbackEnvelope | undefined => {
  if (input === undefined) return undefined;
  try {
    const value = JSON.parse(input);
    return isCallbackEnvelope(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Durable callbacks on EventBridge Scheduler, for a Lambda Function.
 *
 * Provide it to a Function to use `Alchemy.makeCallback`. Register each
 * callback while the Function initializes; the Function routes every
 * scheduled invocation to the handler registered under its name.
 * `schedule(id, ...)` creates a one-time schedule that invokes the Function
 * itself, `cancel(id)` deletes it, and `getStatus(id)` reads it.
 *
 * At deploy time the layer declares a schedule group for the Function, a
 * role EventBridge Scheduler assumes to invoke it, and grants the Function
 * `scheduler:CreateSchedule`, `UpdateSchedule`, `DeleteSchedule` and
 * `GetSchedule` on that group plus `iam:PassRole` on the role. Destroying
 * the stack deletes the group and every pending job in it.
 *
 * ### Calling A Function Back Later
 * **Example:** Expire An Order In An Hour
 * ```typescript
 * export default Orders.make(
 *   { main: import.meta.url, functionUrl: true },
 *   Effect.gen(function* () {
 *     const onExpire = yield* Alchemy.makeCallback(
 *       "expire",
 *       Effect.fn(function* ({ orderId }: { orderId: string }) {
 *         yield* expireOrder(orderId).pipe(
 *           Effect.retry({ schedule: Schedule.exponential("1 second"), times: 3 }),
 *           Effect.orDie,
 *         );
 *       }),
 *     );
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const orderId = yield* placeOrder;
 *         // the same ID replaces a pending job; onExpire.cancel(orderId) removes it
 *         yield* onExpire.schedule(orderId, { after: "1 hour", payload: { orderId } });
 *         return yield* HttpServerResponse.json({ orderId });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(AWS.Scheduler.SchedulerCallbacks)),
 * );
 * ```
 *
 * ### Redelivery
 * Scheduler invokes the Function asynchronously, and retries the invoke
 * itself (throttling, an unavailable Function) for up to 24 hours. A handler
 * that dies (a defect, a timeout, running out of memory) fails the
 * invocation, which the Function's `eventInvokeConfig` retries: twice by
 * default, then the event goes to its `OnFailure` destination.
 *
 * **Example:** Send Jobs That Keep Failing To A Queue
 * ```typescript
 * export default Orders.make(
 *   Effect.gen(function* () {
 *     const failed = yield* FailedCallbacks;
 *     return {
 *       main: import.meta.url,
 *       eventInvokeConfig: {
 *         maximumRetryAttempts: 2,
 *         destinationConfig: { OnFailure: { Destination: failed.queueArn } },
 *       },
 *     };
 *   }),
 *   impl.pipe(Effect.provide(AWS.Scheduler.SchedulerCallbacks)),
 * );
 * ```
 *
 * Delivery is at least once, so handlers must be idempotent. A job runs at
 * its time or up to about a minute later. Payloads are JSON, and a job must
 * fit in Scheduler's 8 KB target input. Scheduling and cancelling are API
 * calls, not part of a transaction. A successful delivery deletes its job
 * unless the job was replaced while it ran; the check and the delete are two
 * calls, so a replacement made between them can be lost. A job that runs out
 * of retries keeps its spent schedule in the group until the stack is
 * destroyed. A callback invokes the Function's unqualified ARN, even when the
 * Function routes through an alias.
 *
 * @binding
 */
export const SchedulerCallbacks = Layer.effect(
  Callbacks,
  Effect.gen(function* () {
    const host = yield* eventSourceHost("AWS.Scheduler.SchedulerCallbacks");
    const bind = yield* AWSBindings.Bind;
    const IamRole = yield* Role;
    const Group = yield* ScheduleGroup;
    const createSchedule = yield* AWSBindings.withCredentials(scheduler.createSchedule);
    const updateSchedule = yield* AWSBindings.withCredentials(scheduler.updateSchedule);
    const deleteSchedule = yield* AWSBindings.withCredentials(scheduler.deleteSchedule);
    const getSchedule = yield* AWSBindings.withCredentials(scheduler.getSchedule);

    // The Function can't hold its own ARN or the ARN of a role whose policy
    // names it in its env (both are cycles), so the role gets a name derived
    // from the host and both ARNs are built from the account, region and
    // function name instead.
    const group = yield* Group(`${host.LogicalId}Callbacks`, {});
    const roleName = yield* hostRoleName(host, "callbacks");
    yield* IamRole(`${host.LogicalId}CallbacksRole`, {
      roleName,
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
        InvokeFunction: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["lambda:InvokeFunction"],
              Resource: [host.functionArn as Output.Output<string, never>],
            },
          ],
        },
      },
    });
    const roleArn = accountArn((accountId) => `arn:aws:iam::${accountId}:role/${roleName}`);
    const RoleArn = yield* bindAccountArn(roleArn, `${host.LogicalId}.callbacksRoleArn`);
    const FunctionArn = yield* selfFunctionArn(host);
    const GroupName = yield* group.scheduleGroupName;

    if (!globalThis.__ALCHEMY_RUNTIME__) {
      yield* bind`AWS.Scheduler.SchedulerCallbacks(${host})`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: [
              "scheduler:CreateSchedule",
              "scheduler:UpdateSchedule",
              "scheduler:DeleteSchedule",
              "scheduler:GetSchedule",
            ],
            Resource: [yield* scheduleArnPattern(group)],
          },
          {
            Effect: "Allow",
            Action: ["iam:PassRole"],
            Resource: [roleArn],
            Condition: {
              StringEquals: { "iam:PassedToService": "scheduler.amazonaws.com" },
            },
          },
        ],
      });
    }

    const failed = (callback: string, message: string) => (cause: unknown) =>
      new CallbackError({ callback, message, cause });

    /** Read a job's envelope, or `undefined` when no job exists. */
    const read = (callback: string, name: string) =>
      Effect.gen(function* () {
        const found = yield* getSchedule({ Name: name, GroupName: yield* GroupName }).pipe(
          Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(undefined)),
        );
        return found ? parseEnvelope(found.Target?.Input) : undefined;
      }).pipe(Effect.mapError(failed(callback, "Failed to read callback job")));

    /** Create or replace a job. */
    const put = (envelope: CallbackEnvelope) =>
      Effect.gen(function* () {
        const request = {
          Name: scheduleNameOf(envelope.callback, envelope.id),
          GroupName: yield* GroupName,
          ScheduleExpression: atExpression(envelope.scheduledAt),
          FlexibleTimeWindow: { Mode: "OFF" },
          Target: {
            Arn: yield* FunctionArn,
            RoleArn: yield* RoleArn,
            Input: JSON.stringify(envelope),
          },
        };
        yield* createSchedule(request).pipe(
          Effect.catchTag("ConflictException", () => updateSchedule(request)),
        );
      }).pipe(Effect.mapError(failed(envelope.callback, "Failed to schedule callback job")));

    const registry = new Map<string, (payload: unknown) => Effect.Effect<unknown>>();

    // A handler can't fail, so a delivery fails only on a defect: the
    // invocation fails and the Function's eventInvokeConfig retries it.
    const deliver = (envelope: CallbackEnvelope) =>
      Effect.gen(function* () {
        const run = registry.get(envelope.callback);
        if (!run) {
          return yield* Effect.die(
            new CallbackError({
              callback: envelope.callback,
              message: `No callback named "${envelope.callback}" is registered in ${host.LogicalId}`,
            }),
          );
        }
        yield* Effect.scoped(run(envelope.payload));
        // Acknowledge: delete the job unless it was replaced while it ran.
        const name = scheduleNameOf(envelope.callback, envelope.id);
        const current = yield* read(envelope.callback, name);
        if (current?.token !== envelope.token) return;
        yield* deleteSchedule({ Name: name, GroupName: yield* GroupName }).pipe(
          Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          Effect.mapError(failed(envelope.callback, "Failed to acknowledge callback job")),
        );
      }).pipe(Effect.orDie);

    yield* host.listen(
      Effect.sync(() => (event: any) => (isCallbackEnvelope(event) ? deliver(event) : undefined)),
    );

    const make = <Payload, R>(
      name: string,
      handler: (payload: Payload) => Effect.Effect<unknown, never, R>,
    ): Effect.Effect<Callback<Payload>, never, Exclude<R, Scope.Scope>> =>
      Effect.gen(function* () {
        const context = (yield* Effect.context<Exclude<R, Scope.Scope>>()).pipe(
          Context.omit(
            RuntimeContext,
            Scope.Scope,
            Tracer.ParentSpan,
            Tracer.Tracer,
            Logger.CurrentLoggers,
          ),
        );
        if (!name || registry.has(name)) {
          return yield* Effect.die(
            new CallbackError({
              callback: name,
              message: "Callback names must be non-empty and unique within a Function",
            }),
          );
        }
        registry.set(name, (payload) =>
          Effect.gen(function* () {
            const invocation = yield* Effect.context<never>();
            return yield* handler(payload as Payload).pipe(
              Effect.provide(Context.merge(invocation, context) as Context.Context<R>),
            );
          }),
        );

        const schedule = (id: string, scheduling: CallbackScheduleOptions<Payload>) =>
          Effect.gen(function* () {
            const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
            const scheduledAt =
              scheduling.at !== undefined
                ? typeof scheduling.at === "number"
                  ? scheduling.at
                  : scheduling.at.getTime()
                : now + Duration.toMillis(scheduling.after);
            const progress = scheduling.progress;
            if (
              !id ||
              !Number.isFinite(scheduledAt) ||
              scheduledAt <= 0 ||
              !Schema.is(Schema.Json)(scheduling.payload) ||
              (progress !== undefined && (!Number.isSafeInteger(progress) || progress < 0))
            ) {
              return yield* new CallbackError({
                callback: name,
                message:
                  "Callback jobs need a non-empty ID, a positive delivery time, a JSON payload and a nonnegative safe integer progress",
              });
            }
            const existing =
              progress === undefined ? undefined : yield* read(name, scheduleNameOf(name, id));
            // A replayed schedule can't replace newer work.
            if (
              progress !== undefined &&
              existing?.progress !== undefined &&
              progress < existing.progress
            ) {
              return;
            }
            yield* put({
              source: "alchemy.callback",
              callback: name,
              id,
              token: randomUUID(),
              payload: scheduling.payload,
              scheduledAt,
              progress,
            });
          });

        const cancel = (id: string) =>
          Effect.gen(function* () {
            yield* deleteSchedule({
              Name: scheduleNameOf(name, id),
              GroupName: yield* GroupName,
            }).pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));
          }).pipe(Effect.mapError(failed(name, "Failed to cancel callback job")));

        const getStatus = (id: string) =>
          Effect.map(
            read(name, scheduleNameOf(name, id)),
            (envelope): CallbackStatus | undefined =>
              envelope && { scheduledAt: envelope.scheduledAt, progress: envelope.progress },
          );

        return { schedule, cancel, getStatus } satisfies Callback<Payload>;
      });

    return { make: make as CallbackFactory };
  }),
);
