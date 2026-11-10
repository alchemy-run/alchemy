import { createHash, randomUUID } from "node:crypto";
import * as scheduler from "@distilled.cloud/aws/scheduler";
import {
  type Callback,
  CallbackError,
  type CallbackFactory,
  type CallbackOptions,
  type CallbackScheduleOptions,
  type CallbackStatus,
} from "alchemy/Callback";
import type * as Output from "alchemy/Output";
import { CurrentRuntimeContext, RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Scope from "effect/Scope";
import * as Tracer from "effect/Tracer";
import * as AWSBindings from "../AWSBindings.ts";
import { Role } from "../IAM/Role.ts";
import {
  accountArn,
  bindAccountArn,
  hostRoleName,
  scheduleArnPattern,
  selfFunctionArn,
} from "../Scheduler/BindingHttp.ts";
import { ScheduleGroup } from "../Scheduler/ScheduleGroup.ts";
import * as Lambda from "./Function.ts";

/**
 * The Lambda event a callback schedule delivers. The schedule's `Input` is
 * the whole envelope, so the job's scheduling state travels with it.
 */
interface CallbackEnvelope {
  source: "alchemy.callback";
  callback: string;
  id: string;
  /** Unique per write, so a delivery can tell whether its job was replaced. */
  token: string;
  payload: unknown;
  scheduledAt: number;
  retryAt?: number;
  /** Attempts started without progress before this delivery. */
  attempts: number;
  parked: boolean;
  progress?: number;
}

const isCallbackEnvelope = (event: any): event is CallbackEnvelope =>
  event?.source === "alchemy.callback" &&
  typeof event?.callback === "string" &&
  typeof event?.id === "string" &&
  typeof event?.token === "string";

/** The delivery a callback handler is running for, if any. */
const CurrentDelivery = Context.Reference<
  { readonly attempts: number; readonly progress: number | undefined } | undefined
>("AWS.Lambda.Callbacks.CurrentDelivery", { defaultValue: () => undefined });

const defaultRetry = { delay: 30_000, maxAttempts: 8, parkedDelay: 3_600_000 };

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

const validateRetry = (name: string, options: CallbackOptions | undefined) =>
  Effect.try({
    try: () => {
      const delay = Math.ceil(Duration.toMillis(options?.retry?.delay ?? defaultRetry.delay));
      const maxAttempts = options?.retry?.maxAttempts ?? defaultRetry.maxAttempts;
      const parkedDelay = Math.ceil(
        Duration.toMillis(options?.retry?.parkedDelay ?? Math.max(defaultRetry.parkedDelay, delay)),
      );
      if (
        !Number.isSafeInteger(delay) ||
        delay <= 0 ||
        !Number.isSafeInteger(maxAttempts) ||
        maxAttempts < 1 ||
        !Number.isSafeInteger(parkedDelay) ||
        parkedDelay < 3_600_000 ||
        parkedDelay < delay
      ) {
        throw new Error(
          "Retry delay must be positive, maxAttempts a positive safe integer, and parkedDelay at least one hour and the retry delay",
        );
      }
      return { delay: Math.max(1_000, delay), maxAttempts, parkedDelay };
    },
    catch: (cause) =>
      new CallbackError({ callback: name, message: "Invalid callback retry policy", cause }),
  });

/**
 * Durable callbacks for a Lambda Function, backed by EventBridge Scheduler.
 *
 * Provide it to a Function to use `Alchemy.makeCallback`. Register each
 * callback with a name and a handler while the Function initializes; the
 * Function routes every scheduled invocation to the handler registered under
 * its name. `schedule(id, ...)` creates a one-time schedule that invokes the
 * Function itself, `cancel(id)` deletes it, and `getStatus(id)` reads it.
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
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const onExpire = yield* Alchemy.makeCallback(
 *       "expire",
 *       Effect.fn(function* ({ orderId }: { orderId: string }) {
 *         yield* expireOrder(orderId);
 *       }),
 *     );
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const orderId = yield* createOrder;
 *         yield* onExpire.schedule(orderId, { after: "1 hour", payload: { orderId } });
 *         return HttpServerResponse.text(orderId);
 *       }),
 *     };
 *   }).pipe(Effect.provide(AWS.Lambda.Callbacks)),
 * );
 * ```
 *
 * **Example:** Cancel Or Replace A Pending Job
 * ```typescript
 * // the same ID replaces the pending job
 * yield* onExpire.schedule(orderId, { after: "2 hours", payload: { orderId } });
 * yield* onExpire.cancel(orderId);
 * ```
 *
 * ### Retries
 * A handler that fails is retried with exponential backoff, starting at
 * `retry.delay` (30 seconds by default). After `retry.maxAttempts` (eight)
 * attempts without progress the job is parked and retried every
 * `retry.parkedDelay` (one hour). `getStatus` reports the attempts, whether
 * the job is parked, and when it runs next.
 *
 * **Example:** Configure Retries
 * ```typescript
 * const onExpire = yield* Alchemy.makeCallback("expire", expire, {
 *   retry: { delay: "10 seconds", maxAttempts: 3 },
 * });
 * ```
 *
 * Delivery is at least once, so handlers must be idempotent. A job runs at
 * its time or up to about a minute later. Payloads are JSON, and a job's
 * envelope must fit in Scheduler's 8 KB target input. Scheduling and
 * cancelling are separate API calls, not part of a transaction. A successful
 * delivery deletes its job unless the job was replaced while it ran; the
 * check and the delete are two calls, so a replacement made between them can
 * be lost. A callback to the Function invokes its unqualified ARN, even when
 * the Function routes through an alias.
 *
 * @binding
 */
export const Callbacks = Layer.effect(
  RuntimeContext,
  Effect.gen(function* () {
    // Read optionally: a Function's init runs with its RuntimeContext, but
    // can't name it as a requirement.
    const runtime = yield* CurrentRuntimeContext;
    if (runtime === undefined) {
      return yield* Effect.die(
        new CallbackError({
          callback: "*",
          message: "AWS.Lambda.Callbacks must be provided to an AWS.Lambda.Function",
        }),
      );
    }
    const host = yield* Lambda.eventSourceHost("AWS.Lambda.Callbacks");
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
      yield* bind`AWS.Lambda.Callbacks(${host})`({
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
    const put = (envelope: CallbackEnvelope, runAt: number) =>
      Effect.gen(function* () {
        const request = {
          Name: scheduleNameOf(envelope.callback, envelope.id),
          GroupName: yield* GroupName,
          ScheduleExpression: atExpression(runAt),
          FlexibleTimeWindow: { Mode: "OFF" },
          Target: {
            Arn: yield* FunctionArn,
            RoleArn: yield* RoleArn,
            Input: JSON.stringify(envelope),
            // Failed handlers are retried by the delivery itself; a failed
            // invocation is not retried by Scheduler as well.
            RetryPolicy: { MaximumRetryAttempts: 0 },
          },
        };
        yield* createSchedule(request).pipe(
          Effect.catchTag("ConflictException", () => updateSchedule(request)),
        );
      }).pipe(Effect.mapError(failed(envelope.callback, "Failed to schedule callback job")));

    /** Delete a job if it is still the write `token` made. */
    const removeIfCurrent = (envelope: CallbackEnvelope) =>
      Effect.gen(function* () {
        const name = scheduleNameOf(envelope.callback, envelope.id);
        const current = yield* read(envelope.callback, name);
        if (current?.token !== envelope.token) return;
        yield* deleteSchedule({ Name: name, GroupName: yield* GroupName }).pipe(
          Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          Effect.mapError(failed(envelope.callback, "Failed to acknowledge callback job")),
        );
      });

    type Registration = {
      readonly retry: { delay: number; maxAttempts: number; parkedDelay: number };
      readonly run: (payload: unknown) => Effect.Effect<unknown, unknown>;
    };
    const registry = new Map<string, Registration>();

    const deliver = (envelope: CallbackEnvelope) =>
      Effect.gen(function* () {
        const registration = registry.get(envelope.callback);
        if (!registration) {
          return yield* Effect.die(
            new CallbackError({
              callback: envelope.callback,
              message: `No callback named "${envelope.callback}" is registered in ${host.LogicalId}`,
            }),
          );
        }
        const { retry } = registration;
        const attempts = Math.min(envelope.attempts + 1, retry.maxAttempts);
        const exit = yield* registration
          .run(envelope.payload)
          .pipe(
            Effect.provideService(CurrentDelivery, { attempts, progress: envelope.progress }),
            Effect.exit,
          );
        if (Exit.isSuccess(exit)) {
          return yield* removeIfCurrent(envelope);
        }
        if (Cause.hasInterruptsOnly(exit.cause)) {
          return yield* Effect.failCause(exit.cause);
        }
        yield* Effect.logWarning(
          `Callback "${envelope.callback}" (${envelope.id}) failed`,
          exit.cause,
        );
        // Retry only the job this delivery is for: a job replaced or
        // cancelled while the handler ran stays as it is.
        const current = yield* read(
          envelope.callback,
          scheduleNameOf(envelope.callback, envelope.id),
        );
        if (current?.token !== envelope.token) return;
        const parked = attempts >= retry.maxAttempts;
        const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
        const retryAt =
          now + (parked ? retry.parkedDelay : retry.delay * 2 ** Math.max(0, attempts - 1));
        yield* put({ ...envelope, token: randomUUID(), attempts, parked, retryAt }, retryAt);
      });

    yield* host.listen(
      Effect.sync(
        () => (event: any) =>
          isCallbackEnvelope(event) ? deliver(event).pipe(Effect.orDie) : undefined,
      ),
    );

    const makeCallback = <Payload, E, R>(
      name: string,
      handler: (payload: Payload) => Effect.Effect<unknown, E, R>,
      options?: CallbackOptions,
    ): Effect.Effect<Callback<Payload>, never, RuntimeContext | Exclude<R, Scope.Scope>> =>
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
        const retry = yield* validateRetry(name, options).pipe(Effect.orDie);
        registry.set(name, {
          retry,
          run: (payload) =>
            Effect.gen(function* () {
              const invocation = yield* Effect.context<never>();
              return yield* handler(payload as Payload).pipe(
                Effect.provide(Context.merge(invocation, context) as Context.Context<R>),
              );
            }),
        });

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
              (progress !== undefined && (!Number.isSafeInteger(progress) || progress < 0))
            ) {
              return yield* new CallbackError({
                callback: name,
                message:
                  "Callback jobs need a non-empty ID, a positive delivery time, and a nonnegative safe integer progress",
              });
            }
            const delivery = yield* CurrentDelivery;
            const advanced =
              progress !== undefined &&
              (delivery?.progress === undefined || progress > delivery.progress);
            if (delivery === undefined && progress !== undefined) {
              // A replayed external schedule can't replace newer work.
              const existing = yield* read(name, scheduleNameOf(name, id));
              if (existing?.progress !== undefined && existing.progress > progress) return;
            }
            // Scheduling inside a handler inherits its budget unless it
            // reports progress.
            const attempts = delivery !== undefined && !advanced ? delivery.attempts : 0;
            const parked = attempts >= retry.maxAttempts;
            const runAt = parked ? Math.max(scheduledAt, now + retry.parkedDelay) : scheduledAt;
            yield* put(
              {
                source: "alchemy.callback",
                callback: name,
                id,
                token: randomUUID(),
                payload: scheduling.payload,
                scheduledAt,
                retryAt: parked ? runAt : undefined,
                attempts,
                parked,
                progress: progress ?? delivery?.progress,
              },
              runAt,
            );
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
              envelope && {
                scheduledAt: envelope.scheduledAt,
                retryAt: envelope.retryAt,
                attempts: envelope.attempts,
                parked: envelope.parked,
                progress: envelope.progress,
              },
          );

        return { schedule, cancel, getStatus } satisfies Callback<Payload>;
      });

    return { ...runtime, makeCallback: makeCallback as CallbackFactory };
  }),
);
