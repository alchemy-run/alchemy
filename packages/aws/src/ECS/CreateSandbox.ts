import type * as ECS from "@distilled.cloud/aws/ecs";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Sandbox from "alchemy/Sandbox";
import type { SandboxAgentClient, SandboxError } from "alchemy/SandboxAgentClient";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
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
