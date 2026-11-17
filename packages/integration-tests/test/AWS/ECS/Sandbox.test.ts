import * as AWS from "@alchemy.run/aws";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as ecs from "@distilled.cloud/aws/ecs";
import * as Alchemy from "alchemy";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import SandboxHost, { SandboxCapacity, SandboxCluster } from "./fixtures/sandbox-host.ts";

const testOptions = { providers: AWS.providers(), state: Alchemy.localState() };
const { test, beforeAll, afterAll, deploy, destroy } = Test.make(testOptions);

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// The deploy creates a NAT gateway, builds and pushes the sandbox images and
// attaches a Lambda Function to the VPC; destroy waits for the Function's
// network interfaces and the instances ECS launched to go.
const HOOK_TIMEOUT = 1_800_000;
const TEST_TIMEOUT = 300_000;

const Stack = Alchemy.Stack(
  "EcsSandboxStack",
  testOptions,
  Effect.gen(function* () {
    const cluster = yield* SandboxCluster;
    const capacity = yield* SandboxCapacity;
    const host = yield* SandboxHost;
    return {
      url: host.functionUrl.as<string>(),
      cluster: cluster.clusterName,
      capacity: capacity.name,
    };
  }),
);

class HostFailed extends Data.TaggedError("HostFailed")<{
  readonly status: number;
  readonly body: string;
}> {}

/** Calls one route of the host and decodes its JSON. */
const call = <A>(baseUrl: string, path: string, timeout: Duration.Input = "60 seconds") =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(`${baseUrl}${path}`).pipe(Effect.timeout(timeout));
    if (response.status !== 200) {
      return yield* new HostFailed({ status: response.status, body: yield* response.text });
    }
    return (yield* response.json) as A;
  });

interface Created {
  readonly taskArn: string;
  readonly privateIp: string;
}

/**
 * Starts a sandbox. The first one on empty capacity waits for ECS to launch
 * an instance, which can outlast one request: a failed start stops its task
 * and leaves the instance, so the next attempt starts on it.
 */
const create = (baseUrl: string, user: string, idleSeconds?: number, kind = "program") =>
  call<Created>(
    baseUrl,
    `/create?user=${user}&kind=${kind}${idleSeconds === undefined ? "" : `&idle=${idleSeconds}`}`,
    // Under the 300 seconds at which Bun gives up on a response.
    "295 seconds",
  ).pipe(Effect.retry({ times: 2 }));

const taskArnParam = (taskArn: string) => `taskArn=${encodeURIComponent(taskArn)}`;

/** Reads a sandbox's task from ECS, with the providers' credentials. */
const describeTask = (cluster: string, taskArn: string) =>
  Core.withProviders(
    ecs
      .describeTasks({ cluster, tasks: [taskArn], include: ["TAGS"] })
      .pipe(Effect.map((response) => response.tasks?.[0])),
    testOptions,
    "EcsSandboxStack",
  );

interface Ran {
  readonly taskArn: string | undefined;
  readonly failures: readonly { readonly reason?: string; readonly detail?: string }[];
}

/**
 * Starts a task with `AWS.ECS.RunTask`, not as a sandbox, and waits for it
 * to stop. ECS keeps a stopped task readable for an hour.
 */
const runToCompletion = (baseUrl: string, cluster: string, kind: "plain" | "image") =>
  Effect.gen(function* () {
    const ran = yield* call<Ran>(baseUrl, `/run?kind=${kind}`);
    expect(ran.failures).toEqual([]);
    const taskArn = ran.taskArn ?? "";
    const stopped = yield* describeTask(cluster, taskArn).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (task) => task?.lastStatus === "STOPPED",
        times: 48,
      }),
    );
    expect(stopped?.lastStatus).toBe("STOPPED");
    return stopped;
  });

/** Where the sandbox agent is mounted in an image's container. */
const AGENT_DIR = "/opt/alchemy/sandbox";
const AGENT_CONTAINER = "alchemy-sandbox-agent";

/**
 * Reads the task definition a sandbox runs: the container of the Task's
 * image, the container that brings the agent, and how many there are.
 */
const describeContainers = (taskDefinition: string | undefined) =>
  Core.withProviders(
    ecs.describeTaskDefinition({ taskDefinition: taskDefinition ?? "" }).pipe(
      Effect.map((response) => {
        const containers = response.taskDefinition?.containerDefinitions ?? [];
        return {
          count: containers.length,
          container: containers.find((container) => container.name !== AGENT_CONTAINER),
          agent: containers.find((container) => container.name === AGENT_CONTAINER),
        };
      }),
    ),
    testOptions,
    "EcsSandboxStack",
  );

describe.sequential.skipIf(!!process.env.FAST)(
  "AWS.ECS.CreateSandbox",
  {
    tags: [
      "provider:aws",
      "provider:aws:ecs",
      "provider:aws:ec2",
      "provider:aws:iam",
      "provider:aws:lambda",
      "live",
    ],
  },
  () => {
    const stack = beforeAll(deploy(Stack).pipe(logLevel), { timeout: HOOK_TIMEOUT });

    // One sandbox the cases below share.
    const shared = beforeAll(
      Effect.gen(function* () {
        const { url } = yield* stack;
        const baseUrl = url.replace(/\/+$/, "");
        // A fresh function URL takes a few seconds to serve.
        yield* call<unknown>(baseUrl, "/list?user=nobody").pipe(
          Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 10 }),
        );
        const sandbox = yield* create(baseUrl, "shared");
        return { baseUrl, ...sandbox };
      }).pipe(logLevel),
      { timeout: 900_000 },
    );

    // One sandbox of the plain image, on the instance the first one started.
    const sharedImage = beforeAll(
      Effect.gen(function* () {
        const { baseUrl } = yield* shared;
        const sandbox = yield* create(baseUrl, "image", undefined, "image");
        return { baseUrl, ...sandbox };
      }).pipe(logLevel),
      { timeout: 900_000 },
    );

    // The shared sandboxes are still running here. Sandboxes are not resources
    // in the stack, so the destroy passes only if deleting the capacity
    // provider stops them.
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack).pipe(logLevel), {
      timeout: HOOK_TIMEOUT,
    });

    test(
      "a sandbox is a task in its own Nitro Sandbox, tagged with its host",
      Effect.gen(function* () {
        const { cluster, capacity } = yield* stack;
        const { taskArn, privateIp } = yield* shared;

        const task = yield* describeTask(cluster, taskArn);
        expect(task?.lastStatus).toBe("RUNNING");
        expect(task?.trustedExecutionSummary?.isolationMode).toBe("ISOLATED_SANDBOX");
        expect(task?.capacityProviderName).toBe(capacity);
        expect(privateIp).toMatch(/^10\.67\./);

        const tags = Object.fromEntries((task?.tags ?? []).map((tag) => [tag.key, tag.value]));
        expect(tags).toMatchObject({
          user: "shared",
          "alchemy::stack": "EcsSandboxStack",
          "alchemy::stage": Core.resolveStage({}),
          "alchemy::id": "EcsSandboxHost",
        });
      }).pipe(logLevel),
      { timeout: TEST_TIMEOUT },
    );

    test(
      "exec runs commands and files round-trip",
      Effect.gen(function* () {
        const { baseUrl, taskArn } = yield* shared;
        const result = yield* call<{
          run: { exitCode: number; stdout: string; stderr: string };
          failed: { exitCode: number; stdout: string; stderr: string };
          env: string;
          readBack: string;
          entries: { path: string; type: string; size?: number }[];
        }>(baseUrl, `/exec?${taskArnParam(taskArn)}`);

        expect(result.run).toEqual({ exitCode: 0, stdout: "hi sam\n", stderr: "" });
        // A non-zero exit is a result, not a failure.
        expect(result.failed).toEqual({ exitCode: 3, stdout: "", stderr: "oops\n" });
        // `create`'s env and the call's env both reach the command.
        expect(result.env).toBe("from the host/per call\n");
        expect(result.readBack).toBe(`console.log("hi " + Bun.argv[2])`);
        expect(result.entries).toEqual([
          { path: "/work/hello.ts", type: "file", size: result.readBack.length },
        ]);
      }).pipe(logLevel),
      { timeout: TEST_TIMEOUT },
    );

    test(
      "the handle has the Task's methods",
      Effect.gen(function* () {
        const { baseUrl, taskArn } = yield* shared;
        const result = yield* call<{ greeting: string }>(
          baseUrl,
          `/hello?${taskArnParam(taskArn)}&name=sam`,
        );
        expect(result.greeting).toBe("hello sam");
      }).pipe(logLevel),
      { timeout: TEST_TIMEOUT },
    );

    test(
      "start streams a process's output until it exits",
      Effect.gen(function* () {
        const { baseUrl, taskArn } = yield* shared;
        const result = yield* call<{ exitCode: number; stdout: string }>(
          baseUrl,
          `/process?${taskArnParam(taskArn)}`,
        );
        expect(result).toEqual({ exitCode: 0, stdout: "one\ntwo\n" });
      }).pipe(logLevel),
      { timeout: TEST_TIMEOUT },
    );

    test(
      "pty opens a terminal that takes input and a resize",
      Effect.gen(function* () {
        const { baseUrl, taskArn } = yield* shared;
        const result = yield* call<{ output: string }>(baseUrl, `/pty?${taskArnParam(taskArn)}`);
        expect(result.output).toContain("pty-42");
        // `stty size` prints rows then columns, after the resize.
        expect(result.output).toContain("30 100");
      }).pipe(logLevel),
      { timeout: TEST_TIMEOUT },
    );

    test(
      "getTcpPort reaches the Task's port and a port opened later",
      Effect.gen(function* () {
        const { baseUrl, taskArn, privateIp } = yield* shared;
        const result = yield* call<{
          url: string;
          health: number;
          echo: string;
          started: string;
        }>(baseUrl, `/port?${taskArnParam(taskArn)}`);
        expect(result.url).toBe(`http://${privateIp}:3000`);
        expect(result.health).toBe(200);
        expect(result.echo).toBe("sandbox agent /some/path");
        expect(result.started).toBe("from 8080 /started");
      }).pipe(logLevel),
      { timeout: TEST_TIMEOUT },
    );

    test(
      "a call without the sandbox's token is refused",
      Effect.gen(function* () {
        const { baseUrl, taskArn } = yield* shared;
        const result = yield* call<{ exec: number; method: number }>(
          baseUrl,
          `/unauthorized?${taskArnParam(taskArn)}`,
        );
        expect(result).toEqual({ exec: 401, method: 401 });
      }).pipe(logLevel),
      { timeout: TEST_TIMEOUT },
    );

    test(
      "list finds sandboxes by tag",
      Effect.gen(function* () {
        const { baseUrl, taskArn, privateIp } = yield* shared;
        const found = yield* call<
          { taskArn: string; status: string; privateIp?: string; tags: Record<string, string> }[]
        >(baseUrl, "/list?user=shared");
        expect(found.map((sandbox) => sandbox.taskArn)).toEqual([taskArn]);
        expect(found[0]).toMatchObject({ status: "RUNNING", privateIp, tags: { user: "shared" } });

        expect(yield* call<unknown[]>(baseUrl, "/list?user=nobody")).toEqual([]);
      }).pipe(logLevel),
      { timeout: TEST_TIMEOUT },
    );

    test(
      "a plain image is a sandbox, with no program, server or Bun inside",
      Effect.gen(function* () {
        const { cluster } = yield* stack;
        const { baseUrl, taskArn, privateIp } = yield* sharedImage;

        const task = yield* describeTask(cluster, taskArn);
        expect(task?.lastStatus).toBe("RUNNING");
        expect(task?.trustedExecutionSummary?.isolationMode).toBe("ISOLATED_SANDBOX");
        expect(task?.taskDefinitionArn).not.toBe(
          (yield* describeTask(cluster, (yield* shared).taskArn))?.taskDefinitionArn,
        );

        // The container runs the image as it was pushed. The agent is an image
        // of its own, which a container copies into a volume before the
        // image's container starts.
        const { count, container, agent } = yield* describeContainers(task?.taskDefinitionArn);
        expect(count).toBe(2);
        expect(container?.image).not.toContain(":agent-");
        expect(agent?.image).toContain(":agent-");
        expect(agent?.image?.split(":")[0]).toBe(container?.image?.split(":")[0]);
        expect(agent?.essential).toBe(false);
        expect(container?.dependsOn).toEqual([
          { containerName: AGENT_CONTAINER, condition: "SUCCESS" },
        ]);
        expect(container?.mountPoints).toEqual([
          { sourceVolume: AGENT_CONTAINER, containerPath: AGENT_DIR, readOnly: true },
        ]);
        // The agent starts what the image would have run: its `CMD`, read
        // from the pushed image.
        expect(container?.entryPoint?.[0]).toBe(`${AGENT_DIR}/ld-musl.so.1`);
        expect(container?.command).toEqual(["python3"]);

        const result = yield* call<{
          bun: number;
          mount: { exitCode: number; stderr: string };
          python: string;
          served: string;
        }>(baseUrl, `/image?${taskArnParam(taskArn)}`);
        // The agent brings its own runtime, off the image's PATH, on a mount
        // the image cannot write to.
        expect(result.bun).not.toBe(0);
        expect(result.mount.exitCode).not.toBe(0);
        expect(result.mount.stderr).toContain("Read-only file system");
        expect(result.python).toBe("42\n");
        // A server the host started inside the sandbox, on a port of its own.
        expect(result.served).toBe("from 8080");

        // Each Task lists its own sandboxes.
        const found = yield* call<{ taskArn: string; privateIp?: string }[]>(
          baseUrl,
          "/list?user=image&kind=image",
        );
        expect(found).toMatchObject([{ taskArn, privateIp }]);
        expect(yield* call<unknown[]>(baseUrl, "/list?user=image")).toEqual([]);
      }).pipe(logLevel),
      { timeout: TEST_TIMEOUT },
    );

    test(
      "an image's sandbox runs commands, files, processes and terminals",
      Effect.gen(function* () {
        const { baseUrl, taskArn } = yield* sharedImage;
        const target = `${taskArnParam(taskArn)}&kind=image`;

        const exec = yield* call<{
          run: { exitCode: number; stdout: string; stderr: string };
          failed: { exitCode: number; stdout: string; stderr: string };
          env: string;
          readBack: string;
          entries: { path: string; type: string; size?: number }[];
        }>(baseUrl, `/exec?${target}`);
        expect(exec.run).toEqual({ exitCode: 0, stdout: "hi sam\n", stderr: "" });
        expect(exec.failed).toEqual({ exitCode: 3, stdout: "", stderr: "oops\n" });
        expect(exec.env).toBe("from the host/per call\n");
        expect(exec.readBack).toBe(`import sys; print("hi " + sys.argv[1])`);
        expect(exec.entries).toEqual([
          { path: "/work/hello.py", type: "file", size: exec.readBack.length },
        ]);

        expect(
          yield* call<{ exitCode: number; stdout: string }>(baseUrl, `/process?${target}`),
        ).toEqual({ exitCode: 0, stdout: "one\ntwo\n" });

        const pty = yield* call<{ output: string }>(baseUrl, `/pty?${target}`);
        expect(pty.output).toContain("pty-42");
        expect(pty.output).toContain("30 100");
      }).pipe(logLevel),
      { timeout: TEST_TIMEOUT },
    );

    test(
      "an image's sandbox refuses a call without its token",
      Effect.gen(function* () {
        const { baseUrl, taskArn } = yield* sharedImage;
        const result = yield* call<{ exec: number; method: number }>(
          baseUrl,
          `/unauthorized?${taskArnParam(taskArn)}&kind=image`,
        );
        expect(result).toEqual({ exec: 401, method: 401 });
      }).pipe(logLevel),
      { timeout: TEST_TIMEOUT },
    );

    test(
      "kill stops the task",
      Effect.gen(function* () {
        const { cluster } = yield* stack;
        const { baseUrl } = yield* shared;
        const sandbox = yield* create(baseUrl, "killed");
        expect(
          yield* call<{ found: boolean }>(baseUrl, `/connect?${taskArnParam(sandbox.taskArn)}`),
        ).toMatchObject({ found: true });

        yield* call(baseUrl, `/kill?${taskArnParam(sandbox.taskArn)}`);

        const task = yield* describeTask(cluster, sandbox.taskArn);
        expect(task?.desiredStatus).toBe("STOPPED");
        expect(task?.stoppedReason).toBe("Sandbox killed");
        // `connect` stops handing the sandbox out at once, while ECS still
        // reports the task as running.
        expect(
          yield* call<{ found: boolean }>(baseUrl, `/connect?${taskArnParam(sandbox.taskArn)}`),
        ).toEqual({ found: false });
        expect(
          (yield* call<{ taskArn: string }[]>(baseUrl, "/list?user=killed")).map(
            (found) => found.taskArn,
          ),
        ).toEqual([]);

        const stopped = yield* describeTask(cluster, sandbox.taskArn).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (task) => task?.lastStatus === "STOPPED",
            times: 36,
          }),
        );
        expect(stopped?.lastStatus).toBe("STOPPED");
      }).pipe(logLevel),
      { timeout: 900_000 },
    );

    test(
      "an idle sandbox stops itself",
      Effect.gen(function* () {
        const { cluster } = yield* stack;
        const { baseUrl } = yield* shared;
        const sandbox = yield* create(baseUrl, "idle", 20);

        const task = yield* describeTask(cluster, sandbox.taskArn).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("10 seconds"),
            until: (task) => task?.lastStatus !== "RUNNING",
            times: 18,
          }),
        );
        expect(task?.lastStatus).not.toBe("RUNNING");
        expect(task?.containers?.[0]?.exitCode ?? 0).toBe(0);
      }).pipe(logLevel),
      { timeout: 900_000 },
    );

    test(
      "an image's sandbox runs the image's own process, as the image's user",
      Effect.gen(function* () {
        const { cluster } = yield* stack;
        const { baseUrl } = yield* shared;
        const sandbox = yield* create(baseUrl, "dockerfile", undefined, "dockerfile");
        const target = `${taskArnParam(sandbox.taskArn)}&kind=dockerfile`;

        yield* Effect.gen(function* () {
          // The image's `ENTRYPOINT`, then the Task's `command` in place of
          // its `CMD`, which listens on another port.
          const task = yield* describeTask(cluster, sandbox.taskArn);
          const { container } = yield* describeContainers(task?.taskDefinitionArn);
          expect(container?.command).toEqual([
            "python3",
            "-m",
            "http.server",
            "8080",
            "--directory",
            "/srv",
          ]);

          // Nothing started the server but the sandbox itself.
          const result = yield* call<{ served: string; user: string }>(
            baseUrl,
            `/served?${target}`,
          );
          expect(result.served).toBe("from the image");
          expect(result.user).toBe("nobody\n");
        }).pipe(Effect.ensuring(Effect.ignore(call(baseUrl, `/kill?${target}`))));
      }).pipe(logLevel),
      { timeout: 900_000 },
    );

    test(
      "an isolated Task no sandbox binding targets runs with nothing of Alchemy's",
      Effect.gen(function* () {
        const { cluster, capacity } = yield* stack;
        const { baseUrl } = yield* shared;

        const task = yield* runToCompletion(baseUrl, cluster, "plain");
        expect(task?.trustedExecutionSummary?.isolationMode).toBe("ISOLATED_SANDBOX");
        expect(task?.capacityProviderName).toBe(capacity);
        // The task ran the Task's command to its end.
        expect(task?.containers?.map((container) => container.exitCode)).toEqual([0]);
        // `RunTask` tags nothing and passes no token.
        expect(task?.tags ?? []).toEqual([]);
        expect(task?.overrides?.containerOverrides?.flatMap((o) => o.environment ?? [])).toEqual(
          [],
        );

        // One container, with the image's own entry point and no mounts.
        const { count, container, agent } = yield* describeContainers(task?.taskDefinitionArn);
        expect(count).toBe(1);
        expect(agent).toBeUndefined();
        expect(container?.entryPoint ?? []).toEqual([]);
        expect(container?.mountPoints ?? []).toEqual([]);
      }).pipe(logLevel),
      { timeout: 900_000 },
    );

    test(
      "a run of a sandbox's Task without a token runs its command and exits with its code",
      Effect.gen(function* () {
        const { cluster } = yield* stack;
        const { baseUrl } = yield* shared;

        const task = yield* runToCompletion(baseUrl, cluster, "image");
        const containers = task?.containers ?? [];
        // The agent's container copies the agent and exits; the image's
        // container runs the command instead of serving a sandbox.
        expect(containers.find((container) => container.name === AGENT_CONTAINER)?.exitCode).toBe(
          0,
        );
        expect(containers.find((container) => container.name !== AGENT_CONTAINER)?.exitCode).toBe(
          7,
        );
      }).pipe(logLevel),
      { timeout: 900_000 },
    );
  },
);
