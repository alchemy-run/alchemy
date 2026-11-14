import * as ECS from "@distilled.cloud/aws/ecs";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import { makeFetchRpcStub } from "alchemy/Rpc";
import * as Sandbox from "alchemy/Sandbox";
import {
  makeSandboxAgentClient,
  SANDBOX_AGENT_PORT,
  SANDBOX_IDLE_TIMEOUT_ENV,
  SANDBOX_TOKEN_ENV,
  SandboxAgentError,
  type SandboxAgentRpc,
} from "alchemy/SandboxAgentClient";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as AWSBindings from "../AWSBindings.ts";
import { SecurityGroup, type SecurityGroupId } from "../EC2/SecurityGroup.ts";
import { SecurityGroupRule } from "../EC2/SecurityGroupRule.ts";
import type { VpcId } from "../EC2/Vpc.ts";
import type { CapacityProvider } from "./CapacityProvider.ts";
import {
  CreateSandbox,
  EcsSandboxNotFound,
  EcsSandboxStartFailed,
  type CreateSandboxOptions,
  type CreateSandboxProps,
  type EcsSandbox,
  type EcsSandboxes,
  type EcsSandboxInfo,
  type ListSandboxesOptions,
} from "./CreateSandbox.ts";
import type { Task } from "./Task.ts";

/** Marks the tasks this binding starts, in the console and in `describeTasks`. */
const STARTED_BY = "alchemy-sandbox";

/** `describeTasks` takes this many tasks a call. */
const DESCRIBE_BATCH = 100;

// Pre-typed: literal action tuples in a policy statement make the statement
// union too complex for the compiler.
const runTaskActions: string[] = ["ecs:RunTask"];
const tagTaskActions: string[] = ["ecs:TagResource"];
const taskActions: string[] = ["ecs:StopTask", "ecs:DescribeTasks"];
const listTasksActions: string[] = ["ecs:ListTasks"];
const passRoleActions: string[] = ["iam:PassRole"];

/** The task is not running yet; `create` keeps waiting. */
class EcsSandboxStarting extends Data.TaggedError("EcsSandboxStarting")<{
  readonly status: string;
}> {}

/** The capacity provider has no subnets or instances of its own to run sandboxes on. */
class EcsSandboxCapacityWithoutVpc extends Data.TaggedError("EcsSandboxCapacityWithoutVpc")<{
  readonly message: string;
}> {}

/** The Task's `main` is a script, which cannot serve the sandbox agent. */
class EcsSandboxTaskWithoutAgent extends Data.TaggedError("EcsSandboxTaskWithoutAgent")<{
  readonly message: string;
}> {}

const startingStatuses = new Set(["PROVISIONING", "PENDING", "ACTIVATING"]);

const revisionlessTaskDefinitionArn = (arn: string) => arn.replace(/:\d+$/, "");

/** `arn:...:task-definition/family:7` → `family`. */
const taskDefinitionFamilyOf = (arn: string) =>
  revisionlessTaskDefinitionArn(arn).split("/").pop()!;

/** A capacity provider names its cluster by name or ARN. */
const clusterNameOf = (cluster: string | undefined) => cluster?.split("/").pop() ?? "default";

/** An ECS ARN in the capacity provider's partition, region and account. */
const ecsArn = (capacityProviderArn: string, resource: string) => {
  const [, partition, , region, accountId] = capacityProviderArn.split(":");
  return `arn:${partition}:ecs:${region}:${accountId}:${resource}`;
};

const randomToken = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

const chunksOf = <A>(items: readonly A[], size: number): A[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  );

/** The token `create` passed the sandbox's container when it started the task. */
const tokenOf = (task: ECS.Task): string | undefined =>
  task.overrides?.containerOverrides
    ?.flatMap((container) => container.environment ?? [])
    .find((variable) => variable.name === SANDBOX_TOKEN_ENV)?.value;

/** The private address of the task's network interface. */
const privateIpOf = (task: ECS.Task): string | undefined =>
  task.attachments
    ?.flatMap((attachment) => attachment.details ?? [])
    .find((detail) => detail.name === "privateIPv4Address")?.value ??
  task.containers
    ?.flatMap((container) => container.networkInterfaces ?? [])
    .find((network) => network.privateIpv4Address !== undefined)?.privateIpv4Address;

const tagsOf = (task: ECS.Task): Record<string, string> =>
  Object.fromEntries(
    (task.tags ?? []).flatMap((tag) =>
      tag.key === undefined ? [] : [[tag.key, tag.value ?? ""] as const],
    ),
  );

/** A value or an Output of it, as an Output that needs nothing to resolve. */
const output = <A>(value: A | Output.Output<A>) =>
  Output.asOutput(value) as Output.Output<A, never>;

type OwnerTags = {
  "alchemy::stack"?: string;
  "alchemy::stage"?: string;
  "alchemy::id"?: string;
};

const parseOwnerTags = (json: string): OwnerTags => {
  try {
    return JSON.parse(json || "{}");
  } catch {
    return {};
  }
};

/**
 * The stack, stage and host that own the sandboxes this binding starts,
 * bound onto the host at deploy and read back when it runs.
 */
const bindOwnerTags = Effect.gen(function* () {
  let tags = "{}";
  if (!globalThis.__ALCHEMY_RUNTIME__) {
    const host = yield* Binding.Host;
    const stack = yield* Effect.serviceOption(Stack);
    const stage = yield* Effect.serviceOption(Stage);
    if (host !== undefined && Option.isSome(stack) && Option.isSome(stage)) {
      tags = JSON.stringify({
        "alchemy::stack": stack.value.name,
        "alchemy::stage": stage.value,
        "alchemy::id": host.LogicalId,
      } satisfies OwnerTags);
    }
  }
  const bound = yield* Output.named(output<string | OwnerTags>(tags), "ECS_SANDBOX_OWNER_TAGS");
  // The host's environment hands a JSON value back parsed.
  return Effect.map(bound, (value) => (typeof value === "string" ? parseOwnerTags(value) : value));
});

/** Sends a request with the runtime's `fetch`; the handle needs no client from its caller. */
const execute = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.HttpClient.pipe(
    Effect.flatMap((client) => client.execute(request)),
    Effect.provide(FetchHttpClient.layer),
  );

/**
 * Runs `AWS.ECS.CreateSandbox` over the ECS API and each sandbox's private
 * address.
 *
 * The host is granted `ecs:RunTask` on the Task's definition, `iam:PassRole`
 * on its roles, and stop, describe and list on the cluster's tasks.
 *
 * Sandboxes join the capacity provider's task security group, which admits
 * nothing by default. The binding creates a security group for the host and
 * a rule that admits it into the sandboxes' group, so the host reaches every
 * port of a sandbox, and a sandbox reaches neither the host nor another
 * sandbox. A Lambda Function host joins its group and the capacity's subnets
 * for you. An ECS Service or Task host does not: pass `securityGroups` that
 * admit it.
 *
 * ### Provide the layer
 * **Example:** A Lambda Function that creates sandboxes
 * ```typescript
 * export default class Api extends AWS.Lambda.Function<Api>()(
 *   "Api",
 *   { main: import.meta.filename, functionUrl: true, timeout: Duration.minutes(5) },
 *   Effect.gen(function* () {
 *     const capacity = yield* Capacity;
 *     const sandboxes = yield* AWS.ECS.CreateSandbox(capacity, MySandbox);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const sandbox = yield* sandboxes.create({ idleTimeout: "15 minutes" });
 *         const run = yield* sandbox.exec("uname -a");
 *         return HttpServerResponse.text(run.stdout);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(AWS.ECS.CreateSandboxHttp)),
 * ) {}
 * ```
 *
 * @layer
 * @product Sandbox
 * @provides AWS.ECS.CreateSandbox
 */
export const CreateSandboxHttp = Layer.effect(
  CreateSandbox,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const runTask = yield* AWSBindings.withCredentials(ECS.runTask);
    const stopTask = yield* AWSBindings.withCredentials(ECS.stopTask);
    const describeTasks = yield* AWSBindings.withCredentials(ECS.describeTasks);
    const listTasks = yield* AWSBindings.withCredentials(ECS.listTasks);
    // Only a deploy declares the host's security group and its rule; a
    // running host reads the ids.
    const Group = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* SecurityGroup;
    const GroupRule = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* SecurityGroupRule;

    const listTaskArns = (
      cluster: string,
      family: string,
      nextToken?: string,
    ): Effect.Effect<string[], ECS.ListTasksError> =>
      Effect.flatMap(
        listTasks({ cluster, family, desiredStatus: "RUNNING", nextToken }),
        (page): Effect.Effect<string[], ECS.ListTasksError> =>
          page.nextToken === undefined || page.nextToken === null
            ? Effect.succeed(page.taskArns ?? [])
            : Effect.map(listTaskArns(cluster, family, page.nextToken), (rest) => [
                ...(page.taskArns ?? []),
                ...rest,
              ]),
      );

    return Effect.fn("AWS.ECS.CreateSandbox")(function* (
      capacity: CapacityProvider,
      task: Task,
      props?: CreateSandboxProps,
    ) {
      const key = `ECS_SANDBOX_${capacity.LogicalId}_${task.LogicalId}`;
      const subnets = output<string[]>(props?.subnets ?? capacity.subnets);

      // Sandboxes join the group the capacity provider owns for its tasks.
      // The provider stops its tasks before it deletes that group, so a
      // destroy never waits on a sandbox that is still running.
      const sandboxGroupId = Output.map(capacity.taskSecurityGroupId, (groupId) => groupId ?? "");
      // A Task with a program serves the sandbox agent on the program's
      // port. A Task that is only an image has the agent mounted into its
      // container, on the agent's own port.
      const taskProps = task.Props as { main?: string; isExternal?: boolean } | undefined;
      const imageOnly = taskProps !== undefined && taskProps.main === undefined;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        if (taskProps?.main !== undefined && taskProps.isExternal === true) {
          return yield* Effect.die(
            new EcsSandboxTaskWithoutAgent({
              message: `AWS.ECS.CreateSandbox cannot run a sandbox agent in '${task.LogicalId}': its main is a script with no Effect program. Give the Task an Effect program, or build it from an image or a context.`,
            }),
          );
        }
        // Tells the Task its runs are sandboxes, whatever creates them.
        yield* task.bind`AWS.ECS.CreateSandbox(${capacity})`({ sandbox: true });
        const host = yield* Binding.Host;
        if (host !== undefined && Group !== undefined && GroupRule !== undefined) {
          const withoutInstances = () =>
            Effect.die(
              new EcsSandboxCapacityWithoutVpc({
                message: `AWS.ECS.CreateSandbox needs a Managed Instances capacity provider with subnets; '${capacity.LogicalId}' has none.`,
              }),
            );
          const vpcId = capacity.vpcId.pipe(
            Output.mapEffect((vpcId) =>
              vpcId === undefined ? withoutInstances() : Effect.succeed(vpcId as VpcId),
            ),
          );
          const taskGroupId = capacity.taskSecurityGroupId.pipe(
            Output.mapEffect((groupId) =>
              groupId === undefined
                ? withoutInstances()
                : Effect.succeed(groupId as SecurityGroupId),
            ),
          );
          // The sandboxes' group admits the host's group and nothing else,
          // so the host reaches every port of a sandbox, and a sandbox
          // reaches neither the host nor another sandbox through them.
          const hostGroup = yield* Group(`${host.LogicalId}${task.LogicalId}SandboxHost`, {
            vpcId,
            description: `${host.LogicalId}, the host of ${task.LogicalId} sandboxes`,
          });
          yield* GroupRule(`${host.LogicalId}${task.LogicalId}SandboxAccess`, {
            groupId: taskGroupId,
            type: "ingress",
            ipProtocol: "tcp",
            fromPort: 0,
            toPort: 65535,
            referencedGroupId: hostGroup.groupId,
            description: `${host.LogicalId} calls its ${task.LogicalId} sandboxes`,
          });

          const clusterArn = Output.map(
            Output.all(capacity.capacityProviderArn, capacity.cluster),
            ([arn, cluster]) => ecsArn(arn, `cluster/${clusterNameOf(cluster)}`),
          );
          const taskArns = Output.map(
            Output.all(capacity.capacityProviderArn, capacity.cluster),
            ([arn, cluster]) => ecsArn(arn, `task/${clusterNameOf(cluster)}/*`),
          );
          yield* bind`AWS.ECS.CreateSandbox(${capacity}, ${task})`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: runTaskActions,
                // All revisions: a sandbox starts from the latest ACTIVE
                // revision, which may be registered after this grant.
                Resource: [
                  Output.map(
                    task.taskDefinitionArn,
                    (arn) => `${revisionlessTaskDefinitionArn(arn)}:*`,
                  ),
                ],
              },
              {
                Effect: "Allow",
                Action: tagTaskActions,
                Resource: [taskArns],
                Condition: { StringEquals: { "ecs:CreateAction": "RunTask" } },
              },
              {
                Effect: "Allow",
                Action: passRoleActions,
                Resource: [task.taskRoleArn, task.executionRoleArn],
              },
              { Effect: "Allow", Action: taskActions, Resource: [taskArns] },
              {
                Effect: "Allow",
                Action: listTasksActions,
                Resource: ["*"],
                Condition: { ArnEquals: { "ecs:cluster": clusterArn } },
              },
            ],
          });
          yield* AWSBindings.bindVpc`AWS.ECS.CreateSandbox(${capacity}, ${task})`({
            subnetIds: subnets,
            securityGroupIds: [hostGroup.groupId],
          });
        }
      }

      const Cluster = yield* Output.named(
        Output.map(capacity.cluster, clusterNameOf),
        `${key}_CLUSTER`,
      );
      const CapacityName = yield* capacity.name;
      const TaskDefinitionArn = yield* task.taskDefinitionArn;
      const ContainerName = yield* task.containerName;
      // Bound at deploy, so the running host never has to know what the
      // Task is made of: an image's agent has its own port, a program
      // serves the agent on the Task's.
      const Port = Effect.map(
        yield* Output.named(
          output<number | string>(imageOnly ? SANDBOX_AGENT_PORT : task.port),
          `${key}_PORT`,
        ),
        Number,
      );
      const Subnets = yield* Output.named(subnets, `${key}_SUBNETS`);
      const SandboxGroupId = yield* Output.named(sandboxGroupId, `${key}_GROUP`);
      const SecurityGroups = yield* Output.named(
        output<string[]>(props?.securityGroups ?? []),
        `${key}_SECURITY_GROUPS`,
      );
      const ownerTags = yield* bindOwnerTags;

      const handleOf = (target: {
        cluster: string;
        taskArn: string;
        privateIp: string;
        port: number;
        token: string;
      }): EcsSandbox => {
        const baseUrl = `http://${target.privateIp}:${target.port}`;
        const authorized = (request: HttpClientRequest.HttpClientRequest) =>
          execute(
            request.pipe(HttpClientRequest.setHeader("authorization", `Bearer ${target.token}`)),
          );
        const sandbox: EcsSandbox = {
          ...makeSandboxAgentClient(
            makeFetchRpcStub<SandboxAgentRpc>({ baseUrl, fetch: authorized }),
          ),
          taskArn: target.taskArn,
          privateIp: target.privateIp,
          kill: () =>
            Effect.asVoid(
              stopTask({ cluster: target.cluster, task: target.taskArn, reason: "Sandbox killed" }),
            ),
          getTcpPort: (port) =>
            Effect.sync(() => {
              const url = `http://${target.privateIp}:${port}`;
              return {
                port,
                hostname: target.privateIp,
                url,
                fetch: Sandbox.portFetch((request: HttpClientRequest.HttpClientRequest) => {
                  const source = new URL(request.url, url);
                  return execute(
                    request.pipe(
                      HttpClientRequest.setUrl(`${url}${source.pathname}${source.search}`),
                      HttpClientRequest.removeHeader("host"),
                    ),
                  );
                }),
              };
            }),
        };
        // Any other name is a method of the Task's program, when it has one.
        return makeFetchRpcStub<EcsSandbox>({ baseUrl, base: { ...sandbox }, fetch: authorized });
      };

      /** The running task and its address, or the reason it is not running. */
      const running = Effect.fn(function* (cluster: string, taskArn: string) {
        const response = yield* describeTasks({ cluster, tasks: [taskArn] });
        const found = response.tasks?.[0];
        const status = found?.lastStatus ?? "PROVISIONING";
        if (found === undefined || startingStatuses.has(status)) {
          return yield* new EcsSandboxStarting({ status });
        }
        if (status !== "RUNNING") {
          const reason = found.stoppedReason ?? status;
          return yield* new EcsSandboxStartFailed({
            reason,
            taskArn,
            message: `Sandbox ${taskArn} stopped before it started: ${reason}`,
          });
        }
        const privateIp = privateIpOf(found);
        if (privateIp === undefined) return yield* new EcsSandboxStarting({ status });
        return privateIp;
      });

      const client: EcsSandboxes = {
        create: Effect.fn("AWS.ECS.CreateSandbox.create")(function* (
          options?: CreateSandboxOptions,
        ) {
          const cluster = yield* Cluster;
          const containerName = yield* ContainerName;
          const port = yield* Port;
          const sandboxGroup = yield* SandboxGroupId;
          const token = yield* Effect.sync(randomToken);
          const startTimeout = Duration.fromInputUnsafe(options?.startTimeout ?? "5 minutes");

          const response = yield* runTask({
            cluster,
            // Family, not the bound ARN: starts the latest ACTIVE revision.
            taskDefinition: taskDefinitionFamilyOf(yield* TaskDefinitionArn),
            count: 1,
            startedBy: STARTED_BY,
            capacityProviderStrategy: [{ capacityProvider: yield* CapacityName, weight: 1 }],
            networkConfiguration: {
              awsvpcConfiguration: {
                subnets: yield* Subnets,
                securityGroups: [sandboxGroup, ...(yield* SecurityGroups)].filter(
                  (group) => group !== "",
                ),
              },
            },
            overrides: {
              containerOverrides: [
                {
                  name: containerName,
                  environment: [
                    ...Object.entries(options?.env ?? {}).map(([name, value]) => ({ name, value })),
                    { name: SANDBOX_TOKEN_ENV, value: token },
                    ...(options?.idleTimeout === undefined
                      ? []
                      : [
                          {
                            name: SANDBOX_IDLE_TIMEOUT_ENV,
                            value: String(
                              Duration.toMillis(Duration.fromInputUnsafe(options.idleTimeout)),
                            ),
                          },
                        ]),
                  ],
                },
              ],
            },
            tags: Object.entries({ ...options?.tags, ...(yield* ownerTags) }).flatMap(
              ([key, value]) => (value === undefined ? [] : [{ key, value }]),
            ),
          });
          const taskArn = response.tasks?.[0]?.taskArn;
          if (taskArn === undefined) {
            const reason = response.failures?.[0]?.reason ?? "ECS started no task";
            return yield* new EcsSandboxStartFailed({
              reason,
              message: `Sandbox failed to start: ${reason}`,
            });
          }

          const ready = Effect.gen(function* () {
            const privateIp = yield* running(cluster, taskArn).pipe(
              Effect.retry({
                while: (error) => error._tag === "EcsSandboxStarting",
                schedule: Schedule.spaced("2 seconds"),
              }),
              Effect.catchTag("EcsSandboxStarting", (error) =>
                Effect.fail(
                  new EcsSandboxStartFailed({
                    reason: error.status,
                    taskArn,
                    message: `Sandbox ${taskArn} did not start: ${error.status}`,
                  }),
                ),
              ),
            );
            const sandbox = handleOf({ cluster, taskArn, privateIp, port, token });
            // The task is running before the agent inside it listens.
            yield* sandbox.ping.pipe(
              Effect.timeoutOrElse({
                duration: "5 seconds",
                orElse: () =>
                  Effect.fail(new SandboxAgentError({ message: "The sandbox did not answer" })),
              }),
              Effect.retry({
                while: (error) => error._tag === "SandboxAgentError",
                schedule: Schedule.spaced("1 second"),
              }),
            );
            return sandbox;
          });

          return yield* ready.pipe(
            Effect.timeoutOrElse({
              duration: startTimeout,
              orElse: () =>
                Effect.fail(
                  new EcsSandboxStartFailed({
                    reason: "timeout",
                    taskArn,
                    message: `Sandbox ${taskArn} did not answer within ${Duration.format(startTimeout)}. The host must be in the sandbox's VPC, and a Task with a program (main) must listen on its port.`,
                  }),
                ),
            }),
            // A sandbox nothing can reach is stopped, not leaked.
            Effect.tapError(() =>
              Effect.ignore(
                stopTask({ cluster, task: taskArn, reason: "Sandbox failed to start" }),
              ),
            ),
          );
        }),

        connect: Effect.fn("AWS.ECS.CreateSandbox.connect")(function* (taskArn: string) {
          const cluster = yield* Cluster;
          const response = yield* describeTasks({ cluster, tasks: [taskArn] });
          const found = response.tasks?.[0];
          const token = found === undefined ? undefined : tokenOf(found);
          const privateIp = found === undefined ? undefined : privateIpOf(found);
          // ECS keeps reporting a stopped task as RUNNING while it shuts down;
          // `desiredStatus` turns STOPPED the moment `kill` returns.
          if (
            found?.lastStatus !== "RUNNING" ||
            found.desiredStatus !== "RUNNING" ||
            token === undefined ||
            privateIp === undefined
          ) {
            return yield* new EcsSandboxNotFound({
              taskArn,
              message: `No running sandbox has the task ARN ${taskArn}`,
            });
          }
          return handleOf({ cluster, taskArn, privateIp, port: yield* Port, token });
        }),

        list: Effect.fn("AWS.ECS.CreateSandbox.list")(function* (options?: ListSandboxesOptions) {
          const cluster = yield* Cluster;
          const arns = yield* listTaskArns(
            cluster,
            taskDefinitionFamilyOf(yield* TaskDefinitionArn),
          );
          const pages = yield* Effect.forEach(
            chunksOf(arns, DESCRIBE_BATCH),
            (tasks) => describeTasks({ cluster, tasks, include: ["TAGS"] }),
            { concurrency: 4 },
          );
          const wanted = Object.entries(options?.tags ?? {});
          return pages
            .flatMap((page) => page.tasks ?? [])
            .flatMap((found): EcsSandboxInfo[] => {
              // A task of the same family that something else started (a
              // Service) carries no token and is not a sandbox.
              if (found.taskArn === undefined || tokenOf(found) === undefined) return [];
              const tags = tagsOf(found);
              if (!wanted.every(([name, value]) => tags[name] === value)) return [];
              return [
                {
                  taskArn: found.taskArn,
                  status: found.lastStatus ?? "UNKNOWN",
                  tags,
                  createdAt: found.createdAt,
                  privateIp: privateIpOf(found),
                },
              ];
            });
        }),
      };
      return client;
    });
  }),
);
