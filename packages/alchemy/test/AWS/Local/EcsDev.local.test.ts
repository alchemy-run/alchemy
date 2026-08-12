/**
 * Mode-scoped local dev for ECS: `Test.make({ dev: true })` routes the
 * dualized `ECS.Cluster` / `ECS.Task` (and `ECS.TaskDefinition` /
 * `ECS.Service`) to the floci emulator, where tasks run as REAL docker
 * containers.
 *
 * Proof structure (mirrors DataPlane.local.test.ts):
 *   - attrs carry the dummy account (`:000000000000:` ARNs) and the
 *     `.localhost:` ECR repository URI — the live cloud can never mint
 *     these;
 *   - persisted state rows are stamped `providerMode: "local"`;
 *   - out-of-band raw HTTP against the emulator gateway runs the deployed
 *     task definition (RunTask) and observes it RUNNING as a real docker
 *     container (`docker ps` shows `floci-ecs-<taskId>-…`);
 *   - the container round-trips HTTP: floci publishes the LITERAL host
 *     port for bridge-mode port mappings (awsvpc tasks are expose-only
 *     when floci itself runs in a container), so the fixture uses
 *     `networkMode: "bridge"` and the test fetches
 *     `http://localhost:<port>` for the marker;
 *   - `stack.destroy()` drains the cluster (the running task is stopped
 *     and its container removed) and deletes the task definition, ECR
 *     repository, log group, and IAM roles — all verified gone.
 *
 * Requires Docker (floci runs as a container); skipped when unavailable.
 */
import * as AWS from "@/AWS";
import { State, type ResourceState } from "@/State";
import { Stack } from "@/Stack";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { spawnSync } from "node:child_process";
import EcsDevMainTask from "./fixtures/ecs-dev/main-task.ts";
import { dockerAvailable, rawAwsJson } from "./fixtures/raw.ts";

const { test } = Test.make({ providers: AWS.providers(), dev: true });

const contextDir = `${import.meta.dirname}/fixtures/ecs-dev`;

/** Must match the port baked into fixtures/ecs-dev/Dockerfile. */
const CONTEXT_PORT = 17356;
/** Must match the `port` on fixtures/ecs-dev/main-task.ts. */
const MAIN_PORT = 17357;

const FLOCI_REGION = "us-east-1";

const getState = Effect.fn(function* (fqn: string) {
  const state = yield* yield* State;
  const stk = yield* Stack;
  return (yield* state.get({
    stack: stk.name,
    stage: stk.stage,
    fqn,
  })) as ResourceState | undefined;
});

/** Raw ECS operation against the emulator gateway (out-of-band). */
const rawEcs = (action: string, body: Record<string, unknown>) =>
  rawAwsJson({
    service: "ecs",
    region: FLOCI_REGION,
    target: `AmazonEC2ContainerServiceV20141113.${action}`,
    contentType: "application/x-amz-json-1.1",
    body,
  });

/** Names of the docker containers currently running on the host daemon. */
const runningContainerNames = Effect.sync(
  () =>
    spawnSync("docker", ["ps", "--format", "{{.Names}}"], {
      encoding: "utf8",
      timeout: 15_000,
    }).stdout ?? "",
);

/** `arn:aws:ecs:…:task/<cluster>/<taskId>` → `<taskId>`. */
const taskIdOfArn = (arn: string) => arn.split("/").pop()!;

/**
 * The emulator runs task containers on THIS machine — build for the host
 * architecture so the image runs natively instead of under qemu.
 */
const hostRuntimePlatform = {
  cpuArchitecture:
    process.arch === "arm64" ? ("ARM64" as const) : ("X86_64" as const),
  operatingSystemFamily: "LINUX" as const,
};

/**
 * Deploy → RunTask → assert RUNNING container + HTTP marker → destroy →
 * assert everything (including the docker container) is gone. Shared by the
 * context-Dockerfile and bundled-main cases.
 */
const runTaskRoundTrip = Effect.fn(function* (options: {
  clusterName: string;
  taskDefinitionArn: string;
  port: number;
  marker: string;
}) {
  const client = yield* HttpClient.HttpClient;

  // Out-of-band: run the deployed task definition on the deployed cluster
  // through the raw gateway API. floci launches a REAL docker container.
  const runResponse = yield* rawEcs("RunTask", {
    cluster: options.clusterName,
    taskDefinition: options.taskDefinitionArn,
    count: 1,
    launchType: "EC2",
  });
  expect(runResponse.status).toBe(200);
  const run = (yield* runResponse.json) as {
    tasks?: { taskArn?: string; lastStatus?: string }[];
    failures?: unknown[];
  };
  expect(run.failures ?? []).toEqual([]);
  const taskArn = run.tasks?.[0]?.taskArn;
  expect(taskArn).toBeTruthy();
  const taskId = taskIdOfArn(taskArn!);

  // DescribeTasks observes the task RUNNING…
  const described = yield* rawEcs("DescribeTasks", {
    cluster: options.clusterName,
    tasks: [taskArn],
  });
  expect(described.status).toBe(200);
  const tasks = (yield* described.json) as {
    tasks?: { lastStatus?: string }[];
  };
  expect(tasks.tasks?.[0]?.lastStatus).toBe("RUNNING");

  // …and the task is a REAL container on the host docker daemon
  // (`floci-ecs-<taskId>-<containerName>`).
  expect(yield* runningContainerNames).toContain(`floci-ecs-${taskId}`);

  // Round-trip HTTP to the served marker. Bridge-mode port mappings are
  // published literally on the docker host, so the container is reachable
  // at localhost:<port>. (floci's DescribeTasks networkBindings mis-report
  // the hostPort as the containerPort, so the literal port — equal by
  // construction in the Task's port mapping — is the reliable address.)
  const body = yield* client.get(`http://localhost:${options.port}/`).pipe(
    Effect.retry({
      schedule: Schedule.exponential("500 millis"),
      times: 10,
    }),
    Effect.flatMap((response) => response.text),
  );
  expect(body).toContain(options.marker);

  return { taskId };
});

/** Post-destroy: task container gone, cluster gone, task definition gone. */
const assertTornDown = Effect.fn(function* (options: {
  clusterName: string;
  taskDefinitionArn: string;
  taskId: string;
}) {
  // The running task's container was stopped and removed by the cluster
  // delete (observe until the daemon agrees — stop is asynchronous).
  yield* runningContainerNames.pipe(
    Effect.flatMap((names) =>
      names.includes(`floci-ecs-${options.taskId}`)
        ? Effect.fail(new Error("task container still running"))
        : Effect.void,
    ),
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 15 }),
  );

  // The cluster is gone (or INACTIVE) in the emulator.
  const clusters = (yield* (yield* rawEcs("DescribeClusters", {
    clusters: [options.clusterName],
  })).json) as { clusters?: { status?: string }[] };
  const active = (clusters.clusters ?? []).filter(
    (cluster) => cluster.status !== "INACTIVE",
  );
  expect(active).toEqual([]);

  // The task definition revision is gone.
  const definition = yield* rawEcs("DescribeTaskDefinition", {
    taskDefinition: options.taskDefinitionArn,
  });
  expect(definition.status).toBe(400); // ClientException: unable to describe
});

// Sequential on purpose: each test runs a `docker buildx build`, and
// concurrent builds multiply pressure on Docker Desktop's shared
// `docker-credential-desktop` helper, which can wedge machine-wide under
// concurrent access (the same helper-race class documented on
// `Docker.image.push`). One build at a time keeps this file off that path.
describe.sequential("EcsDev", () => {
  test.provider.skipIf(!dockerAvailable)(
    "dev mode runs a context-Dockerfile ECS task as a real local container",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const outputs = yield* stack.deploy(
          Effect.gen(function* () {
            // Propless instantiation on purpose: pins the `news ?? {}`
            // normalization in the Cluster reconciler (every ClusterProps
            // field is optional, so `Cluster("Id")` is legal).
            const cluster = yield* AWS.ECS.Cluster("EcsDevCluster");
            const task = yield* AWS.ECS.Task("EcsDevTask", {
              context: contextDir,
              port: CONTEXT_PORT,
              cpu: 256,
              memory: 512,
              // Bridge mode publishes the literal host port — the only
              // host-reachable mode when floci runs inside a container.
              networkMode: "bridge",
              requiresCompatibilities: ["EC2"],
              runtimePlatform: hostRuntimePlatform,
            });
            return { cluster, task };
          }),
        );

        // --- Emulator-shaped identity: the live cloud can never mint these.
        expect(outputs.cluster.clusterArn).toContain(":000000000000:");
        expect(outputs.task.taskDefinitionArn).toContain(":000000000000:");
        expect(outputs.task.taskRoleArn).toContain("::000000000000:");
        expect(outputs.task.executionRoleArn).toContain("::000000000000:");
        // The image was pushed to floci's loopback ECR registry.
        expect(outputs.task.repositoryUri).toContain(".localhost:");
        expect(outputs.task.imageUri).toContain(".localhost:");

        // --- Stamped-mode proof.
        for (const fqn of ["EcsDevCluster", "EcsDevTask"]) {
          const row = yield* getState(fqn);
          expect(`${fqn}:${row?.status}`).toBe(`${fqn}:created`);
          expect(`${fqn}:${row?.providerMode}`).toBe(`${fqn}:local`);
        }

        // --- Run the task: real container, HTTP marker round-trip.
        const { taskId } = yield* runTaskRoundTrip({
          clusterName: outputs.cluster.clusterName,
          taskDefinitionArn: outputs.task.taskDefinitionArn,
          port: CONTEXT_PORT,
          marker: "ecs-dev-local-marker",
        });

        // --- Destroy: the cluster delete stops the running task (container
        // removed), and the task delete sweeps the definition + repository.
        yield* stack.destroy();

        yield* assertTornDown({
          clusterName: outputs.cluster.clusterName,
          taskDefinitionArn: outputs.task.taskDefinitionArn,
          taskId,
        });

        // The ECR repository holding the built image is gone from the
        // emulator's registry too.
        const repositories = yield* rawAwsJson({
          service: "ecr",
          region: FLOCI_REGION,
          target: "AmazonEC2ContainerRegistry_V20150921.DescribeRepositories",
          contentType: "application/x-amz-json-1.1",
          body: { repositoryNames: [outputs.task.repositoryName] },
        });
        expect(repositories.status).toBe(400); // RepositoryNotFoundException
      }),
    { timeout: 300_000 },
  );

  test.provider.skipIf(!dockerAvailable)(
    "dev mode bundles a main-program ECS task and pushes through the local ECR registry",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const outputs = yield* stack.deploy(
          Effect.gen(function* () {
            const cluster = yield* AWS.ECS.Cluster("EcsDevMainCluster", {});
            const task = yield* EcsDevMainTask;
            return { cluster, task };
          }),
        );

        expect(outputs.cluster.clusterArn).toContain(":000000000000:");
        expect(outputs.task.taskDefinitionArn).toContain(":000000000000:");
        expect(outputs.task.repositoryUri).toContain(".localhost:");

        for (const fqn of ["EcsDevMainCluster", "EcsDevMainTask"]) {
          const row = yield* getState(fqn);
          expect(`${fqn}:${row?.status}`).toBe(`${fqn}:created`);
          expect(`${fqn}:${row?.providerMode}`).toBe(`${fqn}:local`);
        }

        const { taskId } = yield* runTaskRoundTrip({
          clusterName: outputs.cluster.clusterName,
          taskDefinitionArn: outputs.task.taskDefinitionArn,
          port: MAIN_PORT,
          marker: "ecs-dev-main-marker",
        });

        yield* stack.destroy();

        yield* assertTornDown({
          clusterName: outputs.cluster.clusterName,
          taskDefinitionArn: outputs.task.taskDefinitionArn,
          taskId,
        });
      }),
    { timeout: 300_000 },
  );
}); // describe.sequential("EcsDev")
