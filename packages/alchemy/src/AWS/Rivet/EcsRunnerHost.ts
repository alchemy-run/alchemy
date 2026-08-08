/**
 * The `aws-ecs` Rivet {@link RunnerHost}: the **runner** (the user's actor
 * code, bundled with the generated rivetkit entry) runs as an ECS Fargate
 * service alongside the engine composed by `EcsClusterHost`.
 *
 * The runner is deliberately minimal:
 *
 * - **No inbound ports, no load balancer** — it opens an outbound
 *   WebSocket to the engine's guard service (`RIVET_ENDPOINT`) and serves
 *   actors through that tunnel. It reuses the engine's ECS cluster,
 *   subnets, and security group (from the cluster's `hostState`), with an
 *   egress-only public IP for image pull + CloudWatch logs.
 * - **Image** — the user's `main` is bundled (rolldown, bun/node
 *   platform) with the generated runner entry as the virtual entrypoint,
 *   layered onto the `oven/bun` base, and pushed to a managed ECR
 *   repository — the same `makeImageSource` machinery `AWS.ECS.Task` /
 *   `AWS.ECS.Service` use for their `main:` form.
 * - **Task definition** — synthesized per deploy via the shared
 *   `AWS.ECS.Task` helpers (roles, log group, revision registration,
 *   superseded-revision reaping). `stopTimeout: 120` gives rivetkit's
 *   drain (triggered when a higher `RIVET_ENVOY_VERSION` registers) its
 *   full Fargate budget.
 *
 * Registered by `AWS.providers()` under the same `aws-ecs` kind as
 * `EcsClusterHost`.
 */
import * as ecs from "@distilled.cloud/aws/ecs";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import {
  RunnerHost,
  type RunnerDeployOptions,
  type RunnerHostService,
  type RunnerSource,
} from "../../Rivet/RunnerHost.ts";
import type { BundledImageSource } from "../ECR/ImageSource.ts";
import { makeImageSource, type ImageSource } from "../ECR/ImageSource.ts";
import { waitForServiceConvergence } from "../ECS/Service.ts";
import {
  createTaskRoleIfNotExists,
  deleteTaskDefinitionInfrastructure,
  ensureTaskExecutionRole,
  ensureTaskLogGroup,
  reapSupersededTaskDefinitionRevision,
  registerTaskDefinitionRevision,
} from "../ECS/Task.ts";

/**
 * rivetkit's drain window must fit inside Fargate's 120s `stopTimeout`
 * ceiling — same budget the engine itself runs with.
 */
const RUNNER_STOP_TIMEOUT_SECONDS = 120;

/** Build for the deploy machine's architecture (matches the engine host). */
const runnerPlatform = () =>
  process.arch === "arm64" ? "linux/arm64" : "linux/amd64";

const runnerRuntimePlatform = (): ecs.RuntimePlatform => ({
  cpuArchitecture: process.arch === "arm64" ? "ARM64" : "X86_64",
  operatingSystemFamily: "LINUX",
});

/** The rivetkit release installed into the runner image. */
export const DEFAULT_RIVETKIT_VERSION = "2.3.10";

/**
 * rivetkit ships wasm/napi engine sidecars (`@rivetkit/rivetkit-wasm`,
 * `@rivetkit/rivetkit-napi`) that cannot be bundled — the runner keeps
 * `rivetkit` external and the image environment installs it with `bun add`
 * (its transitive deps included).
 */
const RIVETKIT_EXTERNAL = /^rivetkit(\/|$)|^@rivetkit\//;

const environmentDockerfile = (source: RunnerSource): string =>
  [
    `FROM ${source.image ?? "oven/bun:1"}`,
    "WORKDIR /app",
    `RUN bun add rivetkit@${source.rivetkitVersion ?? DEFAULT_RIVETKIT_VERSION} ws eventsource`,
  ].join("\n");

const toBundledSource = (source: RunnerSource): BundledImageSource => {
  const build = (source.build ?? {}) as NonNullable<
    BundledImageSource["build"]
  >;
  return {
    main: source.main,
    dockerfile: { content: environmentDockerfile(source) },
    build: {
      ...build,
      input: {
        ...build.input,
        external: [
          RIVETKIT_EXTERNAL,
          ...((build.input?.external as (string | RegExp)[] | undefined) ?? []),
        ],
      },
    },
  };
};

const deployRunner = (imageSource: ImageSource, options: RunnerDeployOptions) =>
  Effect.gen(function* () {
    const { id, names, source, env, bootstrap, connection, output, session } =
      options;

    const state = (connection.hostState ?? {}) as {
      clusterArn?: string;
      subnetIds?: string[];
      securityGroupIds?: string[];
    };
    if (
      state.clusterArn === undefined ||
      state.subnetIds === undefined ||
      state.securityGroupIds === undefined
    ) {
      return yield* Effect.die(
        new Error(
          `Rivet runner '${id}' has no usable cluster host state — the ` +
            "aws-ecs cluster host must compose clusterArn, subnetIds, and " +
            "securityGroupIds.",
        ),
      );
    }

    // Bundle `main` behind the generated runner entry, build the image,
    // and push it to the managed ECR repository (content-addressed — a
    // re-run with unchanged content skips the build).
    const resolved = yield* imageSource.resolve({
      id,
      source: toBundledSource(source),
      repositoryName: names.repositoryName,
      repositoryUri: output?.repositoryUri,
      tags: options.tags,
      platform: runnerPlatform(),
      bootstrap,
      session,
    });

    const taskRoleArn = yield* createTaskRoleIfNotExists({
      id,
      roleName: names.taskRoleName,
    });
    const executionRoleArn = yield* ensureTaskExecutionRole({
      id,
      roleName: names.executionRoleName,
    });
    yield* ensureTaskLogGroup({ id, logGroupName: names.logGroupName });

    const taskDefinition = yield* registerTaskDefinitionRevision({
      props: {
        env,
        cpu: source.cpu ?? 512,
        memory: source.memory ?? 1024,
        runtimePlatform: runnerRuntimePlatform(),
        container: {
          // Give rivetkit's actor drain its full budget before ECS
          // escalates to SIGKILL.
          stopTimeout: RUNNER_STOP_TIMEOUT_SECONDS,
        },
      },
      family: names.taskFamily,
      imageUri: resolved.imageUri,
      taskRoleArn,
      executionRoleArn,
      logGroupName: names.logGroupName,
      tags: options.tags,
    });
    const taskDefinitionArn = taskDefinition.taskDefinitionArn!;

    // Observe the service; create when missing, roll onto the new revision
    // otherwise. ECS's default deployment overlap (200%/100%) plus the
    // strictly-increasing RIVET_ENVOY_VERSION drains actors from the old
    // runner generation onto the new one.
    const desiredCount = source.desiredCount ?? 1;
    const described = yield* ecs.describeServices({
      cluster: state.clusterArn,
      services: [names.serviceName],
    });
    const existing = described.services?.find(
      (service) => service.status !== "INACTIVE",
    );

    const update = ecs.updateService({
      cluster: state.clusterArn,
      service: names.serviceName,
      taskDefinition: taskDefinitionArn,
      desiredCount,
    });

    if (existing === undefined) {
      yield* session.note(`Creating ECS runner service ${names.serviceName}`);
      yield* ecs
        .createService({
          cluster: state.clusterArn,
          serviceName: names.serviceName,
          taskDefinition: taskDefinitionArn,
          desiredCount,
          launchType: "FARGATE",
          networkConfiguration: {
            awsvpcConfiguration: {
              subnets: state.subnetIds,
              securityGroups: state.securityGroupIds,
              // Egress-only public IP (image pull, CloudWatch logs, the
              // outbound engine tunnel) — the security group admits
              // nothing from outside the VPC.
              assignPublicIp: "ENABLED",
            },
          },
          tags: Object.entries(options.tags).map(([key, value]) => ({
            key,
            value,
          })),
          enableECSManagedTags: true,
        })
        .pipe(
          // "Creation of service was not idempotent" — a crash-rerun or
          // concurrent race left the service in place; converge via update.
          Effect.catchTag("InvalidParameterException", () => update),
        );
    } else {
      yield* session.note(`Rolling ECS runner service ${names.serviceName}`);
      yield* update;
    }

    // Deploy is not done until the new runner generation is actually
    // running: the generated entry exits nonzero unless its envoy registers
    // with the engine (startAndWait), so a runner that cannot reach or
    // register with the engine crash-loops and this wait surfaces the fault
    // instead of reporting success while the gateway 400s.
    yield* session.note(
      `Waiting for ECS runner service ${names.serviceName} to stabilize`,
    );
    yield* waitForServiceConvergence({
      clusterArn: state.clusterArn,
      serviceName: names.serviceName,
      expectedTaskDefinitionArn: taskDefinitionArn,
      mode: "stable",
    });

    yield* reapSupersededTaskDefinitionRevision({
      previousArn: output?.taskDefinitionArn,
      nextArn: taskDefinitionArn,
    });

    return {
      codeHash: resolved.codeHash,
      runnerState: {
        clusterArn: state.clusterArn,
        serviceName: names.serviceName,
        taskDefinitionArn,
        taskFamily: names.taskFamily,
        repositoryName: resolved.repositoryName,
        repositoryUri: resolved.repositoryUri,
        logGroupName: names.logGroupName,
        taskRoleName: names.taskRoleName,
        executionRoleName: names.executionRoleName,
      },
    };
  });

const deleteRunner = ({ output }: { output: Record<string, any> }) =>
  Effect.gen(function* () {
    const state = output as {
      clusterArn?: string;
      serviceName?: string;
      taskDefinitionArn?: string;
      taskFamily?: string;
      repositoryName?: string;
      logGroupName?: string;
      taskRoleName?: string;
      executionRoleName?: string;
    };

    if (state.clusterArn !== undefined && state.serviceName !== undefined) {
      yield* ecs
        .updateService({
          cluster: state.clusterArn,
          service: state.serviceName,
          desiredCount: 0,
        })
        .pipe(
          Effect.retry({
            while: (error): boolean =>
              error._tag === "ServiceNotActiveException",
            schedule: Schedule.max([
              Schedule.spaced("5 seconds"),
              Schedule.recurs(8),
            ]),
          }),
          Effect.catchTag("ServiceNotFoundException", () => Effect.void),
          Effect.catchTag("ClusterNotFoundException", () => Effect.void),
          Effect.catchTag("ServiceNotActiveException", () => Effect.void),
        );
      yield* ecs
        .deleteService({
          cluster: state.clusterArn,
          service: state.serviceName,
          force: true,
        })
        .pipe(
          Effect.catchTag("ServiceNotFoundException", () => Effect.void),
          Effect.catchTag("ClusterNotFoundException", () => Effect.void),
        );
    }

    if (
      state.taskDefinitionArn !== undefined &&
      state.repositoryName !== undefined &&
      state.logGroupName !== undefined &&
      state.taskRoleName !== undefined &&
      state.executionRoleName !== undefined
    ) {
      yield* deleteTaskDefinitionInfrastructure({
        taskDefinitionArn: state.taskDefinitionArn,
        taskFamily: state.taskFamily,
        repositoryName: state.repositoryName,
        logGroupName: state.logGroupName,
        taskRoleName: state.taskRoleName,
        executionRoleName: state.executionRoleName,
      });
    }
  });

/**
 * The `aws-ecs` {@link RunnerHost} layer. Registered by `AWS.providers()`
 * alongside `EcsClusterHost`; compose a stack with
 * `Layer.mergeAll(AWS.providers(), Rivet.providers())` and both resolve
 * automatically.
 */
export const EcsRunnerHost = (): Layer.Layer<RunnerHost<"aws-ecs">> =>
  Layer.effect(
    RunnerHost("aws-ecs"),
    Effect.gen(function* () {
      // Captured at layer build (inside `AWS.providers()`'s composition,
      // which itself builds under the stack's services) so every operation
      // works from the host-agnostic Rivet engine's context, which carries
      // no AWS services.
      const context = yield* Effect.context<never>();
      const imageSource = yield* makeImageSource;

      const provide = <A, E, R>(
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E, never> =>
        Effect.provide(
          effect,
          context as Context.Context<any>,
        ) as Effect.Effect<A, E, never>;

      return {
        kind: "Rivet.RunnerHost" as const,

        deployRunner: (options) => provide(deployRunner(imageSource, options)),

        runnerCodeHash: (options) =>
          provide(
            imageSource.hash({
              source: toBundledSource(options.source),
              platform: runnerPlatform(),
              bootstrap: options.bootstrap,
            }),
          ),

        deleteRunner: (options) => provide(deleteRunner(options)),
      } satisfies RunnerHostService;
    }),
  ) as Layer.Layer<RunnerHost<"aws-ecs">>;
