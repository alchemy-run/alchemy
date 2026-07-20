import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as ecr from "@distilled.cloud/aws/ecr";
import * as ecs from "@distilled.cloud/aws/ecs";
import * as iam from "@distilled.cloud/aws/iam";
import { Region } from "@distilled.cloud/aws/Region";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type * as rolldown from "rolldown";
import { AlchemyContext } from "../../AlchemyContext.ts";
import * as Bundle from "../../Bundle/Bundle.ts";
import {
  findCwdForBundle,
  getStableContextDir,
  resolveMainPath,
} from "../../Bundle/TempRoot.ts";
import { isResolved } from "../../Diff.ts";
import { Docker } from "../../Docker/Docker.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import { Platform, type Main, type PlatformProps } from "../../Platform.ts";
import * as Provider from "../../Provider.ts";
import { Resource, type ResourceBinding } from "../../Resource.ts";
import {
  createHostRuntimeContext,
  type HostRuntimeContext,
  type ServerHost,
} from "../../Server/Process.ts";
import { Stack } from "../../Stack.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasTags,
} from "../../Tags.ts";
import type { Credentials } from "../Credentials.ts";
import { buildAndPushEcrImage } from "../ECR/Image.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import type { Providers } from "../Providers.ts";

export const isTask = (value: any): value is Task => {
  return (
    typeof value === "object" &&
    value !== null &&
    "Type" in value &&
    value.Type === "AWS.ECS.Task"
  );
};

export class TaskEnvironment extends Context.Service<
  TaskEnvironment,
  Record<string, any>
>()("AWS.ECS.TaskEnvironment") {}

export interface TaskProps extends PlatformProps {
  /**
   * Module entrypoint for the bundled task program. This should typically be
   * `import.meta.url` from an inline Effect program.
   */
  main: string;
  /**
   * Named export to load from `main`.
   * @default "default"
   */
  handler?: string;
  /**
   * ECS task family. If omitted, a unique family is generated.
   */
  taskName?: string;
  /**
   * Task-level cpu configuration for Fargate.
   * @default 256
   */
  cpu?: number;
  /**
   * Task-level memory configuration for Fargate.
   * @default 512
   */
  memory?: number;
  /**
   * HTTP port exposed by the container.
   * @default 3000
   */
  port?: number;
  /**
   * Additional environment variables for the container.
   */
  env?: Record<string, any>;
  /**
   * Bundler configuration for the task entrypoint.
   */
  build?: {
    input?: Partial<rolldown.InputOptions>;
    output?: Partial<rolldown.OutputOptions>;
  };
  /**
   * Docker image build: optional full {@link docker.dockerfile}. When omitted,
   * Alchemy generates a Dockerfile for the bundled `index.mjs`.
   */
  docker?: {
    /**
     * Base image when Alchemy generates the Dockerfile.
     * @default public.ecr.aws/docker/library/bun:1
     */
    base?: string;
    /** Full Dockerfile content (replaces generated Dockerfile). */
    dockerfile?: string;
  };
  /**
   * Container definition overrides applied after Alchemy's defaults for the
   * primary (bundled) container.
   */
  container?: Partial<ecs.ContainerDefinition>;
  /**
   * Additional sidecar containers appended to the task definition after the
   * primary bundled container. Each entry is a full, typed
   * {@link ecs.ContainerDefinition} (image URIs supplied by the user, e.g.
   * from an `ECR.Image` or an external registry).
   *
   * Use this to declare multi-container tasks: log routers (firelens),
   * proxies (Envoy/App Mesh), metric agents (otel/cloudwatch), or any
   * companion process that shares the task's network namespace.
   */
  sidecars?: ecs.ContainerDefinition[];
  /**
   * Task definition network mode.
   * @default "awsvpc"
   */
  networkMode?: ecs.NetworkMode;
  /**
   * Launch-type compatibilities the task definition must support.
   * @default ["FARGATE"]
   */
  requiresCompatibilities?: ecs.Compatibility[];
  /**
   * Task-level data volumes (host / docker / EFS / FSx Windows / S3 /
   * configured-at-launch). Containers reference these via `mountPoints`.
   */
  volumes?: ecs.Volume[];
  /**
   * Task definition placement constraints (`memberOf` expressions). Only
   * applies to EC2/EXTERNAL launch types.
   */
  placementConstraints?: ecs.TaskDefinitionPlacementConstraint[];
  /**
   * CPU architecture and operating-system family the task runs on, e.g.
   * `{ cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX" }`.
   */
  runtimePlatform?: ecs.RuntimePlatform;
  /**
   * Amount of ephemeral storage (in GiB) to allocate for the task on Fargate.
   */
  ephemeralStorage?: ecs.EphemeralStorage;
  /**
   * IPC resource namespace to use for the containers in the task.
   */
  ipcMode?: ecs.IpcMode;
  /**
   * Process namespace to use for the containers in the task.
   */
  pidMode?: ecs.PidMode;
  /**
   * App Mesh proxy configuration.
   */
  proxyConfiguration?: ecs.ProxyConfiguration;
  /**
   * Elastic Inference accelerators to attach to the task.
   */
  inferenceAccelerators?: ecs.InferenceAccelerator[];
  /**
   * Whether to enable AWS Fault Injection (FIS) actions on the task.
   * @default false
   */
  enableFaultInjection?: boolean;
  /**
   * Additional task definition overrides applied last (escape hatch for
   * fields not yet surfaced as first-class props).
   */
  taskDefinition?: Partial<
    Omit<
      ecs.RegisterTaskDefinitionRequest,
      | "family"
      | "containerDefinitions"
      | "executionRoleArn"
      | "taskRoleArn"
      | "cpu"
      | "memory"
    >
  >;
  /**
   * Additional managed policy ARNs for the task role.
   */
  taskRoleManagedPolicyArns?: string[];
  /**
   * Additional managed policy ARNs for the execution role.
   */
  executionRoleManagedPolicyArns?: string[];
  /**
   * User-defined tags to apply to task-owned resources.
   */
  tags?: Record<string, string>;
}

export interface Task extends Resource<
  "AWS.ECS.Task",
  TaskProps,
  {
    /** The ARN of the registered task definition revision. */
    taskDefinitionArn: string;
    /** The task definition family name. */
    taskFamily: string;
    /** The name of the main container in the task definition. */
    containerName: string;
    /** The container port the task listens on. */
    port: number;
    /** The full URI of the container image the task runs. */
    imageUri: string;
    /** The name of the ECR repository holding the built image. */
    repositoryName: string;
    /** The URI of the ECR repository holding the built image. */
    repositoryUri: string;
    /** The ARN of the task role assumed by the running containers. */
    taskRoleArn: string;
    /** The name of the task role. */
    taskRoleName: string;
    /** The ARN of the execution role used to pull images and write logs. */
    executionRoleArn: string;
    /** The name of the execution role. */
    executionRoleName: string;
    /** The CloudWatch log group the task writes to. */
    logGroupName: string;
    /** The ARN of the CloudWatch log group. */
    logGroupArn: string;
    /** The content hash of the bundled application code. */
    code: {
      /** The content hash of the bundled application code. */
      hash: string;
    };
  },
  {
    /** Environment variables injected into the task's containers. */
    env?: Record<string, any>;
    /** IAM policy statements attached to the task role. */
    policyStatements?: PolicyStatement[];
    /**
     * Task-level volumes requested through the binding channel (e.g.
     * `EFS.Mount`). Merged with the Task's own `volumes` prop.
     */
    volumes?: ecs.Volume[];
    /**
     * Container mount points for binding-requested volumes, applied to the
     * primary container.
     */
    mountPoints?: ecs.MountPoint[];
  },
  Providers
> {}

export type TaskServices = Credentials | Region | ServerHost | AWSEnvironment;

export type TaskShape = Main<TaskServices>;

export interface TaskRuntimeContext extends HostRuntimeContext {
  readonly Type: "AWS.ECS.Task";
}

/**
 * A bundled ECS task definition.
 *
 * `Task` bundles an inline Effect program, builds and pushes a Docker image to
 * a generated ECR repository, provisions task + execution IAM roles and a
 * CloudWatch log group, and registers a Fargate task definition. Each reconcile
 * registers a new immutable revision.
 *
 * Beyond the single bundled container you can declare task-level configuration
 * (volumes, runtime platform, ephemeral storage, IPC/PID mode, placement
 * constraints) and append additional `sidecars` for multi-container tasks.
 * @resource
 * @section Creating a Task
 * @example Basic Task
 * ```typescript
 * const task = yield* Task("ApiTask", {
 *   main: import.meta.url,
 *   cpu: 256,
 *   memory: 512,
 *   port: 3000,
 * });
 * ```
 *
 * @section Multi-Container Tasks
 * @example Task with a Sidecar
 * ```typescript
 * const task = yield* Task("ApiTask", {
 *   main: import.meta.url,
 *   port: 3000,
 *   sidecars: [
 *     {
 *       name: "otel-collector",
 *       image: "public.ecr.aws/aws-observability/aws-otel-collector:latest",
 *       essential: false,
 *       portMappings: [{ containerPort: 4317, protocol: "tcp" }],
 *     },
 *   ],
 * });
 * ```
 *
 * @section Task-Level Configuration
 * @example ARM64 with EFS Volume and Ephemeral Storage
 * ```typescript
 * const task = yield* Task("WorkerTask", {
 *   main: import.meta.url,
 *   runtimePlatform: { cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX" },
 *   ephemeralStorage: { sizeInGiB: 40 },
 *   volumes: [
 *     {
 *       name: "data",
 *       efsVolumeConfiguration: { fileSystemId: fileSystem.fileSystemId },
 *     },
 *   ],
 *   container: {
 *     mountPoints: [{ sourceVolume: "data", containerPath: "/data" }],
 *   },
 * });
 * ```
 */
export const Task: Platform<Task, TaskServices, TaskShape, TaskRuntimeContext> =
  Platform("AWS.ECS.Task", {
    createRuntimeContext: createHostRuntimeContext("AWS.ECS.Task") as (
      id: string,
    ) => TaskRuntimeContext,
  });

export const TaskProvider = () =>
  Provider.effect(
    Task,
    Effect.gen(function* () {
      const stack = yield* Stack;
      const docker = yield* Docker;

      const { dotAlchemy } = yield* AlchemyContext;
      const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;

      const alchemyEnv = {
        ALCHEMY_STACK_NAME: stack.name,
        ALCHEMY_STAGE: stack.stage,
        ALCHEMY_PHASE: "runtime",
      };

      const toTaskFamily = (id: string, props: { taskName?: string } = {}) =>
        props.taskName
          ? Effect.succeed(props.taskName)
          : createPhysicalName({
              id,
              maxLength: 255,
              lowercase: true,
            });

      const createRoleName = (id: string, suffix: string) =>
        createPhysicalName({
          id: `${id}-${suffix}`,
          maxLength: 64,
        });

      const createPolicyName = (id: string, suffix: string) =>
        createPhysicalName({
          id: `${id}-${suffix}`,
          maxLength: 128,
        });

      const createRepositoryName = (id: string) =>
        createPhysicalName({
          id: `${id}-repo`,
          maxLength: 256,
          lowercase: true,
        });

      const createLogGroupName = (id: string) =>
        createPhysicalName({
          id: `${id}-logs`,
          maxLength: 512,
          lowercase: true,
        });

      const createTaskRoleIfNotExists = Effect.fn(function* ({
        id,
        roleName,
      }: {
        id: string;
        roleName: string;
      }) {
        const tags = yield* createInternalTags(id);
        const role = yield* iam
          .createRole({
            RoleName: roleName,
            AssumeRolePolicyDocument: JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: {
                    Service: "ecs-tasks.amazonaws.com",
                  },
                  Action: "sts:AssumeRole",
                },
              ],
            }),
            Tags: createTagsList(tags),
          })
          .pipe(
            Effect.catchTag("EntityAlreadyExistsException", () =>
              iam.getRole({ RoleName: roleName }).pipe(
                Effect.filterOrFail(
                  (existing) => hasTags(tags, existing.Role?.Tags),
                  () =>
                    new Error(
                      `Role '${roleName}' already exists and is not managed by alchemy`,
                    ),
                ),
              ),
            ),
          );
        return role.Role!.Arn!;
      });

      const ensureExecutionRole = Effect.fn(function* ({
        id,
        roleName,
        managedPolicyArns,
      }: {
        id: string;
        roleName: string;
        managedPolicyArns?: string[];
      }) {
        const roleArn = yield* createTaskRoleIfNotExists({ id, roleName });
        const policies = [
          "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
          ...(managedPolicyArns ?? []),
        ];
        for (const policyArn of policies) {
          yield* iam
            .attachRolePolicy({
              RoleName: roleName,
              PolicyArn: policyArn,
            })
            .pipe(Effect.catchTag("LimitExceededException", () => Effect.void));
        }
        return roleArn;
      });

      const ensureRepository = Effect.fn(function* ({
        repositoryName,
        tags,
      }: {
        id: string;
        repositoryName: string;
        tags: Record<string, string>;
      }) {
        const created = yield* ecr
          .createRepository({
            repositoryName,
            imageTagMutability: "MUTABLE",
            imageScanningConfiguration: {
              scanOnPush: true,
            },
            tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
          })
          .pipe(
            Effect.catchTag("RepositoryAlreadyExistsException", () =>
              Effect.gen(function* () {
                const existing = yield* ecr.describeRepositories({
                  repositoryNames: [repositoryName],
                });
                return {
                  repository: existing.repositories?.[0],
                };
              }),
            ),
          );
        const repository = created.repository;
        if (!repository?.repositoryUri || !repository.repositoryArn) {
          return yield* Effect.die(
            new Error(`Failed to resolve ECR repository '${repositoryName}'`),
          );
        }
        return {
          repositoryUri: repository.repositoryUri,
          repositoryArn: repository.repositoryArn,
        };
      });

      const ensureLogGroup = Effect.fn(function* ({
        id,
        logGroupName,
      }: {
        id: string;
        logGroupName: string;
      }) {
        const { accountId, region } = yield* AWSEnvironment.current;
        const tags = yield* createInternalTags(id);
        yield* logs
          .createLogGroup({
            logGroupName,
            tags,
          })
          .pipe(
            Effect.catchTag(
              "ResourceAlreadyExistsException",
              () => Effect.void,
            ),
          );
        return `arn:aws:logs:${region}:${accountId}:log-group:${logGroupName}`;
      });

      const attachBindings = Effect.fn(function* ({
        roleName,
        policyName,
        bindings,
      }: {
        roleName: string;
        policyName: string;
        bindings: ResourceBinding<Task["Binding"]>[];
      }) {
        const activeBindings = bindings.filter(
          (binding: ResourceBinding<Task["Binding"]> & { action?: string }) =>
            binding.action !== "delete",
        );

        const env = activeBindings
          .map((binding) => binding?.data?.env)
          .reduce((acc, value) => ({ ...acc, ...value }), {});

        const policyStatements = activeBindings.flatMap(
          (binding) =>
            binding?.data?.policyStatements?.map((statement) => ({
              ...statement,
              Sid: statement.Sid?.replace(/[^A-Za-z0-9]+/gi, ""),
            })) ?? [],
        );

        // Volumes/mount points requested through the binding channel (e.g.
        // `EFS.Mount`) — deduped by volume name / container path; merged
        // with the `volumes` prop and primary container in `reconcile`.
        const volumes = [
          ...new Map(
            activeBindings
              .flatMap((binding) => binding?.data?.volumes ?? [])
              .map((volume) => [volume.name, volume] as const),
          ).values(),
        ];
        const mountPoints = [
          ...new Map(
            activeBindings
              .flatMap((binding) => binding?.data?.mountPoints ?? [])
              .map((point) => [point.containerPath, point] as const),
          ).values(),
        ];

        if (policyStatements.length > 0) {
          yield* iam.putRolePolicy({
            RoleName: roleName,
            PolicyName: policyName,
            PolicyDocument: JSON.stringify({
              Version: "2012-10-17",
              Statement: policyStatements,
            }),
          });
        } else {
          yield* iam
            .deleteRolePolicy({
              RoleName: roleName,
              PolicyName: policyName,
            })
            .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
        }

        return { env, volumes, mountPoints };
      });

      const bundleProgram = Effect.fn(function* (id: string, props: TaskProps) {
        const handler = props.handler ?? "default";
        const realMain = yield* resolveMainPath(props.main);
        const cwd = yield* findCwdForBundle(realMain);

        const buildBundle = Effect.fn(function* (
          entry: string,
          plugins?: rolldown.RolldownPluginOption,
        ) {
          return yield* Bundle.build(
            {
              ...props.build?.input,
              input: entry,
              cwd,
              platform: "node",
              // The container runs on `bun`; keep `bun`/`bun:*` external (the
              // runtime provides them) and resolve the `bun` export condition
              // so `@effect/platform-bun` picks its Bun implementations.
              external: [
                "bun",
                "bun:*",
                ...((props.build?.input?.external as string[] | undefined) ??
                  []),
              ],
              resolve: {
                conditionNames: ["bun", "import", "module", "default"],
                ...props.build?.input?.resolve,
              },
              plugins: [props.build?.input?.plugins, plugins],
            },
            {
              ...props.build?.output,
              format: "esm",
              sourcemap: props.build?.output?.sourcemap ?? false,
              minify: props.build?.output?.minify ?? false,
              entryFileNames: "index.mjs",
            },
          );
        });

        const bundleOutput = props.isExternal
          ? yield* buildBundle(realMain)
          : yield* buildBundle(
              realMain,
              virtualEntryPlugin(
                (importPath) => `
import { BunServices } from "@effect/platform-bun";
import { BunHttpServer } from "alchemy/Http";
import { Stack } from "alchemy/Stack";
import { reifyBoundConfigProvider } from "alchemy/Runtime";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Region from "@distilled.cloud/aws/Region";

import { ${handler} as handler } from ${JSON.stringify(importPath)};

const platform = Layer.mergeAll(
  BunServices.layer,
  FetchHttpClient.layer,
  Logger.layer([Logger.consolePretty()]),
);

// Resolve the bundled program (the runners registered via host.run / serve)
// and run it with a Bun HTTP server bound to PORT, so a returned { fetch }
// handler is actually served and host.run loops stay alive.
const program = handler.pipe(
  Effect.flatMap((task) => task.RuntimeContext.exports),
  Effect.flatMap((exports) => exports.program),
  Effect.provide(
    Layer.effect(
      Stack,
      Effect.all([
        Config.string("ALCHEMY_STACK_NAME"),
        Config.string("ALCHEMY_STAGE")
      ]).pipe(
        Effect.map(([name, stage]) => ({
          name,
          stage,
          bindings: {},
          resources: {}
        }))
      )
    ).pipe(
      Layer.provideMerge(Credentials.fromEnv()),
      Layer.provideMerge(Region.fromEnv()),
      Layer.provideMerge(BunHttpServer()),
      Layer.provideMerge(platform),
      Layer.provideMerge(
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          reifyBoundConfigProvider(ConfigProvider.fromEnv(), process.env)
        )
      ),
    )
  ),
  Effect.scoped
);

console.log("Task bootstrap starting...");
await Effect.runPromise(program).catch((err) => {
  console.error("Task bootstrap failed:", err);
  process.exit(1);
});
`,
              ),
            );

        // Return every emitted file (entry + shared chunks). Dynamic imports in
        // the Bun HTTP server / AWS SDK split into chunks; dropping any of them
        // crashes the container with `Cannot find module './chunk-XXX.js'`.
        const files = bundleOutput.files.map((file) => ({
          path: file.path,
          content:
            typeof file.content === "string"
              ? new TextEncoder().encode(file.content)
              : file.content,
        }));

        return { files, hash: bundleOutput.hash };
      });

      const buildAndPushImage = Effect.fn(function* ({
        id,
        repositoryUri,
        hash,
        files,
        props,
      }: {
        id: string;
        repositoryUri: string;
        hash: string;
        files: { path: string; content: Uint8Array<ArrayBufferLike> }[];
        props: TaskProps;
      }) {
        const realMain = yield* resolveMainPath(props.main);
        const contextDir = yield* getStableContextDir(
          realMain,
          dotAlchemy,
          `${id}-image`,
        );
        const imageUri = `${repositoryUri}:${hash}`;

        const generatedDockerfile = (() => {
          const base =
            props.docker?.base ?? "public.ecr.aws/docker/library/bun:1";
          const lines = [
            `FROM ${base}`,
            `WORKDIR /app`,
            `COPY index.mjs /app/index.mjs`,
            // Copy any additional rolldown chunks (`chunk-XXX.js`,
            // `BunServices-YYY.js`, …). Non-trivial bundles always emit at
            // least one; minimal bundles emit none and the COPY no-ops.
            `COPY *.js /app/`,
          ];
          if (props.port !== undefined) {
            lines.push(
              `ENV PORT=${String(props.port)}`,
              `EXPOSE ${String(props.port)}`,
            );
          }
          lines.push(`ENTRYPOINT ["bun", "/app/index.mjs"]`);
          return `${lines.join("\n")}\n`;
        })();

        const dockerfile = props.docker?.dockerfile ?? generatedDockerfile;

        yield* docker.materialize({
          context: contextDir,
          dockerfile: dockerfile,
          // Entry chunk becomes `index.mjs`; all other chunks keep their
          // emitted `*.js` names so the entry's relative imports resolve.
          files: files.map((file, index) => ({
            path: index === 0 ? "index.mjs" : file.path,
            content: file.content,
          })),
        });
        // Build for the architecture the task definition declares (Fargate
        // defaults to X86_64 when `runtimePlatform` is unset). Without this, an
        // image built on an ARM64 host (e.g. Apple Silicon) is rejected at task
        // start with `image Manifest does not contain descriptor matching
        // platform 'linux/amd64'`.
        const buildPlatform =
          props.runtimePlatform?.cpuArchitecture === "ARM64"
            ? "linux/arm64"
            : "linux/amd64";
        return yield* buildAndPushEcrImage(docker, {
          imageUri,
          context: contextDir,
          platform: buildPlatform,
        });
      });

      const registerTaskDefinition = Effect.fn(function* ({
        props,
        family,
        imageUri,
        taskRoleArn,
        executionRoleArn,
        logGroupName,
        tags,
        bindingVolumes = [],
        bindingMountPoints = [],
      }: {
        props: TaskProps;
        family: string;
        imageUri: string;
        taskRoleArn: string;
        executionRoleArn: string;
        logGroupName: string;
        tags: Record<string, string>;
        /** Task-level volumes requested through the binding channel. */
        bindingVolumes?: ecs.Volume[];
        /** Primary-container mount points for binding-requested volumes. */
        bindingMountPoints?: ecs.MountPoint[];
      }) {
        const { region } = yield* AWSEnvironment.current;
        const containerName = props.container?.name ?? family;
        const primaryContainer: ecs.ContainerDefinition = {
          essential: true,
          name: containerName,
          image: imageUri,
          portMappings:
            props.port !== undefined
              ? [
                  {
                    containerPort: props.port,
                    hostPort: props.port,
                    protocol: "tcp",
                  },
                ]
              : undefined,
          environment: Object.entries(props.env ?? {}).map(([name, value]) => ({
            name,
            value: typeof value === "string" ? value : JSON.stringify(value),
          })),
          logConfiguration: {
            logDriver: "awslogs",
            options: {
              "awslogs-group": logGroupName,
              "awslogs-region": region,
              "awslogs-stream-prefix": family,
            },
          },
          ...props.container,
          // Merge binding-requested mount points (e.g. `EFS.Mount`) with any
          // the user configured on the primary container.
          ...(bindingMountPoints.length > 0
            ? {
                mountPoints: [
                  ...(props.container?.mountPoints ?? []),
                  ...bindingMountPoints,
                ],
              }
            : {}),
        };
        const response = yield* ecs.registerTaskDefinition({
          family,
          taskRoleArn,
          executionRoleArn,
          networkMode: props.networkMode ?? "awsvpc",
          requiresCompatibilities: props.requiresCompatibilities ?? ["FARGATE"],
          cpu: String(props.cpu ?? 256),
          memory: String(props.memory ?? 512),
          volumes:
            bindingVolumes.length > 0
              ? [...(props.volumes ?? []), ...bindingVolumes]
              : props.volumes,
          placementConstraints: props.placementConstraints,
          runtimePlatform: props.runtimePlatform,
          ephemeralStorage: props.ephemeralStorage,
          ipcMode: props.ipcMode,
          pidMode: props.pidMode,
          proxyConfiguration: props.proxyConfiguration,
          inferenceAccelerators: props.inferenceAccelerators,
          enableFaultInjection: props.enableFaultInjection,
          ...props.taskDefinition,
          containerDefinitions: [primaryContainer, ...(props.sidecars ?? [])],
          tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
        });
        const taskDefinition = response.taskDefinition;
        if (!taskDefinition?.taskDefinitionArn) {
          return yield* Effect.die(
            new Error("registerTaskDefinition returned no task definition"),
          );
        }
        return taskDefinition;
      });

      // Reconstruct the full `Task` Attributes shape from a described task
      // definition. Returns `undefined` for task definitions that don't match
      // the shape this provider produces (single container whose image is an
      // ECR `<repoUri>:<hash>`, task/execution role ARNs, an awslogs log group)
      // so foreign task definitions in the account are skipped by `list()`.
      const toListAttributes = (
        taskDefinition: ecs.TaskDefinition,
        region: string,
        accountId: string,
      ): Task["Attributes"] | undefined => {
        if (!taskDefinition.taskDefinitionArn || !taskDefinition.family) {
          return undefined;
        }
        const container = taskDefinition.containerDefinitions?.[0];
        const image = container?.image;
        const taskRoleArn = taskDefinition.taskRoleArn;
        const executionRoleArn = taskDefinition.executionRoleArn;
        const logGroupName =
          container?.logConfiguration?.options?.["awslogs-group"];
        if (
          !container?.name ||
          !image ||
          !image.includes(":") ||
          !taskRoleArn ||
          !executionRoleArn ||
          !logGroupName
        ) {
          return undefined;
        }
        const lastColon = image.lastIndexOf(":");
        const repositoryUri = image.slice(0, lastColon);
        const hash = image.slice(lastColon + 1);
        const repositoryName = repositoryUri.split("/").slice(1).join("/");
        const taskRoleName = taskRoleArn.split(":role/")[1] ?? taskRoleArn;
        const executionRoleName =
          executionRoleArn.split(":role/")[1] ?? executionRoleArn;
        return {
          taskDefinitionArn: taskDefinition.taskDefinitionArn,
          taskFamily: taskDefinition.family,
          containerName: container.name,
          port: container.portMappings?.[0]?.containerPort ?? 3000,
          imageUri: image,
          repositoryName,
          repositoryUri,
          taskRoleArn,
          taskRoleName,
          executionRoleArn,
          executionRoleName,
          logGroupName,
          logGroupArn: `arn:aws:logs:${region}:${accountId}:log-group:${logGroupName}`,
          code: { hash },
        };
      };

      return {
        stables: [
          "repositoryName",
          "repositoryUri",
          "taskRoleArn",
          "taskRoleName",
          "executionRoleArn",
          "executionRoleName",
          "logGroupName",
          "logGroupArn",
          "taskFamily",
        ],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toTaskFamily(id, olds ?? {})) !==
            (yield* toTaskFamily(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const family =
            output?.taskFamily ?? (yield* toTaskFamily(id, olds ?? {}));
          const described = yield* ecs
            .describeTaskDefinition({
              taskDefinition: output?.taskDefinitionArn ?? family,
            })
            .pipe(
              Effect.catchTag("ClientException", () =>
                Effect.succeed(undefined),
              ),
            );
          const taskDefinition = described?.taskDefinition;
          if (!taskDefinition?.taskDefinitionArn) {
            return undefined;
          }
          if (!output) {
            return undefined;
          }
          return {
            ...output,
            taskDefinitionArn: taskDefinition.taskDefinitionArn,
            taskFamily: taskDefinition.family ?? family,
            containerName:
              taskDefinition.containerDefinitions?.[0]?.name ??
              output.containerName,
            port:
              taskDefinition.containerDefinitions?.[0]?.portMappings?.[0]
                ?.containerPort ?? output.port,
          };
        }),
        reconcile: Effect.fn(function* ({
          id,
          news,
          bindings,
          output,
          session,
        }) {
          // Prefer the deployed name: regenerating would target a different
          // resource if the generator's output for this id ever drifts. (An
          // explicit taskName change arrives here as a fresh replacement
          // instance with no output.)
          const family = output?.taskFamily ?? (yield* toTaskFamily(id, news));
          const taskRoleName =
            output?.taskRoleName ?? (yield* createRoleName(id, "task-role"));
          const executionRoleName =
            output?.executionRoleName ??
            (yield* createRoleName(id, "execution-role"));
          const taskPolicyName = yield* createPolicyName(id, "task-policy");
          const repositoryName =
            output?.repositoryName ?? (yield* createRepositoryName(id));
          const logGroupName =
            output?.logGroupName ?? (yield* createLogGroupName(id));
          const tags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };

          // Ensure roles, repository, and log group. Each helper is
          // idempotent (creates on miss, adopts on race) so the same
          // sequence runs on initial create, adoption, or update.
          const taskRoleArn =
            output?.taskRoleArn ??
            (yield* createTaskRoleIfNotExists({ id, roleName: taskRoleName }));
          const executionRoleArn =
            output?.executionRoleArn ??
            (yield* ensureExecutionRole({
              id,
              roleName: executionRoleName,
              managedPolicyArns: news.executionRoleManagedPolicyArns,
            }));

          for (const policyArn of news.taskRoleManagedPolicyArns ?? []) {
            yield* iam
              .attachRolePolicy({
                RoleName: taskRoleName,
                PolicyArn: policyArn,
              })
              .pipe(
                Effect.catchTag("LimitExceededException", () => Effect.void),
              );
          }

          const {
            env: bindingEnv,
            volumes: bindingVolumes,
            mountPoints: bindingMountPoints,
          } = yield* attachBindings({
            roleName: taskRoleName,
            policyName: taskPolicyName,
            bindings,
          });

          const { repositoryUri } =
            output?.repositoryUri && output?.repositoryName === repositoryName
              ? {
                  repositoryUri: output.repositoryUri,
                }
              : yield* ensureRepository({
                  id,
                  repositoryName,
                  tags,
                });
          const logGroupArn =
            output?.logGroupArn ??
            (yield* ensureLogGroup({
              id,
              logGroupName,
            }));

          // Build, push, and register a new task definition revision. Task
          // definitions are versioned in AWS, so registering a new revision
          // is the unit of "update" — the prior revision is deregistered
          // only on `delete` of the resource.
          const { files, hash } = yield* bundleProgram(id, news);
          const imageUri = yield* buildAndPushImage({
            id,
            repositoryUri,
            hash,
            files,
            props: {
              ...news,
              env: {
                ...bindingEnv,
                ...alchemyEnv,
                ...news.env,
              },
            },
          });
          const taskDefinition = yield* registerTaskDefinition({
            props: {
              ...news,
              env: {
                ...bindingEnv,
                ...alchemyEnv,
                ...news.env,
              },
            },
            family,
            imageUri,
            taskRoleArn,
            executionRoleArn,
            logGroupName,
            tags,
            bindingVolumes,
            bindingMountPoints,
          });

          // Sync tags — task definition revisions carry tags at register
          // time, but tags are mutable on the revision ARN. Diff the observed
          // revision tags against desired so tag-only updates converge.
          const revisionArn = taskDefinition.taskDefinitionArn!;
          const observedTags = Object.fromEntries(
            (
              (yield* ecs
                .listTagsForResource({ resourceArn: revisionArn })
                .pipe(
                  Effect.catchTag("ClientException", () =>
                    Effect.succeed({ tags: undefined } as { tags?: ecs.Tag[] }),
                  ),
                )).tags ?? []
            )
              .filter(
                (t): t is { key: string; value: string } =>
                  typeof t.key === "string" && typeof t.value === "string",
              )
              .map((t) => [t.key, t.value]),
          );
          const { removed: removedTags, upsert: upsertTags } = diffTags(
            observedTags,
            tags,
          );
          if (upsertTags.length > 0) {
            yield* ecs.tagResource({
              resourceArn: revisionArn,
              tags: upsertTags.map((t) => ({ key: t.Key, value: t.Value })),
            });
          }
          if (removedTags.length > 0) {
            yield* ecs.untagResource({
              resourceArn: revisionArn,
              tagKeys: removedTags,
            });
          }

          yield* session.note(taskDefinition.taskDefinitionArn!);
          return {
            taskDefinitionArn: taskDefinition.taskDefinitionArn!,
            taskFamily: family,
            containerName:
              taskDefinition.containerDefinitions?.[0]?.name ?? family,
            port: news.port ?? output?.port ?? 3000,
            imageUri,
            repositoryName,
            repositoryUri,
            taskRoleArn,
            taskRoleName,
            executionRoleArn,
            executionRoleName,
            logGroupName,
            logGroupArn,
            code: {
              hash,
            },
          };
        }),
        // Enumerate every ACTIVE task definition in the account/region,
        // hydrate each via `describeTaskDefinition`, and reconstruct the full
        // Attributes shape. Foreign task definitions that don't match the shape
        // this provider produces are skipped (see `toListAttributes`).
        list: () =>
          Effect.gen(function* () {
            const { accountId, region } = yield* AWSEnvironment.current;
            const arns = yield* ecs.listTaskDefinitions
              .pages({ status: "ACTIVE" })
              .pipe(
                Stream.runCollect,
                Effect.map((chunk) =>
                  Array.from(chunk).flatMap(
                    (page) => page.taskDefinitionArns ?? [],
                  ),
                ),
              );
            const rows = yield* Effect.forEach(
              arns,
              (arn) =>
                ecs.describeTaskDefinition({ taskDefinition: arn }).pipe(
                  Effect.map((described) =>
                    described.taskDefinition
                      ? toListAttributes(
                          described.taskDefinition,
                          region,
                          accountId,
                        )
                      : undefined,
                  ),
                  Effect.catchTag("ClientException", () =>
                    Effect.succeed(undefined),
                  ),
                ),
              { concurrency: 10 },
            );
            return rows.filter(
              (row): row is Task["Attributes"] => row !== undefined,
            );
          }),
        delete: Effect.fn(function* ({ output }) {
          yield* ecs
            .deregisterTaskDefinition({
              taskDefinition: output.taskDefinitionArn,
            })
            .pipe(Effect.catchTag("ClientException", () => Effect.void));

          // Deregistering only flips the revision to INACTIVE — it still
          // exists (and shows up in `listTaskDefinitions --status INACTIVE`)
          // forever. Hard-delete it so destroying a Task leaves zero
          // task-definition leftovers.
          yield* ecs
            .deleteTaskDefinitions({
              taskDefinitions: [output.taskDefinitionArn],
            })
            .pipe(Effect.catchTag("ClientException", () => Effect.void));

          yield* ecr
            .deleteRepository({
              repositoryName: output.repositoryName,
              force: true,
            })
            .pipe(
              Effect.catchTag("RepositoryNotFoundException", () => Effect.void),
            );

          yield* logs
            .deleteLogGroup({
              logGroupName: output.logGroupName,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );

          yield* iam
            .listRolePolicies({
              RoleName: output.taskRoleName,
            })
            .pipe(
              // The role may already be gone (delete re-run / race) — treat a
              // missing role as "no policies to delete" so delete is idempotent.
              Effect.catchTag("NoSuchEntityException", () =>
                Effect.succeed({ PolicyNames: [] as string[] }),
              ),
              Effect.flatMap((policies) =>
                Effect.all(
                  (policies.PolicyNames ?? []).map((policyName) =>
                    iam
                      .deleteRolePolicy({
                        RoleName: output.taskRoleName,
                        PolicyName: policyName,
                      })
                      .pipe(
                        Effect.catchTag(
                          "NoSuchEntityException",
                          () => Effect.void,
                        ),
                      ),
                  ),
                ),
              ),
            );

          for (const roleName of [
            output.taskRoleName,
            output.executionRoleName,
          ]) {
            yield* iam
              .listAttachedRolePolicies({
                RoleName: roleName,
              })
              .pipe(
                Effect.catchTag("NoSuchEntityException", () =>
                  Effect.succeed({ AttachedPolicies: [] }),
                ),
                Effect.flatMap((policies) =>
                  Effect.all(
                    (policies.AttachedPolicies ?? []).map((policy) =>
                      iam
                        .detachRolePolicy({
                          RoleName: roleName,
                          PolicyArn: policy.PolicyArn!,
                        })
                        .pipe(
                          Effect.catchTag(
                            "NoSuchEntityException",
                            () => Effect.void,
                          ),
                        ),
                    ),
                  ),
                ),
              );
            yield* iam
              .deleteRole({
                RoleName: roleName,
              })
              .pipe(
                Effect.catchTag("NoSuchEntityException", () => Effect.void),
              );
          }
        }),
      };
    }),
  );
