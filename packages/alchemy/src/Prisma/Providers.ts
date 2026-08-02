import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import type { Scope } from "effect/Scope";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { AlchemyContext } from "../AlchemyContext.ts";
import { AuthProviders } from "../Auth/AuthProvider.ts";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { AlchemyProfile, ProfileLive } from "../Auth/Profile.ts";
import * as Provider from "../Provider.ts";
import type { ResourceClass, ResourceLike } from "../Resource.ts";
import { PlatformServices } from "../Util/PlatformServices.ts";
import { proxyChain } from "../Util/proxy-chain.ts";
import { PrismaAuth } from "./AuthProvider.ts";
import { App, AppProvider } from "./App.ts";
import { Branch, BranchProvider } from "./Branch.ts";
import {
  PrismaClient,
  PrismaClientLive,
  type PrismaManagementClient,
} from "./Client.ts";
import { Connection, ConnectionProvider } from "./Connection.ts";
import { Compute, ComputeDevProvider, ComputeProvider } from "./Compute.ts";
import { CustomDomain, CustomDomainProvider } from "./CustomDomain.ts";
import { Database, DatabaseProvider } from "./Database.ts";
import { Deployment, DeploymentProvider } from "./Deployment.ts";
import {
  EnvironmentVariable,
  EnvironmentVariableProvider,
} from "./EnvironmentVariable.ts";
import { deriveConnectionAttrs } from "./Internal/DatabaseSecrets.ts";
import {
  closePrismaDevDatabase,
  ensurePrismaDevDatabase,
} from "./PrismaDevDatabase.ts";
import {
  PrismaHttpClientLive,
  PrismaUploadClientLive,
} from "./Internal/HttpClient.ts";
import { fromProfile } from "./PrismaEnvironment.ts";
import { Project, ProjectProvider } from "./Project.ts";
import {
  SourceRepository,
  SourceRepositoryProvider,
} from "./SourceRepository.ts";

export { PrismaEnvironment } from "./PrismaEnvironment.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Prisma",
) {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Standalone operation helpers own a private auth registry because they run
 * outside a Stack. Credential resolution stays eager here so constructing
 * `managementApi()` preserves its existing fail-fast behavior.
 */
const standaloneManagementApiLayer = () =>
  PrismaClientLive.pipe(
    Layer.provideMerge(fromProfile()),
    Layer.provideMerge(PrismaAuth),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(AuthProviders, {}),
        // The Prisma-scoped upload client (node transport) rides the
        // providers' output so artifact uploads can reach it at op time.
        PrismaUploadClientLive,
        Layer.provide(ProfileLive, PlatformServices),
        Layer.provide(CredentialsStoreLive, PlatformServices),
      ),
    ),
    // Provide (NOT provideMerge) the node transport privately: it must serve
    // only the Prisma management client. Exposing it from `providers()` would
    // override the ambient HttpClient for every other provider in the stack —
    // Cloudflare Worker script uploads then go out via node:http, which
    // streams multipart bodies as `Transfer-Encoding: chunked`, and
    // api.cloudflare.com never answers chunked uploads.
    Layer.provide(PrismaHttpClientLive),
  );

/**
 * Stack provider discovery must register auth without requiring credentials.
 * The management client is resolved on its first API operation, after
 * `alchemy login` has had a chance to configure the registered Prisma auth
 * provider. The nested client layer shares the provider layer's lifetime.
 */
const stackManagementApiLayer = () =>
  Layer.effect(
    PrismaClient,
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const authProviders = yield* AuthProviders;
      const profile = yield* AlchemyProfile;
      const client = Layer.buildWithScope(
        PrismaClientLive.pipe(
          Layer.provideMerge(
            fromProfile().pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(AuthProviders, authProviders),
                  Layer.succeed(AlchemyProfile, profile),
                ),
              ),
            ),
          ),
          Layer.provide(PrismaHttpClientLive),
        ),
        scope,
      ).pipe(Effect.map((context) => Context.get(context, PrismaClient)));
      const cached = yield* Effect.cached(client);
      return proxyChain(cached) as PrismaManagementClient;
    }),
  ).pipe(
    Layer.provideMerge(PrismaAuth),
    Layer.provideMerge(
      Layer.mergeAll(
        // The Prisma-scoped upload client (node transport) rides the
        // providers' output so artifact uploads can reach it at op time.
        PrismaUploadClientLive,
        Layer.provide(ProfileLive, PlatformServices),
        Layer.provide(CredentialsStoreLive, PlatformServices),
      ),
    ),
  );

/**
 * Build a layer for Prisma Management API operation helpers.
 *
 * Use this when calling helpers like `Prisma.listProjects()` outside an
 * Alchemy stack or test. Inside a stack (or a `test.provider` body) deployed
 * with `Prisma.providers()`, the management client is already in context, so
 * operation helpers work without providing this layer. Note that in
 * `alchemy dev` mode the providers run against local dev implementations and
 * the management client is not available.
 *
 * @example
 * ```typescript
 * const projects = yield* Prisma.listProjects().pipe(
 *   Effect.provide(Prisma.managementApi()),
 * );
 * ```
 */
export const managementApi = () =>
  standaloneManagementApiLayer().pipe(Layer.orDie);

/**
 * Build a layer that registers all Prisma Management API resource providers,
 * the Prisma auth provider, resolved credentials, and an HTTP client.
 *
 * @example
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Prisma from "alchemy/Prisma";
 * import * as Effect from "effect/Effect";
 *
 * export default Alchemy.Stack(
 *   "MyStack",
 *   { providers: Prisma.providers(), state: Alchemy.localState() },
 *   Effect.gen(function* () {
 *     const project = yield* Prisma.Project("app", {
 *       name: "app",
 *       region: "us-east-1",
 *     });
 *     return { projectId: project.projectId };
 *   }),
 * );
 * ```
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      Project,
      Database,
      Connection,
      Branch,
      Compute,
      App,
      Deployment,
      CustomDomain,
      EnvironmentVariable,
      SourceRepository,
    ]),
  ).pipe(Layer.provideMerge(implementationLayer()));

const implementationLayer = () =>
  Layer.unwrap(
    AlchemyContext.pipe(
      Effect.map((ctx) => (ctx.dev ? devProviderLayer() : liveProviderLayer())),
    ),
  );

const devProviderLayer = () =>
  Layer.mergeAll(
    projectDevProvider(),
    databaseDevProvider(),
    connectionDevProvider(),
    branchDevProvider(),
    ComputeDevProvider(),
    appDevProvider(),
    deploymentDevProvider(),
    customDomainDevProvider(),
    environmentVariableDevProvider(),
    sourceRepositoryDevProvider(),
  );

type DevRecord = Record<string, unknown>;
type PrismaDevDatabaseRequirements = ChildProcessSpawner | Path.Path | Scope;

const isRecord = (value: unknown): value is DevRecord =>
  typeof value === "object" && value !== null;

const devProvider = <R extends ResourceLike>(
  resource: ResourceClass<R>,
  stables: Extract<keyof R["Attributes"], string>[],
  attrs: (input: {
    id: string;
    news: DevRecord;
    output?: DevRecord;
  }) => DevRecord,
) =>
  Provider.succeed(resource, {
    stables,
    list: () => Effect.succeed([]),
    diff: Effect.fn(function* () {
      return { action: "update" } as const;
    }),
    read: Effect.fn(function* ({ output }) {
      return output;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const newsRecord = isRecord(news) ? news : {};
      const outputRecord = isRecord(output) ? output : undefined;
      return {
        ...outputRecord,
        ...attrs({ id, news: newsRecord, output: outputRecord }),
      } as R["Attributes"];
    }),
    delete: Effect.fn(function* () {}),
  });

const DEV_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const devId = (type: string, id: string) => `dev:${type}:${id}`;
const attr = (value: unknown, key: string) =>
  isRecord(value) ? value[key] : undefined;
const attrOrString = (value: unknown, attr: string) =>
  typeof value === "string"
    ? value
    : isRecord(value) && typeof value[attr] === "string"
      ? value[attr]
      : undefined;
const attrOrNullableString = (value: unknown, key: string) => {
  const candidate = attr(value, key);
  return candidate === null || typeof candidate === "string"
    ? candidate
    : undefined;
};
const attrOrRedactedString = (value: unknown, key: string) => {
  const candidate = attr(value, key);
  return Redacted.isRedacted(candidate)
    ? Redacted.make(String(Redacted.value(candidate)))
    : typeof candidate === "string"
      ? Redacted.make(candidate)
      : undefined;
};

const projectDevProvider = () =>
  devProvider(Project, ["projectId"], ({ id, news }) => ({
    projectId: devId("project", id),
    projectName: news.name ?? id,
    workspaceId: devId("workspace", "local"),
    createdAt: DEV_TIMESTAMP,
    defaultRegion:
      news.createDatabase === false
        ? (news.region ?? null)
        : (news.region ?? "us-east-1"),
    databaseId:
      news.createDatabase === false ? undefined : devId("database", id),
    defaultConnectionId:
      news.createDatabase === false ? undefined : devId("connection", id),
    directConnectionString: undefined,
    pooledConnectionString: undefined,
    accelerateConnectionString: undefined,
    host: undefined,
    user: undefined,
    password: undefined,
  }));

const databaseDevProvider = () =>
  Provider.succeed<
    Database,
    never,
    never,
    never,
    PrismaDevDatabaseRequirements
  >(Database, {
    stables: ["databaseId"],
    list: () => Effect.succeed([]),
    diff: Effect.fn(function* () {
      return { action: "update" } as const;
    }),
    read: Effect.fn(function* ({ output }) {
      return output;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const databaseId = output?.databaseId ?? devId("database", id);
      const local = yield* ensurePrismaDevDatabase(databaseId, news.dev);
      return {
        databaseId,
        databaseName: news.name ?? id,
        projectId:
          attrOrString(news.project, "projectId") ?? devId("project", id),
        status: "ready",
        region: news.region ?? "us-east-1",
        isDefault: news.isDefault ?? false,
        branchId: news.branchId ?? null,
        defaultConnectionId: devId("connection", id),
        createdAt: output?.createdAt ?? DEV_TIMESTAMP,
        directConnectionString: local?.directConnectionString,
        pooledConnectionString: local?.pooledConnectionString,
        accelerateConnectionString: local?.accelerateConnectionString,
        host: local?.host,
        user: local?.user,
        password: local?.password,
      } satisfies Database["Attributes"];
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* closePrismaDevDatabase(output.databaseId);
    }),
  });

const connectionDevProvider = () =>
  devProvider(Connection, ["connectionId"], ({ id, news }) => {
    const secrets = {
      directConnectionString: attrOrRedactedString(
        news.database,
        "directConnectionString",
      ),
      pooledConnectionString: attrOrRedactedString(
        news.database,
        "pooledConnectionString",
      ),
      accelerateConnectionString: attrOrRedactedString(
        news.database,
        "accelerateConnectionString",
      ),
    };
    return {
      connectionId: devId("connection", id),
      connectionName: news.name ?? id,
      databaseId: attrOrString(news.database, "databaseId"),
      kind: "postgres",
      createdAt: DEV_TIMESTAMP,
      ...secrets,
      host: attrOrNullableString(news.database, "host"),
      user: attrOrNullableString(news.database, "user"),
      password: attrOrRedactedString(news.database, "password"),
      ...deriveConnectionAttrs(secrets),
    };
  });

const branchDevProvider = () =>
  devProvider(Branch, ["branchId"], ({ id, news }) => ({
    branchId: devId("branch", id),
    gitName: news.gitName ?? id,
    projectId: attrOrString(news.project, "projectId"),
    isDefault: news.isDefault ?? false,
    role: news.isDefault ? "production" : "preview",
    createdAt: DEV_TIMESTAMP,
    updatedAt: DEV_TIMESTAMP,
  }));

const appDevProvider = () =>
  devProvider(App, ["appId"], ({ id, news }) => ({
    appId: devId("app", id),
    name: news.displayName ?? id,
    projectId: attrOrString(news.project, "projectId"),
    regionId: news.regionId ?? "us-east-1",
    branchId: news.branchId ?? null,
    latestDeploymentId: null,
    appEndpointDomain: "localhost",
    createdAt: DEV_TIMESTAMP,
  }));

const deploymentDevProvider = () =>
  devProvider(Deployment, ["deploymentId"], ({ id, news }) => ({
    deploymentId: devId("deployment", id),
    appId: attrOrString(news.app, "appId"),
    foundryVersionId: devId("foundry-version", id),
    status: "new",
    previewDomain: undefined,
    artifactHash: undefined,
    appEndpointDomain: undefined,
    createdAt: DEV_TIMESTAMP,
  }));

const customDomainDevProvider = () =>
  devProvider(CustomDomain, ["customDomainId"], ({ id, news }) => ({
    customDomainId: devId("custom-domain", id),
    hostname: news.hostname,
    appId: attrOrString(news.app, "appId"),
    status: "active",
    foundryStatus: "active",
    failureReason: null,
    failureCategory: null,
    certExpiresAt: null,
    dnsRecords: [
      {
        type: "CNAME" as const,
        name: news.hostname,
        value: "localhost",
        ttl: null,
      },
    ],
    createdAt: DEV_TIMESTAMP,
    updatedAt: DEV_TIMESTAMP,
  }));

const environmentVariableDevProvider = () =>
  devProvider(
    EnvironmentVariable,
    ["environmentVariableId"],
    ({ id, news }) => ({
      environmentVariableId: devId("environment-variable", id),
      projectId: attrOrString(news.project, "projectId"),
      branchId: news.branchId ?? null,
      class: news.class,
      key: news.key,
      value: news.value,
      valueKid: devId("value-kid", id),
      isManagedBySystem: false,
      createdAt: DEV_TIMESTAMP,
      updatedAt: DEV_TIMESTAMP,
    }),
  );

const sourceRepositoryDevProvider = () =>
  devProvider(SourceRepository, ["sourceRepositoryId"], ({ id, news }) => ({
    sourceRepositoryId: devId("source-repository", id),
    projectId: attrOrString(news.project, "projectId"),
    repoId: news.providerRepositoryId,
    provider: news.provider ?? "github",
    repoFullName: `dev/${id}`,
    defaultBranch: "main",
    isPrivate: false,
    status: "active",
    installationId: devId("installation", id),
    createdAt: DEV_TIMESTAMP,
    updatedAt: DEV_TIMESTAMP,
  }));

const liveProviderLayer = () =>
  Layer.mergeAll(
    ProjectProvider(),
    DatabaseProvider(),
    ConnectionProvider(),
    BranchProvider(),
    ComputeProvider(),
    AppProvider(),
    DeploymentProvider(),
    CustomDomainProvider(),
    EnvironmentVariableProvider(),
    SourceRepositoryProvider(),
  ).pipe(Layer.provideMerge(stackManagementApiLayer()), Layer.orDie);
