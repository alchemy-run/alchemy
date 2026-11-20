import * as ECS from "@distilled.cloud/aws/ecs";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import { makeFetchRpcStub } from "alchemy/Rpc";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Sandbox from "alchemy/Sandbox";
import {
  type SandboxAgentClient,
  type SandboxError,
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
import type { Task } from "./Task.ts";

/** Where the sandboxes of a {@link CreateSandbox} binding run, when not where the capacity runs. */
export interface CreateSandboxProps {
  /**
   * Subnets the sandboxes start in.
   * @default the capacity provider's subnets
   */
  subnets?: string[];
  /**
   * Security groups each sandbox gets, next to the capacity provider's task
   * security group.
   * @default none
   */
  securityGroups?: string[];
}

/** Options for one sandbox. */
export interface CreateSandboxOptions {
  /** Tags on the sandbox's task. `list` finds sandboxes by them. */
  readonly tags?: Readonly<Record<string, string>>;
  /**
   * Stop the sandbox when it has received no call for this long. Calls
   * through the handle count; traffic to a port from `getTcpPort` does not.
   * @default the sandbox runs until it is killed
   */
  readonly idleTimeout?: Duration.Input;
  /** Extra environment variables for the sandbox. Commands run in it inherit them. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * How long to wait for the sandbox to answer. The first sandbox on empty
   * capacity waits for ECS to launch an instance.
   * @default 5 minutes
   */
  readonly startTimeout?: Duration.Input;
}

/** Options for {@link EcsSandboxes.list}. */
export interface ListSandboxesOptions {
  /** Only sandboxes carrying every one of these tags. */
  readonly tags?: Readonly<Record<string, string>>;
}

/** A running sandbox, as `list` reports it. */
export interface EcsSandboxInfo {
  /** The ARN of the sandbox's task. Pass it to `connect`. */
  readonly taskArn: string;
  /** The task's status. */
  readonly status: string;
  /** The task's tags, including the `alchemy::*` tags of the host that created it. */
  readonly tags: Readonly<Record<string, string>>;
  readonly createdAt?: Date;
  /** The task's private address in the VPC. */
  readonly privateIp?: string;
}

/** A port of a sandbox, reached at the task's private address. */
export interface EcsSandboxPort extends Sandbox.SandboxPort<SandboxError> {
  readonly port: number;
  /** The task's private address. */
  readonly hostname: string;
  /** `http://<private address>:<port>`, reachable inside the VPC. */
  readonly url: string;
}

/**
 * A sandbox: one ECS task. Run commands, stream processes, use files and
 * open terminals inside it, and call its ports.
 */
export interface EcsSandbox
  extends SandboxAgentClient, Sandbox.SandboxPorts<SandboxError, EcsSandboxPort> {
  /** The ARN of the sandbox's task. */
  readonly taskArn: string;
  /** The task's private address in the VPC. */
  readonly privateIp: string;
  /** Stops the task. Everything in the sandbox is lost. */
  kill(): Effect.Effect<void, ECS.StopTaskError, RuntimeContext>;
}

/** The sandbox failed to start, or did not answer in time. Its task is stopped. */
export class EcsSandboxStartFailed extends Data.TaggedError("EcsSandboxStartFailed")<{
  /** Why, as ECS reports it. */
  readonly reason: string;
  readonly taskArn?: string;
  readonly message: string;
}> {}

/** No running sandbox has this task ARN. */
export class EcsSandboxNotFound extends Data.TaggedError("EcsSandboxNotFound")<{
  readonly taskArn: string;
  readonly message: string;
}> {}

/**
 * What a Task class adds to its sandboxes' handles: the methods its program
 * returns. `fetch` and `run` are the program's own entry points.
 */
export type SandboxMethods<Shape> = Omit<Shape, "fetch" | "run" | "~alchemy/Id" | "~alchemy/Tag">;

/** Creates, finds and reconnects to the sandboxes of one Task. */
export interface EcsSandboxes<Methods = {}> {
  /** Starts a task and waits until the sandbox answers. */
  create(
    options?: CreateSandboxOptions,
  ): Effect.Effect<
    EcsSandbox & Methods,
    ECS.RunTaskError | ECS.DescribeTasksError | EcsSandboxStartFailed | SandboxError,
    RuntimeContext
  >;
  /** The handle of a running sandbox, by its task ARN. */
  connect(
    taskArn: string,
  ): Effect.Effect<
    EcsSandbox & Methods,
    ECS.DescribeTasksError | EcsSandboxNotFound,
    RuntimeContext
  >;
  /** The running sandboxes of this Task. */
  list(
    options?: ListSandboxesOptions,
  ): Effect.Effect<
    ReadonlyArray<EcsSandboxInfo>,
    ECS.ListTasksError | ECS.DescribeTasksError,
    RuntimeContext
  >;
}

/**
 * Create and manage sandboxes from a Lambda Function, an ECS Service or any
 * other host in the VPC. Each sandbox is one run of an `AWS.ECS.Task` on a
 * capacity provider. Set `isolation: "isolated"` on the Task and every
 * sandbox runs in its own Nitro Sandbox, a VM the Nitro hypervisor isolates
 * from the instance and from every other task.
 *
 * ECS itself starts, stops and describes a task. This binding is Alchemy's
 * construct on top: it adds what answers a handle inside the task. To run an
 * isolated Task with ECS alone, bind `AWS.ECS.RunTask` or run it as an
 * `AWS.ECS.Service` instead. A Task this binding does not target has nothing
 * of Alchemy's in it.
 *
 * The handle runs commands, streams processes, reads and writes files, opens
 * terminals and calls ports inside the sandbox. The Task is either an image
 * with nothing of Alchemy's in it, or an Effect program, whose methods the
 * handle also has, typed from the Task class.
 *
 * The host reaches a sandbox at its private address. Sandboxes join the
 * capacity provider's task security group, which admits nothing by default.
 * The binding creates a security group for the host and a rule that admits it
 * into the sandboxes' group, and attaches a Lambda Function to the capacity's
 * subnets. A sandbox cannot reach the host or another sandbox through these
 * groups. Each sandbox also gets a random token that every call carries.
 * `connect` reads the token back from the task, so a host that may describe
 * the cluster's tasks may call their sandboxes.
 *
 * Sandboxes created at run time are tagged with the stack, stage and host
 * (`alchemy::stack`, `alchemy::stage`, `alchemy::id`). They are not
 * resources in the stack: deleting the capacity provider stops them.
 *
 * ### Creating sandboxes
 * **Example:** One sandbox per request, killed when the request ends
 * ```typescript
 * const capacity = yield* Capacity;
 * const sandboxes = yield* AWS.ECS.CreateSandbox(capacity, MySandbox);
 *
 * const sandbox = yield* Effect.acquireRelease(sandboxes.create(), (sandbox) =>
 *   Effect.ignore(sandbox.kill()),
 * );
 * ```
 *
 * **Example:** A long-lived sandbox per user, found by tags
 * ```typescript
 * const [existing] = yield* sandboxes.list({ tags: { user } });
 * const sandbox = existing
 *   ? yield* sandboxes.connect(existing.taskArn)
 *   : yield* sandboxes.create({ tags: { user }, idleTimeout: "15 minutes" });
 * ```
 *
 * ### Sandboxes from an image
 * A Task with an `image` or a `context` and no `main` is a sandbox of that
 * image as it is: no Effect program, no server and no Alchemy code of yours
 * inside. The image is pushed to your account unchanged. A small agent that
 * serves the handle is an image of its own: when a sandbox starts, ECS mounts
 * it read-only at `/opt/alchemy/sandbox`, with its own runtime, so the handle
 * works on any Linux image, with or without Bun or Node.js installed.
 *
 * The agent starts the image's own `ENTRYPOINT` and `CMD` and keeps serving
 * the handle whether that process runs or exits. The Task's `command`
 * replaces the `CMD`, as it does on any ECS task. Commands given as a string,
 * and terminals, need `/bin/sh` in the image.
 *
 * The binding adds three things to the Task's task definition: a volume, a
 * container named `alchemy-sandbox-agent` that copies the agent into the
 * volume and exits, and the agent as the entry point of your container. Every
 * run of the Task has them, also one started by a Service or by
 * `AWS.ECS.RunTask`. Such a run has no token, so the agent does not listen: it
 * runs the image's `ENTRYPOINT` and `CMD` and exits with their exit code. A
 * `command` override on that run replaces the `ENTRYPOINT` along with the
 * `CMD`. To run one image both ways, declare a second Task that no
 * `CreateSandbox` targets.
 *
 * **Example:** A sandbox from a public image
 * ```typescript
 * const MyImage = AWS.ECS.Task("MyImage", {
 *   image: "python:3.12-slim",
 *   cpu: 1024,
 *   memory: 2048,
 *   isolation: "isolated",
 * });
 *
 * const sandboxes = yield* AWS.ECS.CreateSandbox(Capacity, MyImage);
 *
 * const sandbox = yield* sandboxes.create();
 * yield* sandbox.files.write("/work/main.py", `print("hi")`);
 * const run = yield* sandbox.exec("python3 main.py", { cwd: "/work" });
 * ```
 *
 * **Example:** A sandbox from your own Dockerfile
 * ```typescript
 * const MyImage = AWS.ECS.Task("MyImage", {
 *   context: "./sandbox",
 *   cpu: 1024,
 *   memory: 2048,
 *   isolation: "isolated",
 * });
 * ```
 *
 * **Example:** A command in place of the image's `CMD`
 * ```typescript
 * const MyImage = AWS.ECS.Task("MyImage", {
 *   image: "python:3.12-slim",
 *   command: ["python3", "-m", "http.server", "8080"],
 *   cpu: 1024,
 *   memory: 2048,
 *   isolation: "isolated",
 * });
 *
 * const sandbox = yield* sandboxes.create();
 * const port = yield* sandbox.getTcpPort(8080);
 * const response = yield* port.fetch(HttpClientRequest.get("/"));
 * ```
 *
 * ### Running commands
 * `exec` runs to completion and returns `{ exitCode, stdout, stderr }`; a
 * non-zero exit is returned, not failed. A string runs in a shell, an array
 * runs directly.
 *
 * **Example:** Write a file and run it
 * ```typescript
 * yield* sandbox.files.write("/work/hello.ts", `console.log("hi")`);
 * const run = yield* sandbox.exec("bun hello.ts", { cwd: "/work" });
 * ```
 *
 * **Example:** Stream a long-running process
 * ```typescript
 * const server = yield* sandbox.start(["bun", "run", "dev"], { cwd: "/work" });
 * yield* server.output.pipe(
 *   Stream.runForEach((chunk) => Effect.log(new TextDecoder().decode(chunk.data))),
 * );
 * ```
 *
 * ### Calling the Task's methods
 * A Task with an Effect program (`main`) serves the handle itself, and the
 * handle gets the methods the program returns.
 *
 * **Example:** Typed methods from the Task class
 * ```typescript
 * // MySandbox extends AWS.ECS.Task<MySandbox, { hello: (name: string) => Effect.Effect<string> }>
 * const greeting = yield* sandbox.hello("sam");
 * ```
 *
 * ### Calling a port
 * **Example:** Proxy a request to a server inside the sandbox
 * ```typescript
 * const request = yield* HttpServerRequest;
 * const port = yield* sandbox.getTcpPort(8080);
 * return yield* port.fetch(request);
 * ```
 *
 * @binding
 * @product Sandbox
 */
// oxlint-disable-next-line effecttsgo/missing-effect-error -- the base signature takes `Input<T>`, which includes `Config<T>`; the overload below takes a declaration or an Effect that cannot fail
export interface CreateSandbox extends Binding.Service<
  CreateSandbox,
  "AWS.ECS.CreateSandbox",
  (
    capacity: CapacityProvider,
    task: Task,
    props?: CreateSandboxProps,
  ) => Effect.Effect<EcsSandboxes>
> {
  <Shape, Req = never, TaskReq = never>(
    capacity: CapacityProvider | Effect.Effect<CapacityProvider, never, Req>,
    task: (abstract new (_: never) => Shape) & Effect.Effect<Task, never, TaskReq>,
    props?: CreateSandboxProps,
  ): Effect.Effect<EcsSandboxes<SandboxMethods<Shape>>, never, CreateSandbox | Req | TaskReq>;
}
export const CreateSandbox = Binding.Service<CreateSandbox>("AWS.ECS.CreateSandbox");

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
