import * as containers from "@distilled.cloud/cloudflare/containers";
import * as Effect from "effect/Effect";
import type { HttpServerError } from "effect/unstable/http/HttpServerError";
import type { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import type { HttpServerResponse } from "effect/unstable/http/HttpServerResponse";
import { runDockerCommand, writeDockerContext } from "../../Bundle/Docker.ts";
import {
  cleanupBundleTempDir,
  createTempBundleDir,
} from "../../Bundle/TempRoot.ts";
import { DotAlchemy } from "../../Config.ts";
import type { HttpEffect } from "../../Http.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import { Resource } from "../../Resource.ts";
import { sha256Object } from "../../Util/sha256.ts";
import { normalizeNulls, stableStringify } from "../../Util/stable.ts";
import { Account } from "../Account.ts";
import { DurableObjectNamespace } from "../Workers/DurableObject.ts";

export { Credentials } from "@distilled.cloud/cloudflare/Credentials";

const TypeId = "Cloudflare.Container";
type TypeId = typeof TypeId;

export const isContainer = <T>(value: T): value is T & Container =>
  typeof value === "object" &&
  value !== null &&
  "Type" in value &&
  value.Type === TypeId;

export type ContainerProps = {
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
   * Existing image reference to deploy.
   */
  image?: string;
  /**
   * Inline Dockerfile used to build and push an image to Cloudflare's managed
   * registry before creating or updating the application.
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
};

export interface Container extends Resource<
  TypeId,
  ContainerProps,
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
> {
  getInstance(id: string): Effect.Effect<{
    fetch: (
      request: HttpServerRequest,
    ) => Effect.Effect<HttpServerResponse, HttpServerError>;
  }>;
}

const ContainerResource = Resource<Container>(TypeId);

export const Container = Effect.fnUntraced(function* <
  InfraReq = never,
  RuntimeReq = never,
>(
  id: string,
  props: {
    [prop in keyof ContainerProps]: Input<ContainerProps[prop]>;
  },
  impl: Effect.Effect<HttpEffect<RuntimeReq>, never, InfraReq>,
) {
  const namespace = yield* DurableObjectNamespace(
    id,
    Effect.gen(function* () {
      return Effect.gen(function* () {
        // return yield* impl;
      });
    }),
  );

  const resource = yield* ContainerResource(id, {
    ...props,
    durableObjects:
      props.durableObjects ??
      ({
        namespaceId: namespace.namespaceId,
      } as const),
  });
  // TODO(sam): register this in the Container Execution Context
  const handler = yield* impl;

  return Object.assign(resource, {
    fetch: (request: HttpServerRequest) => handler(request),
  }) as Container;
});

export type InstanceType = NonNullable<
  containers.CreateContainerApplicationRequest["configuration"]["instanceType"]
>;
export type SchedulingPolicy = NonNullable<
  containers.CreateContainerApplicationRequest["schedulingPolicy"]
>;
export type Observability = NonNullable<
  containers.CreateContainerApplicationRequest["configuration"]["observability"]
>;
export type Secret = NonNullable<
  containers.CreateContainerApplicationRequest["configuration"]["secrets"]
>[number];
export type Disk = NonNullable<
  containers.CreateContainerApplicationRequest["configuration"]["disk"]
>;
export type EnvironmentVariable = NonNullable<
  containers.CreateContainerApplicationRequest["configuration"]["environmentVariables"]
>[number];
export type Label = NonNullable<
  containers.CreateContainerApplicationRequest["configuration"]["labels"]
>[number];
export type Network = NonNullable<
  containers.CreateContainerApplicationRequest["configuration"]["network"]
>;
export type Dns = NonNullable<
  containers.CreateContainerApplicationRequest["configuration"]["dns"]
>;
export type Port = NonNullable<
  containers.CreateContainerApplicationRequest["configuration"]["ports"]
>[number];
export type Check = NonNullable<
  containers.CreateContainerApplicationRequest["configuration"]["checks"]
>[number];
export type Constraints = {
  tier?: number;
};
export type Affinities = {
  colocation?: "datacenter";
};
export type Configuration =
  containers.CreateContainerApplicationRequest["configuration"];
export interface Rollout {
  strategy?: "rolling" | "immediate";
  kind?: "full_auto";
  stepPercentage?: number;
}

const toAttributes = (
  application:
    | containers.CreateContainerApplicationResponse
    | containers.UpdateContainerApplicationResponse
    | containers.GetContainerApplicationResponse,
): Container["Attributes"] => ({
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

export const ContainerProvider = () =>
  ContainerResource.provider.effect(
    Effect.gen(function* () {
      const accountId = yield* Account;
      const dotAlchemy = yield* DotAlchemy;
      const createContainerApplication =
        yield* containers.createContainerApplication;
      const updateContainerApplication =
        yield* containers.updateContainerApplication;
      const deleteContainerApplication =
        yield* containers.deleteContainerApplication;
      const getContainerApplication = yield* containers.getContainerApplication;
      const listContainerApplications =
        yield* containers.listContainerApplications;
      const createContainerRegistryCredentials =
        yield* containers.createContainerRegistryCredentials;
      const createContainerApplicationRollout =
        yield* containers.createContainerApplicationRollout;

      const createApplicationName = (id: string, name: string | undefined) =>
        Effect.gen(function* () {
          return name ?? (yield* createPhysicalName({ id }));
        });

      const findApplicationByName = Effect.fnUntraced(function* (name: string) {
        const applications = yield* listContainerApplications({ accountId });
        return applications.find((application) => application.name === name);
      });

      const findApplicationByNamespace = Effect.fnUntraced(function* (
        namespaceId: string,
      ) {
        const applications = yield* listContainerApplications({ accountId });
        return applications.find(
          (application) =>
            application.durableObjects?.namespaceId === namespaceId,
        );
      });

      const desiredConfiguration = Effect.fnUntraced(function* (
        id: string,
        props: ContainerProps,
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
        props: ContainerProps,
      ) {
        if (props.image && props.dockerfile) {
          return yield* Effect.fail(
            new Error("Provide either `image` or `dockerfile`, not both."),
          );
        }
        if (props.image) {
          return props.image;
        }
        if (props.dockerfile) {
          const name = yield* createApplicationName(id, props.name);
          const hash = (yield* sha256Object({
            dockerfile: props.dockerfile,
          })).slice(0, 16);
          const registryId = props.registryId ?? "registry.cloudflare.com";
          return `${registryId}/${accountId}/${name}:${hash}`;
        }
        return yield* Effect.fail(
          new Error("Container requires either an `image` or `dockerfile`."),
        );
      });

      const ensureImageAvailable = Effect.fnUntraced(function* (
        id: string,
        props: ContainerProps,
        session?: { note: (message: string) => Effect.Effect<void> },
      ) {
        if (!props.dockerfile) {
          return yield* resolveImageReference(id, props);
        }

        const imageRef = yield* resolveImageReference(id, props);
        const registryId = props.registryId ?? "registry.cloudflare.com";
        const credentials = yield* createContainerRegistryCredentials({
          accountId,
          registryId,
          permissions: ["pull", "push"],
          expirationMinutes: 60,
        });

        const password = credentials.username ?? credentials.user;
        if (!password) {
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
        yield* writeDockerContext({
          directory: tempDir,
          dockerfile: props.dockerfile,
          files: [],
        });

        if (session) {
          yield* session.note(`Building container image ${imageRef}...`);
        }

        return yield* Effect.gen(function* () {
          yield* runDockerCommand([
            "login",
            "-u",
            password,
            "-p",
            credentials.password,
            registryId,
          ]);
          yield* runDockerCommand(["build", "-t", imageRef, tempDir]);
          yield* runDockerCommand(["push", imageRef]);
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

      const upsertApplication = Effect.fnUntraced(function* ({
        id,
        news,
        existing,
        session,
      }: {
        id: string;
        news: ContainerProps;
        existing: Container["Attributes"];
        session: { note: (message: string) => Effect.Effect<void> };
      }) {
        const configuration = yield* desiredConfiguration(id, news);
        if (news.dockerfile) {
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
          constraints: news.constraints,
          affinities: news.affinities,
          configuration,
        });
        const updated = toAttributes(application);
        if (
          stableStringify(existing.configuration) !==
          stableStringify(updated.configuration)
        ) {
          yield* maybeCreateRollout({
            applicationId: updated.applicationId,
            configuration: updated.configuration,
            rollout: news.rollout,
          });
        }
        return updated;
      });

      return ContainerResource.provider.of({
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
        create: Effect.fnUntraced(function* ({ id, news = {}, session }) {
          const name = yield* createApplicationName(id, news.name);
          const adopt = news.adopt ?? false;
          const durableObjects = news.durableObjects;
          const existingByName = adopt
            ? yield* findApplicationByName(name)
            : undefined;

          if (existingByName) {
            return yield* upsertApplication({
              id,
              news,
              existing: toAttributes(existingByName),
              session,
            });
          }

          const configuration = yield* desiredConfiguration(id, news);
          if (news.dockerfile) {
            yield* ensureImageAvailable(id, news, session);
          }

          yield* session.note(`Creating container application ${name}...`);
          const application = yield* createContainerApplication({
            accountId,
            name,
            instances: news.instances ?? 1,
            maxInstances: news.maxInstances ?? 1,
            schedulingPolicy: news.schedulingPolicy ?? "default",
            constraints: news.constraints,
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
          );
          return "applicationId" in application
            ? application
            : toAttributes(application);
        }),
        update: Effect.fnUntraced(function* ({
          id,
          news = {},
          output,
          session,
        }) {
          return yield* upsertApplication({
            id,
            news,
            existing: output,
            session,
          });
        }),
        delete: Effect.fnUntraced(function* ({ output }) {
          yield* deleteContainerApplication({
            accountId: output.accountId,
            applicationId: output.applicationId,
          }).pipe(
            Effect.catchTag("ContainerApplicationNotFound", () => Effect.void),
          );
        }),
        read: Effect.fnUntraced(function* ({ id, olds, output }) {
          if (output?.applicationId) {
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
          const existing = yield* findApplicationByName(name);
          return existing ? toAttributes(existing) : undefined;
        }),
      });
    }),
  );
