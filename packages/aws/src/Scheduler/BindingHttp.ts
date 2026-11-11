/**
 * Shared scaffolding for EventBridge Scheduler HTTP bindings.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the builders
 * below. Everything except the operation and the IAM action list is
 * boilerplate:
 *
 * - **Group-scoped operations** (`scheduler:GetSchedule`,
 *   `scheduler:DeleteSchedule`, `scheduler:ListSchedules`) inject the bound
 *   {@link ScheduleGroup}'s name as the request's `GroupName` and are granted
 *   on the group's schedule ARN pattern. Dynamic schedules are named at
 *   runtime, so the resource pattern is group-scoped rather than an exact
 *   ARN: the group (or the default group) is the least-privilege boundary.
 * - **Write operations** (`scheduler:CreateSchedule`,
 *   `scheduler:UpdateSchedule`) are bound to the schedule's target (a Queue
 *   or Function). They declare the **execution role** EventBridge Scheduler
 *   assumes to deliver to it (unless one is passed) and contribute
 *   `iam:PassRole` on that role — without the PassRole statement the write
 *   fails only at runtime. The target and role are injected as the request's
 *   `Target.Arn`/`Target.RoleArn` unless it overrides them, and
 *   `FlexibleTimeWindow` defaults to `{ Mode: "OFF" }`.
 */
import { createHash } from "node:crypto";
import type * as scheduler from "@distilled.cloud/aws/scheduler";
import * as Binding from "alchemy/Binding";
import type { InputProps } from "alchemy/Input";
import * as Output from "alchemy/Output";
import type { ResourceLike } from "alchemy/Resource";
import { Stack } from "alchemy/Stack";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as AWSBindings from "../AWSBindings.ts";
import { AWSEnvironment } from "../Environment.ts";
import { Role, type RoleProps } from "../IAM/Role.ts";
import type { Key } from "../KMS/Key.ts";
import type { Function as LambdaFunction } from "../Lambda/Function.ts";
import { qualifiedArnOf } from "../Lambda/QualifiedArn.ts";
import type { Queue } from "../SQS/Queue.ts";
import type { ScheduleGroup } from "./ScheduleGroup.ts";
import type {
  AtScheduleOptions,
  RecurringScheduleOptions,
  ScheduleRequestOptions,
  ScheduleTarget,
  ScheduleTargetRequest,
  ScheduleWriteClient,
  ScheduleWriteOptions,
} from "./ScheduleWriteTypes.ts";

/**
 * Resolve the group-scoped schedule ARN pattern the binding is granted on.
 * Passes unresolved Outputs — binding data is resolved by the engine before
 * the host reconciles.
 */
export const scheduleArnPattern = Effect.fn(function* (group: ScheduleGroup | undefined) {
  const { accountId, region } = yield* AWSEnvironment.current as unknown as Effect.Effect<{
    accountId: string;
    region: string;
  }>;
  return group
    ? Output.interpolate`arn:aws:scheduler:${region}:${accountId}:schedule/${group.scheduleGroupName}/*`
    : (`arn:aws:scheduler:${region}:${accountId}:schedule/default/*` as const);
});

/**
 * Account-wide schedule ARN pattern — the resource IAM evaluates
 * `scheduler:ListSchedules` against, regardless of any `GroupName` filter in
 * the request.
 */
const allSchedulesArnPattern = Effect.gen(function* () {
  const { accountId, region } = yield* AWSEnvironment.current as unknown as Effect.Effect<{
    accountId: string;
    region: string;
  }>;
  return `arn:aws:scheduler:${region}:${accountId}:schedule/*/*` as const;
});

/**
 * Build the impl Effect for a group-scoped Scheduler operation: the
 * deploy-time half grants `actions` on the group's schedule ARN pattern, and
 * the runtime half injects the group's name as the request's `GroupName`.
 */
export const makeScheduleGroupScopedHttpBinding = <
  I extends { GroupName?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Scheduler.GetSchedule`. */
  tag: string;
  /** The distilled operation; `GroupName` is injected from the bound group. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the group's schedule ARN pattern. */
  actions: readonly string[];
  /**
   * `GroupName` injected when no group is bound. Get/Delete leave it
   * undefined (the API defaults to the `default` group); ListSchedules pins
   * `"default"` explicitly because an absent `GroupName` there means "all
   * groups".
   */
  fallbackGroupName?: string;
  /**
   * IAM resource scope. `"group"` (default) grants on the bound group's
   * `schedule/{group}/*` pattern. `"all"` grants on `schedule/*​/*` —
   * required for `scheduler:ListSchedules`, which IAM evaluates against the
   * account-wide schedule pattern regardless of the request's `GroupName`
   * filter (AccessDenied cites `schedule/*​/*`).
   */
  resourceScope?: "group" | "all";
}) =>
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const op = yield* AWSBindings.withCredentials(options.operation);

    return Effect.fn(function* (group?: ScheduleGroup) {
      const GroupName = group ? yield* group.scheduleGroupName : undefined;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const pattern =
          options.resourceScope === "all"
            ? yield* allSchedulesArnPattern
            : yield* scheduleArnPattern(group);
        yield* bind`${options.tag}(${group ?? "default"})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: [...options.actions],
              Resource: [pattern],
            },
          ],
        });
      }
      return Effect.fn(`${options.tag}(${group?.LogicalId ?? "default"})`)(function* (
        request?: Omit<I, "GroupName">,
      ) {
        const groupName = GroupName ? yield* GroupName : options.fallbackGroupName;
        return yield* op({
          ...request,
          GroupName: groupName,
        } as I);
      });
    });
  });

/**
 * Props of the execution role EventBridge Scheduler assumes to deliver to
 * `target`: assumable by `scheduler.amazonaws.com`, allowed only to send to
 * the Queue or invoke the Function. The role is declared under the target's logical id,
 * so every host (and both write bindings) binding the same target shares it.
 */
export const executionRolePropsOf = (
  target: ScheduleTarget,
  extras: { deadLetterQueue?: Queue; kmsKey?: Key } = {},
): InputProps<RoleProps> => ({
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
        isQueue(target)
          ? {
              Effect: "Allow",
              Action: ["sqs:SendMessage"],
              Resource: [target.queueArn],
            }
          : {
              Effect: "Allow",
              Action: ["lambda:InvokeFunction"],
              Resource: [functionArnOf(target)],
            },
        // Scheduler sends deliveries it gives up on to the dead-letter queue,
        // and decrypts the target input with the key, both as this role.
        ...(extras.deadLetterQueue
          ? [
              {
                Effect: "Allow" as const,
                Action: ["sqs:SendMessage"],
                Resource: [extras.deadLetterQueue.queueArn as Output.Output<string, never>],
              },
            ]
          : []),
        ...(extras.kmsKey
          ? [
              {
                Effect: "Allow" as const,
                Action: ["kms:Decrypt"],
                Resource: [extras.kmsKey.keyArn as Output.Output<string, never>],
              },
            ]
          : []),
      ],
    },
  },
});

const isQueue = (target: ScheduleTarget): target is Queue => target.Type === "AWS.SQS.Queue";

/** The ARN a schedule delivers to: the queue ARN, or the Function's alias-aware ARN. */
const targetArnOf = (target: ScheduleTarget): Output.Output<string, never> =>
  isQueue(target) ? target.queueArn : functionArnOf(target);

/**
 * The Function's alias-aware ARN. A `Function`'s attribute Outputs carry an
 * open requirement type; the ARN itself resolves from state, so it needs none.
 */
const functionArnOf = (fn: LambdaFunction) => qualifiedArnOf(fn) as Output.Output<string, never>;

const toInput = (payload: unknown) =>
  payload === undefined
    ? undefined
    : typeof payload === "string"
      ? payload
      : JSON.stringify(payload);

/** `at(yyyy-mm-ddThh:mm:ss)` in UTC — Scheduler's one-time expression format. */
const atExpression = (date: Date) => `at(${date.toISOString().slice(0, 19)})`;

const rateExpression = (rate: string) => (rate.startsWith("rate(") ? rate : `rate(${rate})`);

const cronExpression = (expression: string) =>
  expression.startsWith("cron(") ? expression : `cron(${expression})`;

/**
 * An ARN in the deploying account, bound into the host's env from the AWS
 * environment rather than from another resource's output.
 */
export const accountArn = (format: (accountId: string, region: string) => string) =>
  Output.fromEffect(
    AWSEnvironment.use((env) =>
      Effect.map(env, ({ accountId, region }) => format(accountId, region)),
    ).pipe(Effect.orDie),
  ) as Output.Output<string, never>;

/**
 * Bind an {@link accountArn} into the host's env under `key`. Derived
 * Outputs are keyed by their source text by default, which is the same for
 * every `accountArn`, so each one needs its own key.
 */
export const bindAccountArn = (output: Output.Output<string, never>, key: string) =>
  (output as unknown as { bind(key: string): Effect.Effect<Effect.Effect<string>> }).bind(key);

/**
 * The name of a role whose policy names `host`, derived from the stack,
 * stage and host so the host can name the role without reading its output.
 * IAM role names are at most 64 characters.
 */
export const hostRoleName = Effect.fn(function* (host: ResourceLike, kind: string) {
  const stack = yield* Effect.serviceOption(Stack);
  const prefix = Option.isSome(stack)
    ? `${stack.value.name}-${host.LogicalId}-${stack.value.stage}-${kind}-`
    : `${host.LogicalId}-${kind}-`;
  const hash = yield* Effect.sync(() =>
    createHash("sha256").update(`${host.FQN}:${kind}`).digest("hex").slice(0, 12),
  );
  return `${prefix.replaceAll(/[^a-zA-Z0-9-]/g, "-").slice(0, 64 - hash.length)}${hash}`;
});

/**
 * The executing Function's own ARN: the account and region come from the
 * deploy-time AWS environment, the name from the Lambda runtime.
 */
export const selfFunctionArn = Effect.fn(function* (fn: ResourceLike) {
  const prefix = yield* bindAccountArn(
    accountArn((accountId, region) => `arn:aws:lambda:${region}:${accountId}:function:`),
    `${fn.LogicalId}.functionArnPrefix`,
  );
  return Effect.gen(function* () {
    // oxlint-disable-next-line effecttsgo/process-env-in-effect -- reads the executing Lambda's identity
    const name = yield* Effect.sync(() => process.env.AWS_LAMBDA_FUNCTION_NAME);
    return `${yield* prefix}${name}`;
  });
});

/** A schedule write targets the Function it runs in. */
export class ScheduleTargetIsHostError extends Data.TaggedError("ScheduleTargetIsHostError")<{
  readonly message: string;
}> {}

/** The raw request a shortcut (`at`/`every`/`cron`) sends. */
interface WriteRequest {
  Name: string;
  ScheduleExpression: string;
  ScheduleExpressionTimezone?: string;
  StartDate?: Date;
  EndDate?: Date;
  Description?: string;
  State?: string;
  KmsKeyArn?: string;
  ActionAfterCompletion?: string;
  FlexibleTimeWindow?: scheduler.FlexibleTimeWindow;
  Target?: ScheduleTargetRequest;
}

const shortcutRequest = (
  expression: string,
  options: ScheduleRequestOptions & { timezone?: string; actionAfterCompletion?: string },
): WriteRequest => ({
  Name: options.name,
  ScheduleExpression: expression,
  ScheduleExpressionTimezone: options.timezone,
  StartDate: options.startDate,
  EndDate: options.endDate,
  Description: options.description,
  State: options.state,
  ActionAfterCompletion: options.actionAfterCompletion,
  FlexibleTimeWindow: options.flexibleTimeWindow,
  Target: {
    Input: toInput(options.payload),
    RetryPolicy: options.retryPolicy,
    SqsParameters: options.sqs,
  },
});

/**
 * Build the impl Effect for a Scheduler write operation
 * (`CreateSchedule`/`UpdateSchedule`), bound to the schedule's target. The
 * deploy-time half declares the execution role (unless one is passed) and
 * grants `actions` on the group's schedule ARN pattern AND `iam:PassRole` on
 * that role. The runtime client injects the group's name, defaults
 * `FlexibleTimeWindow` to `{ Mode: "OFF" }`, defaults the target's `Arn` and
 * `RoleArn` to the bound target and role, and adds the `at`/`every`/`cron`
 * shortcuts.
 */
export const makeScheduleWriteHttpBinding = <
  I extends {
    GroupName?: string;
    Target: scheduler.Target;
    FlexibleTimeWindow: scheduler.FlexibleTimeWindow;
  },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Scheduler.CreateSchedule`. */
  tag: string;
  /** The distilled operation; group, time window, target and role are injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the group's schedule ARN pattern. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const op = yield* AWSBindings.withCredentials(options.operation);
    const IamRole = yield* Role;

    return Effect.fn(function* <T extends ScheduleTarget>(
      target: T,
      writeOptions: ScheduleWriteOptions = {},
    ) {
      const group = writeOptions.group;
      const host = yield* Binding.Host;
      // A Function can't bind its own ARN into its env (a cycle). Calling
      // back into the host is what `Alchemy.makeCallback` is for.
      if (!isQueue(target) && host !== undefined && host.LogicalId === target.LogicalId) {
        return yield* Effect.die(
          new ScheduleTargetIsHostError({
            message: `${options.tag} can't target "${host.LogicalId}", the Function it runs in. Use Alchemy.makeCallback with AWS.Scheduler.SchedulerCallbacks to call this Function back later.`,
          }),
        );
      }
      const { deadLetterQueue, kmsKey } = writeOptions;
      // One role per target and extras, so bindings with different
      // dead-letter queues or keys never share (and fight over) a role.
      const roleArn = writeOptions.role
        ? (writeOptions.role.roleArn as Output.Output<string, never>)
        : ((yield* IamRole(
            `${target.LogicalId}${deadLetterQueue?.LogicalId ?? ""}${kmsKey?.LogicalId ?? ""}ScheduleExecutionRole`,
            executionRolePropsOf(target, { deadLetterQueue, kmsKey }),
          )).roleArn as Output.Output<string, never>);
      const RoleArn = yield* roleArn;
      const TargetArn = yield* targetArnOf(target);
      const DeadLetterArn = deadLetterQueue ? yield* deadLetterQueue.queueArn : undefined;
      const KmsKeyArn = kmsKey ? yield* kmsKey.keyArn : undefined;
      const GroupName = group ? yield* group.scheduleGroupName : undefined;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const pattern = yield* scheduleArnPattern(group);
        yield* bind`${options.tag}(${target}, ${group ?? "default"})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: [...options.actions],
              Resource: [pattern],
            },
            // CRITICAL: without iam:PassRole on the execution role, the
            // write fails only at runtime with an AccessDenied.
            {
              Effect: "Allow",
              Action: ["iam:PassRole"],
              Resource: [roleArn],
              Condition: {
                StringEquals: {
                  "iam:PassedToService": "scheduler.amazonaws.com",
                },
              },
            },
          ],
        });
      }

      const write = Effect.fn(`${options.tag}(${target.LogicalId})`)(function* (
        request: WriteRequest,
      ) {
        const roleArn = yield* RoleArn;
        const targetArn = yield* TargetArn;
        const groupName = GroupName ? yield* GroupName : undefined;
        const deadLetterArn = DeadLetterArn ? yield* DeadLetterArn : undefined;
        const kmsKeyArn = KmsKeyArn ? yield* KmsKeyArn : undefined;
        return yield* op({
          ...request,
          GroupName: groupName,
          FlexibleTimeWindow: request.FlexibleTimeWindow ?? { Mode: "OFF" },
          KmsKeyArn: request.KmsKeyArn ?? kmsKeyArn,
          Target: {
            ...request.Target,
            Arn: request.Target?.Arn ?? targetArn,
            RoleArn: request.Target?.RoleArn ?? roleArn,
            DeadLetterConfig:
              request.Target?.DeadLetterConfig ??
              (deadLetterArn ? { Arn: deadLetterArn } : undefined),
          },
        } as unknown as I);
      });

      return Object.assign((request: WriteRequest) => write(request), {
        at: (date: Date, at: AtScheduleOptions) =>
          write(
            shortcutRequest(atExpression(date), {
              ...at,
              actionAfterCompletion: at.actionAfterCompletion ?? "DELETE",
            }),
          ),
        every: (rate: string, every: RecurringScheduleOptions) =>
          write(shortcutRequest(rateExpression(rate), every)),
        cron: (expression: string, cron: RecurringScheduleOptions) =>
          write(shortcutRequest(cronExpression(expression), cron)),
      }) satisfies ScheduleWriteClient<WriteRequest, A, E>;
    });
  });
