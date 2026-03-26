import type * as cf from "@cloudflare/workers-types";
import * as Containers from "@distilled.cloud/cloudflare/containers";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { Fiber } from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as ServiceMap from "effect/ServiceMap";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { SingleShotGen } from "effect/Utils";
import type { PolicyLike } from "../Binding.ts";
import { bundle } from "../Bundle/Bundle.ts";
import {
  pushImageViaDockerApi,
  runDockerCommand,
  writeDockerContext,
} from "../Bundle/Docker.ts";
import {
  cleanupBundleTempDir,
  createTempBundleDir,
} from "../Bundle/TempRoot.ts";
import { DotAlchemy } from "../Config.ts";
import type { HttpEffect } from "../Http.ts";
import type { Input } from "../Input.ts";
import * as Output from "../Output.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import type { Provider } from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Self } from "../Self.ts";
import { sha256Object } from "../Util/sha256.ts";
import { normalizeNulls, stableStringify } from "../Util/stable.ts";
import { Account } from "./Account.ts";
import {
  DurableObjectNamespace,
  DurableObjectState,
} from "./Workers/DurableObject.ts";
import { fromCloudflareFetcher, type Fetcher } from "./Workers/Fetcher.ts";

export { Credentials } from "@distilled.cloud/cloudflare/Credentials";

const TypeId = "Cloudflare.Container";
type TypeId = typeof TypeId;

export const isContainer = <T>(value: T): value is T & Container =>
  typeof value === "object" &&
  value !== null &&
  "Type" in value &&
  value.Type === TypeId;

export interface ContainerApplicationProps {
  /**
   * Main entrypoint for the container program. This file is bundled and
   * added to the Docker image as the container's entrypoint.
   */
  main?: string;
  /**
   * Runtime environment for the container program.
   *
   * @default "bun"
   */
  runtime?: "bun" | "node";
  /**
   * Human-readable application name. If omitted, Alchemy derives a deterministic
   * physical name from the stack, stage, and logical ID.
   */
  name?: string;
  /**
   * Inline Dockerfile used as the base for building the container image.
   * Alchemy appends statements to copy the bundled program and set the
   * entrypoint. If omitted, a default base image matching the runtime is used.
   */
  dockerfile?: string;
  /**
   * Initial number of instances to maintain.
   * @default 1
   */
  instances?: number;
  /**
   * Maximum number of instances the application may scale to.
   * @default 1
   */
  maxInstances?: number;
  /**
   * Scheduling policy used by Cloudflare's containers control plane.
   * @default "default"
   */
  schedulingPolicy?: SchedulingPolicy;
  /**
   * Instance type for each deployment.
   * @default "dev"
   */
  instanceType?: InstanceType;
  /**
   * Observability settings for the deployment.
   */
  observability?: Observability;
  /**
   * SSH public keys to install into the deployment.
   */
  sshPublicKeyIds?: string[];
  /**
   * Secrets exposed to the container runtime as environment variables.
   */
  secrets?: Secret[];
  /**
   * CPU allocation override for each deployment.
   */
  vcpu?: number;
  /**
   * Memory allocation override for each deployment.
   */
  memory?: string;
  /**
   * Disk allocation override for each deployment.
   */
  disk?: Disk;
  /**
   * Plain environment variables passed to the container runtime.
   */
  environmentVariables?: EnvironmentVariable[];
  /**
   * Labels attached to the deployment.
   */
  labels?: Label[];
  /**
   * Network configuration for the deployment.
   */
  network?: Network;
  /**
   * Command override for the container image.
   */
  command?: string[];
  /**
   * Entrypoint override for the container image.
   */
  entrypoint?: string[];
  /**
   * DNS configuration for the deployment.
   */
  dns?: Dns;
  /**
   * Exposed ports for the deployment.
   */
  ports?: Port[];
  /**
   * Health and readiness checks for the deployment.
   */
  checks?: Check[];
  /**
   * Resource constraints for the application.
   */
  constraints?: Constraints;
  /**
   * Affinity hints for scheduling.
   */
  affinities?: Affinities;
  /**
   * Progressive rollout settings applied after updates.
   */
  rollout?: Rollout;
  /**
   * Adopt an existing application with the same name instead of failing.
   * @default false
   */
  adopt?: boolean;
  /**
   * Container registry host to use for generated Dockerfile builds.
   * @default "registry.cloudflare.com"
   */
  registryId?: string;
  /**
   * Durable Object namespace attached to the container application.
   */
  durableObjects?: {
    namespaceId: string;
  };
}

export type ContainerApplication = Resource<
  TypeId,
  ContainerApplicationProps,
  {
    applicationId: string;
    applicationName: string;
    accountId: string;
    schedulingPolicy: SchedulingPolicy;
    instances: number;
    maxInstances: number;
    constraints: Constraints | undefined;
    affinities: Affinities | undefined;
    configuration: Configuration;
    durableObjects:
      | {
          namespaceId: string;
        }
      | undefined;
    createdAt: string;
    version: number;
  }
> & {
  container: Effect.Effect<Container, never, DurableObjectState>;
};

const ContainerApplication = Resource<ContainerApplication>(TypeId);

export class ContainerError extends Data.TaggedError("ContainerError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface Container {
  get running(): Effect.Effect<boolean>;
  start(options?: cf.ContainerStartupOptions): Effect.Effect<void>;
  monitor(): Effect.Effect<void, ContainerError>;
  destroy(error?: any): Effect.Effect<void>;
  signal(signo: number): Effect.Effect<void>;
  getTcpPort(port: number): Effect.Effect<Fetcher>;
  setInactivityTimeout(durationMs: number | bigint): Effect.Effect<void>;
  interceptOutboundHttp(addr: string, binding: cf.Fetcher): Effect.Effect<void>;
  interceptAllOutboundHttp(binding: cf.Fetcher): Effect.Effect<void>;
}

export interface ContainerProps extends ContainerApplicationProps {
  main: string;
}

export const Container =
  <self>() =>
  <LogicalId extends string = string>(
    id: LogicalId,
    props: Input<ContainerProps>,
    // init: Effect.Effect<HttpEffect<RuntimeReq>, never, InfraReq>,
  ): Effect.Effect<
    ContainerApplication,
    never,
    self | Self<DurableObjectNamespace>
  > & {
    new (_: never): PolicyLike & {
      LogicalId: LogicalId;
    };
    make<InfraReq = never, RuntimeReq = never>(
      init: Effect.Effect<HttpEffect<RuntimeReq>, never, InfraReq>,
    ): Layer.Layer<self, never, InfraReq | Provider<ContainerApplication>>;
  } => {
    class Self extends ServiceMap.Service<self, any>()(`Container<${id}>`) {}
    return class {
      static readonly make = <InfraReq = never, RuntimeReq = never>(
        init: Effect.Effect<HttpEffect<RuntimeReq>, never, InfraReq>,
      ): Layer.Layer<self, never, InfraReq> => Layer.effect(Self, init);

      static [Symbol.iterator](): Iterator<
        Effect.Yieldable<any, void, never, self>,
        ContainerApplication,
        void
      > {
        return new SingleShotGen(this) as any;
      }

      static asEffect() {
        return Effect.gen(function* () {
          const namespace = yield* DurableObjectNamespace.Self;

          const containerProps = Output.asOutput(props).pipe(
            Output.map((props) => ({
              ...props,
              durableObjects:
                props.durableObjects ??
                ({
                  namespaceId: namespace.namespaceId,
                } as const),
            })),
          );

          const resource = yield* ContainerApplication(id, containerProps);

          // TODO(sam): register this in the Container Execution Context
          // const _httpEffect = yield* init;
          return Object.assign(resource, {
            // fetch: httpEffect,
            asEffect: () =>
              Effect.gen(function* () {
                const state = yield* DurableObjectState;
                return {
                  running: Effect.sync(() => state.container!.running ?? false),
                  destroy: (error?: any) =>
                    Effect.promise(() => state.container!.destroy(error)),
                  signal: (signo: number) =>
                    Effect.sync(() => state.container!.signal(signo)),
                  getTcpPort: (port: number) =>
                    Effect.sync(() =>
                      fromCloudflareFetcher(state.container!.getTcpPort(port)),
                    ),
                  setInactivityTimeout: (durationMs: number | bigint) =>
                    Effect.sync(() =>
                      state.container!.setInactivityTimeout(durationMs),
                    ),
                  interceptOutboundHttp: (addr: string, binding: cf.Fetcher) =>
                    Effect.sync(() =>
                      state.container!.interceptOutboundHttp(addr, binding),
                    ),
                  interceptAllOutboundHttp: (binding: cf.Fetcher) =>
                    Effect.sync(() =>
                      state.container!.interceptAllOutboundHttp(binding),
                    ),
                  monitor: () => Effect.sync(() => state.container!.monitor()),
                  start: (options?: cf.ContainerStartupOptions) =>
                    Effect.sync(() => state.container!.start(options)),
                } satisfies Container;
              }),
          }) as ContainerApplication;
        });
      }
    };
  };

export const initContainer = Effect.fnUntraced(function* (
  containerApplication: ContainerApplication,
) {
  // get the container instance
  const container = yield* containerApplication.container;
  const monitor = yield* SynchronizedRef.make<
    Fiber<void | void[], ContainerError> | undefined
  >(undefined);

  const start = container.start().pipe(
    Effect.andThen(() =>
      Effect.forkDetach(
        container.monitor().pipe(
          Effect.flatMap(() => Effect.logInfo("Container monitor stopped")),
          Effect.catchTag("ContainerError", (error) =>
            Effect.all([Effect.logError(error.message)]),
          ),
          Effect.ensuring(SynchronizedRef.set(monitor, undefined)),
        ),
      ),
    ),
  );

  if (!(yield* container.running)) {
    yield* SynchronizedRef.updateEffect(monitor, (current) =>
      current ? start : Effect.succeed(current),
    );
  }

  // TODO(sam): make configurable. is this too aggressive?
  const backoff = Schedule.exponential(50, 1.2).pipe(
    Schedule.modifyDelay((_, delay) =>
      Effect.succeed(Duration.max(delay, Duration.seconds(0.5))),
    ),
  );

  return {
    ...container,
    getTcpSocket: (portNumber: number) =>
      Effect.map(container.getTcpPort(portNumber), (port) => ({
        fetch: ((
          request:
            | HttpClientRequest.HttpClientRequest
            | HttpServerRequest.HttpServerRequest,
        ) =>
          port.fetch(request as any).pipe(
            Effect.tapError((err) => Effect.logDebug(err)),
            Effect.retry({
              schedule: backoff,
            }),
          )) as {
          (
            request: HttpClientRequest.HttpClientRequest,
          ): Effect.Effect<HttpClientResponse.HttpClientResponse>;
          (
            request: HttpServerRequest.HttpServerRequest,
          ): Effect.Effect<HttpServerResponse.HttpServerResponse>;
        },
      })),
  };
});

export type InstanceType = NonNullable<
  Containers.CreateContainerApplicationRequest["configuration"]["instanceType"]
>;
export type SchedulingPolicy = NonNullable<
  Containers.CreateContainerApplicationRequest["schedulingPolicy"]
>;
export type Observability = NonNullable<
  Containers.CreateContainerApplicationRequest["configuration"]["observability"]
>;
export type Secret = NonNullable<
  Containers.CreateContainerApplicationRequest["configuration"]["secrets"]
>[number];
export type Disk = NonNullable<
  Containers.CreateContainerApplicationRequest["configuration"]["disk"]
>;
export type EnvironmentVariable = NonNullable<
  Containers.CreateContainerApplicationRequest["configuration"]["environmentVariables"]
>[number];
export type Label = NonNullable<
  Containers.CreateContainerApplicationRequest["configuration"]["labels"]
>[number];
export type Network = NonNullable<
  Containers.CreateContainerApplicationRequest["configuration"]["network"]
>;
export type Dns = NonNullable<
  Containers.CreateContainerApplicationRequest["configuration"]["dns"]
>;
export type Port = NonNullable<
  Containers.CreateContainerApplicationRequest["configuration"]["ports"]
>[number];
export type Check = NonNullable<
  Containers.CreateContainerApplicationRequest["configuration"]["checks"]
>[number];
export type Constraints = {
  tier?: number;
};
export type Affinities = {
  colocation?: "datacenter";
};
export type Configuration =
  Containers.CreateContainerApplicationRequest["configuration"];
export interface Rollout {
  strategy?: "rolling" | "immediate";
  kind?: "full_auto";
  stepPercentage?: number;
}

export const ContainerProvider = () =>
  ContainerApplication.provider.effect(
    Effect.gen(function* () {
      const accountId = yield* Account;
      const dotAlchemy = yield* DotAlchemy;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const createContainerApplication =
        yield* Containers.createContainerApplication;
      const updateContainerApplication =
        yield* Containers.updateContainerApplication;
      const deleteContainerApplication =
        yield* Containers.deleteContainerApplication;
      const getContainerApplication = yield* Containers.getContainerApplication;
      const listContainerApplications =
        yield* Containers.listContainerApplications;
      const createContainerRegistryCredentials =
        yield* Containers.createContainerRegistryCredentials;
      const createContainerApplicationRollout =
        yield* Containers.createContainerApplicationRollout;

      const createApplicationName = (id: string, name: string | undefined) =>
        Effect.gen(function* () {
          return (
            name ??
            (yield* createPhysicalName({
              id,
              lowercase: true,
            }))
          );
        });

      const findApplicationByName = Effect.fnUntraced(function* (name: string) {
        return yield* listContainerApplications({ accountId }).pipe(
          Effect.map((apps) => apps.find((app) => app.name === name)),
        );
      });

      const findApplicationByNamespace = Effect.fnUntraced(function* (
        namespaceId: string,
      ) {
        return yield* listContainerApplications({ accountId }).pipe(
          Effect.map((apps) =>
            apps.find((app) => app.durableObjects?.namespaceId === namespaceId),
          ),
        );
      });

      const desiredConfiguration = Effect.fnUntraced(function* (
        id: string,
        props: ContainerApplicationProps,
      ) {
        const image = yield* resolveImageReference(id, props);
        return normalizeNulls({
          image,
          instanceType: props.instanceType,
          observability: props.observability,
          sshPublicKeyIds: props.sshPublicKeyIds,
          secrets: props.secrets,
          vcpu: props.vcpu,
          memory: props.memory,
          disk: props.disk,
          environmentVariables: props.environmentVariables,
          labels: props.labels,
          network: props.network,
          command: props.command,
          entrypoint: props.entrypoint,
          dns: props.dns,
          ports: props.ports,
          checks: props.checks,
        }) as Configuration;
      });

      const resolveImageReference = Effect.fnUntraced(function* (
        id: string,
        props: ContainerApplicationProps,
      ) {
        const main = props.main;
        if (!main) {
          return yield* Effect.fail(
            new Error("Container requires a `main` entrypoint."),
          );
        }
        const name = yield* createApplicationName(id, props.name);
        const repositoryName = name.toLowerCase();
        const registryId = props.registryId ?? "registry.cloudflare.com";
        const runtime = props.runtime ?? "bun";
        const mainContent = yield* fs.readFileString(main).pipe(
          Effect.catchIf(
            () => true,
            () => Effect.succeed(""),
          ),
        );
        const hash = (yield* sha256Object({
          dockerfile: props.dockerfile ?? "",
          main: mainContent,
          runtime,
        })).slice(0, 16);
        return `${registryId}/${accountId}/${repositoryName}:${hash}`;
      });

      const bundleProgram = (id: string, main: string) =>
        bundle({
          id,
          main,
          entryContent: (importPath) =>
            `export { default } from "${importPath}";\n`,
          build: {
            format: "esm",
            platform: "node",
            target: "node22",
            sourcemap: false,
            treeshake: true,
            minify: true,
            external: [],
          },
        });

      const buildFinalDockerfile = (
        userDockerfile: string | undefined,
        runtime: "bun" | "node",
      ): string => {
        const base =
          userDockerfile?.trim() ??
          `FROM ${runtime === "bun" ? "oven/bun:1" : "node:22-slim"}`;
        const runtimeImage = runtime === "bun" ? "oven/bun:1" : "node:22-slim";
        const runtimeBin = runtime === "bun" ? "bun" : "node";
        const binPath =
          runtime === "bun" ? "/usr/local/bin/bun" : "/usr/local/bin/node";
        return [
          base,
          "",
          `COPY --from=${runtimeImage} ${binPath} ${binPath}`,
          "WORKDIR /app",
          "COPY index.mjs /app/index.mjs",
          `ENTRYPOINT ["${runtimeBin}", "/app/index.mjs"]`,
          "",
        ].join("\n");
      };

      const ensureImageAvailable = Effect.fnUntraced(function* (
        id: string,
        props: ContainerApplicationProps,
        session?: { note: (message: string) => Effect.Effect<void> },
      ) {
        const main = props.main;
        if (!main) {
          return yield* Effect.fail(
            new Error("Container requires a `main` entrypoint."),
          );
        }
        const runtime = props.runtime ?? "bun";
        const imageRef = yield* resolveImageReference(id, props);

        yield* Effect.logInfo(
          `Cloudflare Container image: building ${imageRef}`,
        );
        if (session) {
          yield* session.note(`Building container image ${imageRef}...`);
        }

        const { code } = yield* bundleProgram(id, main);

        const registryId = props.registryId ?? "registry.cloudflare.com";
        const finalDockerfile = buildFinalDockerfile(props.dockerfile, runtime);

        const credentials = yield* createContainerRegistryCredentials({
          accountId,
          registryId,
          permissions: ["pull", "push"],
          expirationMinutes: 60,
        });
        const username = credentials.username ?? (credentials as any).user;
        if (!username) {
          return yield* Effect.fail(
            new Error(
              "Cloudflare registry credentials did not include a username.",
            ),
          );
        }

        const tempDir = yield* createTempBundleDir(
          process.cwd(),
          dotAlchemy,
          `${id}-container`,
        );

        return yield* Effect.gen(function* () {
          yield* writeDockerContext({
            directory: tempDir,
            dockerfile: finalDockerfile,
            files: [{ path: "index.mjs", content: code }],
          });

          yield* runDockerCommand([
            "build",
            "--platform",
            "linux/amd64",
            "-t",
            imageRef,
            tempDir,
          ]);

          yield* pushImageViaDockerApi(imageRef, {
            username,
            password: credentials.password,
            serverAddress: registryId,
          });

          return imageRef;
        }).pipe(Effect.ensuring(cleanupBundleTempDir(tempDir)));
      });

      const maybeCreateRollout = Effect.fnUntraced(function* ({
        applicationId,
        configuration,
        rollout,
      }: {
        applicationId: string;
        configuration: Configuration;
        rollout: Rollout | undefined;
      }) {
        const strategy = rollout?.strategy ?? "rolling";
        const stepPercentage =
          strategy === "immediate" ? 100 : (rollout?.stepPercentage ?? 25);

        yield* createContainerApplicationRollout({
          accountId,
          applicationId,
          description:
            strategy === "immediate"
              ? "Immediate update"
              : "Progressive update",
          strategy: "rolling",
          kind: rollout?.kind ?? "full_auto",
          stepPercentage,
          targetConfiguration: configuration,
        });
      });

      const createApplication = Effect.fnUntraced(function* ({
        id,
        news,
        name,
        configuration,
        durableObjects,
        session,
      }: {
        id: string;
        news: ContainerApplicationProps;
        name: string;
        configuration: Configuration;
        durableObjects: ContainerApplicationProps["durableObjects"];
        session: { note: (message: string) => Effect.Effect<void> };
      }) {
        const describeError = (error: unknown) => {
          if (error instanceof Error) {
            return JSON.stringify(
              Object.fromEntries(
                Object.getOwnPropertyNames(error).map((key) => [
                  key,
                  (error as unknown as Record<string, unknown>)[key],
                ]),
              ),
              null,
              2,
            );
          }
          return String(error);
        };

        const adopt = news.adopt ?? false;
        const existingByName = adopt
          ? yield* findApplicationByName(name)
          : undefined;

        if (existingByName) {
          yield* Effect.logInfo(
            `Cloudflare Container create: adopting existing application ${name}`,
          );
          return yield* upsertApplication({
            id,
            news,
            existing: toAttributes(existingByName),
            session,
          });
        }

        yield* Effect.logInfo(
          `Cloudflare Container create: creating application ${name}`,
        );
        yield* session.note(`Creating container application ${name}...`);
        const adoptExistingByName = Effect.gen(function* () {
          yield* Effect.logInfo(
            `Cloudflare Container create: application ${name} already exists, adopting`,
          );
          const existing = yield* findApplicationByName(name);
          if (!existing) {
            return yield* Effect.fail(
              new Error(
                `Container application "${name}" already exists but could not be found for adoption.`,
              ),
            );
          }
          return yield* upsertApplication({
            id,
            news,
            existing: toAttributes(existing),
            session,
          });
        });

        const application = yield* createContainerApplication({
          accountId,
          name,
          instances: news.instances ?? 1,
          maxInstances: news.maxInstances ?? 1,
          schedulingPolicy: news.schedulingPolicy ?? "default",
          constraints: news.constraints ?? {},
          affinities: news.affinities,
          configuration,
          durableObjects,
        }).pipe(
          Effect.catchTag("DurableObjectAlreadyHasApplication", () =>
            adopt && durableObjects
              ? Effect.gen(function* () {
                  const existing = yield* findApplicationByNamespace(
                    durableObjects.namespaceId,
                  );
                  if (!existing) {
                    return yield* Effect.fail(
                      new Error(
                        `Container application for Durable Object namespace "${durableObjects.namespaceId}" already exists but could not be found for adoption.`,
                      ),
                    );
                  }
                  if (existing.name !== name) {
                    return yield* Effect.fail(
                      new Error(
                        `Existing container application "${existing.name}" is already attached to Durable Object namespace "${durableObjects.namespaceId}". Use that application name to adopt it.`,
                      ),
                    );
                  }
                  return yield* upsertApplication({
                    id,
                    news,
                    existing: toAttributes(existing),
                    session,
                  });
                })
              : Effect.fail(
                  new Error(
                    `Durable Object namespace "${durableObjects?.namespaceId ?? "unknown"}" already has a container application. Use \`adopt: true\` to adopt it.`,
                  ),
                ),
          ),
          Effect.catchIf(
            (e) =>
              "message" in (e as any) &&
              String((e as any).message).includes("already exists"),
            () => adoptExistingByName,
          ),
          Effect.tapError((error) =>
            Effect.logError(
              `Cloudflare Container create error: ${describeError(error)}`,
            ),
          ),
        );

        return "applicationId" in application
          ? application
          : toAttributes(application);
      });

      const upsertApplication = Effect.fnUntraced(function* ({
        id,
        news,
        existing,
        session,
      }: {
        id: string;
        news: ContainerApplicationProps;
        existing: ContainerApplication["Attributes"];
        session: { note: (message: string) => Effect.Effect<void> };
      }) {
        yield* Effect.logInfo(
          `Cloudflare Container update: preparing ${existing.applicationName}`,
        );
        const configuration = yield* desiredConfiguration(id, news);
        if (
          stableStringify(existing.configuration) !==
          stableStringify(configuration)
        ) {
          yield* ensureImageAvailable(id, news, session);
        }
        yield* session.note(
          `Updating container application ${existing.applicationName}...`,
        );
        const application = yield* updateContainerApplication({
          accountId,
          applicationId: existing.applicationId,
          instances: news.instances ?? 1,
          maxInstances: news.maxInstances ?? 1,
          schedulingPolicy: news.schedulingPolicy ?? "default",
          constraints: news.constraints ?? {},
          affinities: news.affinities,
          configuration,
        });
        const updated = toAttributes(application);
        if (
          stableStringify(existing.configuration) !==
          stableStringify(updated.configuration)
        ) {
          yield* Effect.logInfo(
            `Cloudflare Container update: creating rollout for ${updated.applicationName}`,
          );
          yield* maybeCreateRollout({
            applicationId: updated.applicationId,
            configuration: updated.configuration,
            rollout: news.rollout,
          });
        }
        return updated;
      });

      return ContainerApplication.provider.of({
        stables: ["applicationId", "accountId"],
        diff: Effect.fnUntraced(function* ({
          id,
          olds = {},
          news = {},
          output,
        }) {
          const name = yield* createApplicationName(id, news.name);
          const oldName = output?.applicationName
            ? output.applicationName
            : yield* createApplicationName(id, olds.name);

          if (
            (output?.accountId ?? accountId) !== accountId ||
            name !== oldName
          ) {
            return { action: "replace" } as const;
          }

          const durableObjects = news.durableObjects;
          const oldDurableObjects =
            output?.durableObjects ?? olds.durableObjects;
          if (
            stableStringify(durableObjects) !==
            stableStringify(oldDurableObjects)
          ) {
            return { action: "replace" } as const;
          }

          if (!output) {
            return undefined;
          }

          const configuration = yield* desiredConfiguration(id, news);
          if (
            output.instances !== (news.instances ?? 1) ||
            output.maxInstances !== (news.maxInstances ?? 1) ||
            output.schedulingPolicy !== (news.schedulingPolicy ?? "default") ||
            stableStringify(output.constraints) !==
              stableStringify(news.constraints) ||
            stableStringify(output.affinities) !==
              stableStringify(news.affinities) ||
            stableStringify(output.configuration) !==
              stableStringify(configuration)
          ) {
            return { action: "update" } as const;
          }
        }),
        precreate: Effect.fnUntraced(function* ({ id, news = {}, session }) {
          const name = yield* createApplicationName(id, news.name);
          yield* Effect.logInfo(
            `Cloudflare Container precreate: starting ${name}`,
          );

          const configuration = yield* desiredConfiguration(id, news);
          yield* ensureImageAvailable(id, news, session);

          // Precreate intentionally omits the Durable Object attachment so the
          // worker can bind to this application id and break the circular
          // dependency. The final create step recreates the application with the
          // resolved namespace when needed.
          return yield* createApplication({
            id,
            news,
            name,
            configuration,
            durableObjects: undefined,
            session: {
              ...session,
              note: (message) =>
                session.note(message.replace("Creating", "Pre-creating")),
            },
          });
        }),
        create: Effect.fnUntraced(function* ({
          id,
          news = {},
          output,
          session,
        }) {
          const name = yield* createApplicationName(id, news.name);
          const adopt = news.adopt ?? false;
          yield* Effect.logInfo(
            `Cloudflare Container create: starting ${name}${adopt ? " with adopt" : ""}`,
          );
          const durableObjects = news.durableObjects;
          const configuration = yield* desiredConfiguration(id, news);

          if (
            output &&
            !adopt &&
            stableStringify(output.durableObjects) !==
              stableStringify(durableObjects)
          ) {
            yield* Effect.logInfo(
              `Cloudflare Container create: recreating pre-created application ${name} with durable object binding`,
            );
            yield* session.note(
              `Recreating container application ${name} with durable object binding...`,
            );
            yield* deleteContainerApplication({
              accountId: output.accountId,
              applicationId: output.applicationId,
            }).pipe(
              Effect.catchTag(
                "ContainerApplicationNotFound",
                () => Effect.void,
              ),
            );
            if (
              stableStringify(output.configuration) !==
              stableStringify(configuration)
            ) {
              yield* ensureImageAvailable(id, news, session);
            }
            return yield* createApplication({
              id,
              news,
              name,
              configuration,
              durableObjects,
              session,
            });
          }

          if (output) {
            return yield* upsertApplication({
              id,
              news,
              existing: output,
              session,
            });
          }

          yield* ensureImageAvailable(id, news, session);

          return yield* createApplication({
            id,
            news,
            name,
            configuration,
            durableObjects,
            session,
          });
        }),
        update: Effect.fnUntraced(function* ({
          id,
          news = {},
          output,
          session,
        }) {
          yield* Effect.logInfo(
            `Cloudflare Container update: starting ${output.applicationName}`,
          );
          return yield* upsertApplication({
            id,
            news,
            existing: output,
            session,
          });
        }),
        delete: Effect.fnUntraced(function* ({ output }) {
          yield* Effect.logInfo(
            `Cloudflare Container delete: deleting ${output.applicationName}`,
          );
          yield* deleteContainerApplication({
            accountId: output.accountId,
            applicationId: output.applicationId,
          }).pipe(
            Effect.catchTag("ContainerApplicationNotFound", () => Effect.void),
          );
        }),
        read: Effect.fnUntraced(function* ({ id, olds, output }) {
          if (output?.applicationId) {
            yield* Effect.logInfo(
              `Cloudflare Container read: checking ${output.applicationName}`,
            );
            return yield* getContainerApplication({
              accountId: output.accountId,
              applicationId: output.applicationId,
            }).pipe(
              Effect.map(toAttributes),
              Effect.catchTag("ContainerApplicationNotFound", () =>
                Effect.succeed(undefined),
              ),
            );
          }

          const name = yield* createApplicationName(id, olds?.name);
          yield* Effect.logInfo(
            `Cloudflare Container read: looking up ${name}`,
          );
          const existing = yield* findApplicationByName(name);
          if (!existing) {
            yield* Effect.logInfo(
              `Cloudflare Container read: ${name} not found`,
            );
          }
          return existing ? toAttributes(existing) : undefined;
        }),
      });
    }),
  );

const toAttributes = (
  application:
    | Containers.CreateContainerApplicationResponse
    | Containers.UpdateContainerApplicationResponse
    | Containers.GetContainerApplicationResponse,
): ContainerApplication["Attributes"] => ({
  applicationId: application.id,
  applicationName: application.name,
  accountId: application.accountId,
  schedulingPolicy: application.schedulingPolicy,
  instances: application.instances,
  maxInstances: application.maxInstances,
  constraints: normalizeNulls(
    application.constraints as Constraints | undefined,
  ),
  affinities: normalizeNulls(application.affinities as Affinities | undefined),
  configuration: normalizeNulls(application.configuration as Configuration),
  durableObjects: normalizeNulls(application.durableObjects) as
    | { namespaceId: string }
    | undefined,
  createdAt: application.createdAt,
  version: application.version,
});
