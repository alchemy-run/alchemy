import { Retry as RailwayRetry } from "@distilled.cloud/railway";
import type {
  Builder,
  DeploymentTriggersResponseEdgesItemNode,
  ProjectResponseServicesEdgesItemNode,
  RestartPolicyType,
  ServiceCreateResponse,
  ServiceInstanceResponse,
  ServiceInstanceUpdateInput,
  ServiceResponse,
  ServiceUpdateResponse,
} from "@distilled.cloud/railway";
import * as railway from "@distilled.cloud/railway";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { AlchemyContext } from "../AlchemyContext.ts";
import { Unowned } from "../AdoptPolicy.ts";
import * as Bundle from "../Bundle/Bundle.ts";
import { deepEqual, isResolved } from "../Diff.ts";
import { DockerLive, Docker } from "../Docker/Docker.ts";
import { Platform, type Main, type PlatformProps } from "../Platform.ts";
import * as Provider from "../Provider.ts";
import type { Resource } from "../Resource.ts";
import type { ServerHost } from "../Server/Process.ts";
import { Stack } from "../Stack.ts";
import { createRailwayName, matchesAlchemyPhysicalName } from "./Metadata.ts";
import type { MountSpec, ServiceBinding } from "./MountVolume.ts";
import { listOwnedProjects, type Project } from "./Project.ts";
import type { Providers } from "./Providers.ts";
import {
  ensureServiceDomain,
  type ServiceDomainRecord,
} from "./ServiceDomain.ts";
import {
  collectBindingState,
  createRailwayHostedSupport,
  createRailwayHostRuntimeContext,
  DEFAULT_PORT,
  toEnvRecord,
  type RailwayBuildOptions,
  type RailwayHostRuntimeContext,
} from "./hosted.ts";

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* Project(...)` and `Project(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

export type { RailwayBuildOptions };

/**
 * Environment identity a Service is deployed into. Accepts a
 * `Railway.Project` (its primary environment), a `Railway.Environment`,
 * or an `{ environmentId }` stub.
 */
export type ServiceEnvironment = {
  readonly environmentId: string;
};

export interface ServiceProps extends PlatformProps {
  /**
   * Parent Railway Project. Accepts a `Railway.Project` or an Effect
   * that produces one. Changing the Project replaces the Service.
   */
  project: Ref<Project>;
  /**
   * Environment to deploy the service instance into. Accepts a
   * `Railway.Project` (primary environment), a `Railway.Environment`, or
   * `{ environmentId }`. Defaults to the project's primary environment.
   * Changing it replaces the Service.
   */
  environment?: Ref<ServiceEnvironment>;
  /**
   * Module entrypoint bundled with rolldown and baked into a Docker
   * image pushed to {@link registry}. Typically `import.meta.url`.
   * Mutually exclusive with the public-image path (`image` without
   * `main`). A content-hash change updates the Service in place.
   */
  main?: string;
  /**
   * Docker image Railway should run.
   *
   * When `main` is omitted this is `source.image` (e.g.
   * `hashicorp/http-echo`). When `main` is set this is the generated
   * Dockerfile's `FROM` (default `oven/bun:1`).
   */
  image?: string;
  /**
   * Region for the service instance (`us-west2`, `us-east4`, …). If
   * omitted, Railway picks the default. Updates in place.
   */
  region?: string;
  /**
   * Port the process listens on. Written to `PORT` and used as the
   * generated `*.up.railway.app` `targetPort`. Default is `3000` for
   * Effect-native (`main`) Services. Pass `5678` for
   * `hashicorp/http-echo`.
   */
  port?: number;
  /**
   * Additional environment variables. Merged after binding-injected
   * `env`. Upserted as service-scoped Railway variables with
   * `skipDeploys: true`; this Service owns the subsequent deploy.
   */
  env?: Record<string, any>;
  /**
   * Bundler configuration for `main`: rolldown `input`/`output`
   * overrides, plus `install` for packages that must ship as real
   * `node_modules` (see {@link RailwayBuildOptions}).
   */
  build?: RailwayBuildOptions;
  /**
   * Registry prefix to push Effect-native images to (`ghcr.io/org`,
   * `docker.io/user`). Required when `main` is set. Railway pulls
   * `source.image` from this registry.
   */
  registry?: string;
  /**
   * Named export to load from `main`.
   *
   * @default "default"
   */
  handler?: string;
  /**
   * Service name. Unique per Project. If omitted, a unique name is
   * generated from the stack, stage and logical ID. Changing it updates
   * in place via `serviceUpdate`.
   */
  name?: string;
  /**
   * GitHub repository (`owner/repo`). Creates/syncs
   * `serviceCreate.source.repo` / `serviceInstanceUpdate.source.repo`.
   * Mutually exclusive with the public-image and `main` paths. Requires a
   * GitHub connection on the Railway account.
   */
  repo?: string;
  /**
   * GitHub branch for {@link repo}. Passed as `serviceCreate.branch` and
   * synced onto the deployment trigger.
   */
  branch?: string;
  /**
   * Monorepo subdirectory Railway builds from (`rootDirectory`).
   */
  rootDirectory?: string;
  /**
   * Build command (`pnpm build`). Distinct from hosted
   * {@link RailwayBuildOptions} (`build.install`).
   */
  buildCommand?: string;
  /**
   * Start command (`pnpm start`).
   */
  startCommand?: string;
  /**
   * HTTP healthcheck path (`/health`). Synced via
   * `serviceInstanceUpdate.healthcheckPath`. Alias of {@link healthcheck}
   * (Railway IaC `healthcheck: "/health"`).
   */
  healthcheckPath?: string;
  /**
   * HTTP healthcheck path. Same as {@link healthcheckPath}; matches
   * Railway IaC `healthcheck`.
   */
  healthcheck?: string;
  /**
   * Healthcheck timeout in seconds.
   */
  healthcheckTimeout?: number;
  /**
   * Replica count (`numReplicas`) or per-region map
   * (`multiRegionConfig`). A number scales the current region; a map
   * places replicas (`{ "us-west2": 2, "europe-west4": 1 }`).
   */
  replicas?: number | Record<string, number>;
  /**
   * Cron expression (`cronSchedule`). Observed as `cronSchedule` /
   * `nextCronRunAt`.
   */
  cronSchedule?: string;
  /**
   * Restart policy (`ALWAYS`, `NEVER`, `ON_FAILURE`).
   */
  restartPolicyType?: RestartPolicyType;
  /**
   * Max retries when {@link restartPolicyType} is `ON_FAILURE`.
   */
  restartPolicyMaxRetries?: number;
  /**
   * Drain window in seconds before a replica is stopped.
   */
  drainingSeconds?: number;
  /**
   * Overlap window in seconds while a new replica starts.
   */
  overlapSeconds?: number;
  /**
   * Sleep the application when idle.
   */
  sleepApplication?: boolean;
  /**
   * Auto-deploy on new commits / image tags
   * (`serviceInstanceAutoDeployUpdate`).
   */
  autoUpdates?: boolean;
  /**
   * Dockerfile path relative to {@link rootDirectory}.
   */
  dockerfilePath?: string;
  /**
   * Builder (`RAILPACK`, `NIXPACKS`, `HEROKU`, `PAKETO`).
   */
  builder?: Builder;
  /**
   * Git watch patterns that trigger a rebuild.
   */
  watchPatterns?: string[];
}

export type Service = Resource<
  "Railway.Service",
  ServiceProps,
  {
    /** Railway service id. */
    serviceId: string;
    /** Physical service name (unique per project). */
    name: string;
    /** Parent Railway project id. */
    projectId: string;
    /** Environment the instance is deployed in. */
    environmentId: string;
    /** Observed `source.image`, if set. */
    image: string | undefined;
    /** Observed `source.repo` (`owner/repo`), if set. */
    repo: string | undefined;
    /** Observed healthcheck path. */
    healthcheckPath: string | undefined;
    /** Observed healthcheck timeout in seconds. */
    healthcheckTimeout: number | undefined;
    /** Observed replica count (`numReplicas`). */
    replicas: number | undefined;
    /** Observed build command. */
    buildCommand: string | undefined;
    /** Observed start command. */
    startCommand: string | undefined;
    /** Observed cron schedule. */
    cronSchedule: string | undefined;
    /** Observed root directory. */
    rootDirectory: string | undefined;
    /** Observed region, if Railway reported one. */
    region: string | undefined;
    /** Port published on the generated service domain. */
    port: number | undefined;
    /** Public `https://{domain}` URL (`*.up.railway.app`). */
    url: string | undefined;
    /** Generated Railway service domain hostname. */
    domain: string | undefined;
    /**
     * Internal DNS name on the default private mesh
     * (`{name}.railway.internal`). Derived from the service name — no
     * extra API call.
     */
    dnsName: string;
    /** Railway service domain id. */
    domainId: string | undefined;
    /** Latest deployment id, if one exists. */
    deploymentId: string | undefined;
    /** Latest deployment status (`SUCCESS`, `DEPLOYING`, …). */
    deploymentStatus: string | undefined;
    /** Content hash of the bundled program's image (empty for public images). */
    code: {
      hash: string;
    };
  },
  ServiceBinding,
  Providers
>;

export const isService = (value: unknown): value is Service =>
  typeof value === "object" &&
  value !== null &&
  (value as { Type?: string }).Type === "Railway.Service";

export type ServiceServices = ServerHost;

export type ServiceShape = Main<ServiceServices>;

export type ServiceRuntimeContext = RailwayHostRuntimeContext;

/**
 * A Railway.Service is a container in a Project. Point it at a public
 * image (`hashicorp/http-echo`) or an Effect program (`main` +
 * `registry`). Alchemy stamps the name, creates a `*.up.railway.app`
 * domain via `serviceDomainCreate`, and deploys with
 * `serviceInstanceDeployV2`.
 *
 * @resource
 * @see https://docs.railway.com/guides/services
 *
 * @section Image service
 * Pass `image` without `main`. Railway pulls the image and runs it.
 * `url` is the generated `*.up.railway.app` hostname.
 *
 * @example Public image
 * ```typescript
 * const site = yield* Railway.Project("Site");
 * const api = yield* Railway.Service("Api", {
 *   project: site,
 *   image: "hashicorp/http-echo",
 *   port: 5678,
 * });
 * ```
 *
 * :::caution[Changing `project` replaces the Service]
 * The Service is created in the new Project. The old Service is deleted.
 * :::
 *
 * @section Effect-native Service
 * A Service is a class. `main: import.meta.url` is the bundle
 * entrypoint. Alchemy bundles this file with Rolldown, builds a Docker
 * image (default `oven/bun:1`), pushes it to `registry`, and sets
 * `source.image`. `build.install: ["pg"]` ships `pg` unbundled.
 *
 * @example Class + Project + main
 * ```typescript
 * export default class Api extends Railway.Service<Api>()(
 *   "Api",
 *   {
 *     project: Site,
 *     main: import.meta.url,
 *     registry: "ghcr.io/acme",
 *     build: { install: ["pg"] },
 *   },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("hello")),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * @section The public URL
 * Yield the Service in the Stack. `api.url` is
 * `https://{name}.up.railway.app`.
 *
 * @example Stack output
 * ```typescript
 * export default Alchemy.Stack(
 *   "MyApp",
 *   { providers: Railway.providers(), state: Alchemy.localState() },
 *   Effect.gen(function* () {
 *     const api = yield* Api;
 *     return { url: api.url };
 *   }),
 * );
 * ```
 *
 * @section Pin a region
 * Omit `region` to use Railway's default. Updating it is in place.
 *
 * @example Region
 * ```typescript
 * const api = yield* Railway.Service("Api", {
 *   project: site,
 *   image: "hashicorp/http-echo",
 *   port: 5678,
 *   region: "us-west2",
 * });
 * ```
 *
 * @section Healthcheck and replicas
 * `healthcheckPath` (or `healthcheck`, matching Railway IaC) is the
 * HTTP path Railway probes. `replicas` is a count or a per-region map.
 *
 * @example Healthcheck and a single replica
 * ```typescript
 * const api = yield* Railway.Service("Api", {
 *   project: site,
 *   image: "hashicorp/http-echo",
 *   port: 5678,
 *   healthcheck: "/health",
 *   replicas: 1,
 * });
 * ```
 *
 * @example Per-region replicas
 * ```typescript
 * const api = yield* Railway.Service("Api", {
 *   project: site,
 *   image: "hashicorp/http-echo",
 *   port: 5678,
 *   replicas: { "us-west2": 2, "europe-west4": 1 },
 * });
 * ```
 *
 * @section GitHub source
 * `repo` + `branch` is the third source, next to `image` and `main`.
 * Railway must have GitHub connected to the account.
 *
 * @example GitHub repo
 * ```typescript
 * const api = yield* Railway.Service("Api", {
 *   project: site,
 *   repo: "acme/web",
 *   branch: "main",
 *   rootDirectory: "apps/api",
 *   buildCommand: "pnpm build",
 *   startCommand: "pnpm start",
 * });
 * ```
 *
 * @section Cron
 * `cronSchedule` runs the service on a cron expression.
 *
 * @example Cron schedule
 * ```typescript
 * const worker = yield* Railway.Service("Worker", {
 *   project: site,
 *   image: "hashicorp/http-echo",
 *   cronSchedule: "0 * * * *",
 * });
 * ```
 *
 * @section Mount a disk
 * Bind {@link MountVolume} inside init. Provide {@link MountVolumeLive}.
 *
 * @example Volume
 * ```typescript
 * export default class Api extends Railway.Service<Api>()(
 *   "Api",
 *   { project: Site, image: "hashicorp/http-echo", port: 5678 },
 *   Effect.gen(function* () {
 *     const disk = yield* Railway.MountVolume(Data, { path: "/data" });
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text(disk.path)),
 *     };
 *   }).pipe(Effect.provide(Railway.MountVolumeLive)),
 * ) {}
 * ```
 *
 * @section Module-scope declarations
 * Declare the Project once. Pass it into every child. Resource-valued
 * props accept the resource or an Effect producing it.
 *
 * @example Module-scope Service
 * ```typescript
 * // src/api.ts
 * import * as Railway from "alchemy/Railway";
 *
 * export const Site = Railway.Project("Site");
 * export const Api = Railway.Service("Api", {
 *   project: Site,
 *   image: "hashicorp/http-echo",
 *   port: 5678,
 * });
 * ```
 */
export const Service: Platform<
  Service,
  ServiceServices,
  ServiceShape,
  ServiceRuntimeContext
> = Platform("Railway.Service", {
  createRuntimeContext: createRailwayHostRuntimeContext("Railway.Service"),
  transformProps: (_id, props) =>
    Effect.gen(function* () {
      if (globalThis.__ALCHEMY_RUNTIME__) return props;
      const project = Effect.isEffect(props.project)
        ? yield* props.project as Effect.Effect<Project, never, Providers>
        : props.project;
      const environment =
        props.environment === undefined
          ? undefined
          : Effect.isEffect(props.environment)
            ? yield* props.environment as Effect.Effect<
                ServiceEnvironment,
                never,
                Providers
              >
            : props.environment;
      return { ...props, project, environment };
    }),
});

export class ServiceNotCreated extends Data.TaggedError(
  "Railway.ServiceNotCreated",
)<{
  name: string;
  projectId: string;
}> {}

export class ServiceProjectRequired extends Data.TaggedError(
  "Railway.ServiceProjectRequired",
)<{
  message: string;
}> {}

export class ServiceImageOrMainRequired extends Data.TaggedError(
  "Railway.ServiceImageOrMainRequired",
)<{
  message: string;
}> {}

export class ServiceDeployFailed extends Data.TaggedError(
  "Railway.ServiceDeployFailed",
)<{
  serviceId: string;
  status: string;
  deploymentId: string | undefined;
}> {}

class ServicePending extends Data.TaggedError("Railway.ServicePending")<{
  serviceId: string;
  status: string;
}> {}

class ServiceDeployPending extends Data.TaggedError(
  "Railway.ServiceDeployPending",
)<{
  serviceId: string;
  status: string;
}> {}

type CloudService =
  | ServiceResponse
  | ServiceCreateResponse
  | ServiceUpdateResponse
  | ProjectResponseServicesEdgesItemNode;

const projectIdOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { projectId?: unknown };
  return typeof rec.projectId === "string" && rec.projectId.length > 0
    ? rec.projectId
    : undefined;
};

const environmentIdOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { environmentId?: unknown };
  return typeof rec.environmentId === "string" && rec.environmentId.length > 0
    ? rec.environmentId
    : undefined;
};

const isGoneService = (service: CloudService | undefined) =>
  service === undefined || service.deletedAt != null;

const isGoneInstance = (instance: ServiceInstanceResponse | undefined) =>
  instance === undefined || instance.deletedAt != null;

const resolveName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    return yield* createRailwayName(id);
  });

const getById = (serviceId: string) =>
  railway.service({ id: serviceId }).pipe(
    Effect.map((service) => (isGoneService(service) ? undefined : service)),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed(undefined),
    ),
  );

const getInstance = (environmentId: string, serviceId: string) =>
  railway.serviceInstance({ environmentId, serviceId }).pipe(
    Effect.map((instance) => (isGoneInstance(instance) ? undefined : instance)),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed(undefined),
    ),
  );

const listProjectServices = (projectId: string) =>
  railway.project({ id: projectId }).pipe(
    Effect.map((project) =>
      project.services.edges
        .map((edge) => edge.node)
        .filter((node) => !isGoneService(node)),
    ),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed([] as ProjectResponseServicesEdgesItemNode[]),
    ),
  );

const findByName = (projectId: string, name: string) =>
  listProjectServices(projectId).pipe(
    Effect.map((services) => services.find((service) => service.name === name)),
  );

const alreadyExists = (message: string) =>
  /already exists|already in use|duplicate/i.test(message);

const sameImage = (observed: string | null | undefined, desired: string) => {
  if (observed == null || observed.length === 0) return false;
  if (observed === desired) return true;
  if (observed === `${desired}:latest` || desired === `${observed}:latest`) {
    return true;
  }
  return (
    observed.endsWith(`/${desired}`) || observed.endsWith(`/${desired}:latest`)
  );
};

const deployReady = (status: string | undefined) =>
  status === "SUCCESS" || status === "SLEEPING";

const deployFailed = (status: string | undefined) =>
  status === "FAILED" || status === "CRASHED" || status === "REMOVED";

const rateLimited = {
  while: (e: { _tag: string }) => e._tag === "RailwayRateLimited",
  schedule: Schedule.spaced("2 seconds"),
  times: 3 as const,
};

const undef = <T>(value: T | null | undefined): T | undefined =>
  value == null ? undefined : value;

const sameWatchPatterns = (
  observed: readonly string[] | null | undefined,
  desired: readonly string[] | undefined,
) => desired === undefined || deepEqual([...(observed ?? [])], [...desired]);

const replicaSum = (replicas: Record<string, number>) =>
  Object.values(replicas).reduce((sum, n) => sum + n, 0);

const toMultiRegionConfig = (replicas: Record<string, number>) => {
  const config: Record<string, { numReplicas: number }> = {};
  for (const [region, numReplicas] of Object.entries(replicas)) {
    config[region] = { numReplicas };
  }
  return config;
};

const assignIfChanged = <K extends keyof ServiceInstanceUpdateInput>(
  input: ServiceInstanceUpdateInput,
  key: K,
  desired: ServiceInstanceUpdateInput[K] | undefined,
  observed: unknown,
): boolean => {
  if (desired === undefined) return false;
  if (deepEqual(undef(observed as never), desired)) return false;
  input[key] = desired;
  return true;
};

const replicaDelta = (
  replicas: number | Record<string, number> | undefined,
  observedNum: number | null | undefined,
  previous: number | Record<string, number> | undefined,
): Pick<ServiceInstanceUpdateInput, "numReplicas" | "multiRegionConfig"> => {
  if (replicas === undefined) return {};
  if (typeof replicas === "number") {
    return observedNum === replicas ? {} : { numReplicas: replicas };
  }
  const numReplicas = replicaSum(replicas);
  const sameMap = previous !== undefined && deepEqual(previous, replicas);
  if (sameMap && observedNum === numReplicas) return {};
  return {
    numReplicas,
    multiRegionConfig: toMultiRegionConfig(replicas),
  };
};

const instanceSettingsDelta = (input: {
  instance: ServiceInstanceResponse | undefined;
  sourceImage: string | undefined;
  sourceRepo: string | undefined;
  registryCredentials: { username: string; password: string } | undefined;
  previousReplicas: number | Record<string, number> | undefined;
  props: {
    region?: string;
    rootDirectory?: string;
    buildCommand?: string;
    startCommand?: string;
    healthcheckPath?: string;
    healthcheckTimeout?: number;
    replicas?: number | Record<string, number>;
    cronSchedule?: string;
    restartPolicyType?: RestartPolicyType;
    restartPolicyMaxRetries?: number;
    drainingSeconds?: number;
    overlapSeconds?: number;
    sleepApplication?: boolean;
    dockerfilePath?: string;
    builder?: Builder;
    watchPatterns?: string[];
  };
}): ServiceInstanceUpdateInput | undefined => {
  const instance = input.instance;
  const delta: ServiceInstanceUpdateInput = {};
  let changed = false;

  if (input.sourceRepo !== undefined) {
    if (undef(instance?.source?.repo) !== input.sourceRepo) {
      delta.source = { repo: input.sourceRepo };
      changed = true;
    }
  } else if (
    input.sourceImage !== undefined &&
    !sameImage(instance?.source?.image, input.sourceImage)
  ) {
    delta.source = { image: input.sourceImage };
    changed = true;
  }

  if (input.registryCredentials !== undefined) {
    delta.registryCredentials = input.registryCredentials;
    changed = true;
  }

  changed =
    assignIfChanged(delta, "region", input.props.region, instance?.region) ||
    changed;
  changed =
    assignIfChanged(
      delta,
      "rootDirectory",
      input.props.rootDirectory,
      instance?.rootDirectory,
    ) || changed;
  changed =
    assignIfChanged(
      delta,
      "buildCommand",
      input.props.buildCommand,
      instance?.buildCommand,
    ) || changed;
  changed =
    assignIfChanged(
      delta,
      "startCommand",
      input.props.startCommand,
      instance?.startCommand,
    ) || changed;
  changed =
    assignIfChanged(
      delta,
      "healthcheckPath",
      input.props.healthcheckPath ?? input.props.healthcheck,
      instance?.healthcheckPath,
    ) || changed;
  changed =
    assignIfChanged(
      delta,
      "healthcheckTimeout",
      input.props.healthcheckTimeout,
      instance?.healthcheckTimeout,
    ) || changed;
  changed =
    assignIfChanged(
      delta,
      "cronSchedule",
      input.props.cronSchedule,
      instance?.cronSchedule,
    ) || changed;
  changed =
    assignIfChanged(
      delta,
      "restartPolicyType",
      input.props.restartPolicyType,
      instance?.restartPolicyType,
    ) || changed;
  changed =
    assignIfChanged(
      delta,
      "restartPolicyMaxRetries",
      input.props.restartPolicyMaxRetries,
      instance?.restartPolicyMaxRetries,
    ) || changed;
  changed =
    assignIfChanged(
      delta,
      "drainingSeconds",
      input.props.drainingSeconds,
      instance?.drainingSeconds,
    ) || changed;
  changed =
    assignIfChanged(
      delta,
      "overlapSeconds",
      input.props.overlapSeconds,
      instance?.overlapSeconds,
    ) || changed;
  changed =
    assignIfChanged(
      delta,
      "sleepApplication",
      input.props.sleepApplication,
      instance?.sleepApplication,
    ) || changed;
  changed =
    assignIfChanged(
      delta,
      "dockerfilePath",
      input.props.dockerfilePath,
      instance?.dockerfilePath,
    ) || changed;
  changed =
    assignIfChanged(delta, "builder", input.props.builder, instance?.builder) ||
    changed;

  const watchPatterns = input.props.watchPatterns;
  if (
    watchPatterns !== undefined &&
    !sameWatchPatterns(instance?.watchPatterns, watchPatterns)
  ) {
    delta.watchPatterns = watchPatterns;
    changed = true;
  }

  const replicas = replicaDelta(
    input.props.replicas,
    instance?.numReplicas,
    input.previousReplicas,
  );
  if (replicas.numReplicas !== undefined) {
    delta.numReplicas = replicas.numReplicas;
    changed = true;
  }
  if (replicas.multiRegionConfig !== undefined) {
    delta.multiRegionConfig = replicas.multiRegionConfig;
    changed = true;
  }

  return changed ? delta : undefined;
};

const listDeploymentTriggers = (
  projectId: string,
  environmentId: string,
  serviceId: string,
) =>
  railway.deploymentTriggers
    .items({
      projectId,
      environmentId,
      serviceId,
      first: 50,
    })
    .pipe(
      Stream.runCollect,
      Effect.map((triggers) => Array.from(triggers)),
      Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
        Effect.succeed([] as DeploymentTriggersResponseEdgesItemNode[]),
      ),
    );

const syncBranch = Effect.fn(function* (input: {
  projectId: string;
  environmentId: string;
  serviceId: string;
  repo: string;
  branch: string | undefined;
}) {
  if (input.branch === undefined) return false;
  const triggers = yield* listDeploymentTriggers(
    input.projectId,
    input.environmentId,
    input.serviceId,
  );
  const current = triggers[0];
  if (current === undefined) {
    yield* railway
      .deploymentTriggerCreate({
        input: {
          branch: input.branch,
          environmentId: input.environmentId,
          projectId: input.projectId,
          provider: "github",
          repository: input.repo,
          serviceId: input.serviceId,
        },
      })
      .pipe(RailwayRetry.none, Effect.retry(rateLimited));
    return true;
  }
  const branchChanged = current.branch !== input.branch;
  const repoChanged = current.repository !== input.repo;
  if (!branchChanged && !repoChanged) return false;
  yield* railway
    .deploymentTriggerUpdate({
      id: current.id,
      input: {
        ...(branchChanged ? { branch: input.branch } : {}),
        ...(repoChanged ? { repository: input.repo } : {}),
      },
    })
    .pipe(RailwayRetry.none, Effect.retry(rateLimited));
  return true;
});

const syncAutoUpdates = Effect.fn(function* (input: {
  projectId: string;
  environmentId: string;
  serviceId: string;
  enabled: boolean | undefined;
}) {
  if (input.enabled === undefined) return;
  const status = yield* railway
    .serviceInstanceAutoDeployStatus({
      environmentId: input.environmentId,
      projectId: input.projectId,
      serviceId: input.serviceId,
    })
    .pipe(
      Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
        Effect.succeed(undefined),
      ),
    );
  if (status?.enabled === input.enabled) return;
  yield* railway
    .serviceInstanceAutoDeployUpdate({
      input: {
        enabled: input.enabled,
        environmentId: input.environmentId,
        projectId: input.projectId,
        serviceId: input.serviceId,
      },
    })
    .pipe(RailwayRetry.none, Effect.retry(rateLimited));
});

const waitForInstance = (environmentId: string, serviceId: string) =>
  getInstance(environmentId, serviceId).pipe(
    Effect.flatMap((instance) => {
      if (instance === undefined) {
        return Effect.fail(
          new ServicePending({ serviceId, status: "creating" }),
        );
      }
      return Effect.succeed(instance);
    }),
    Effect.retry({
      while: (e) => e._tag === "Railway.ServicePending",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
    Effect.catchTag("Railway.ServicePending", () =>
      getInstance(environmentId, serviceId),
    ),
  );

const waitForDeployment = (environmentId: string, serviceId: string) =>
  getInstance(environmentId, serviceId).pipe(
    Effect.flatMap((instance) => {
      const latest = instance?.latestDeployment;
      const status = latest?.status;
      if (status !== undefined && deployFailed(status)) {
        return Effect.fail(
          new ServiceDeployFailed({
            serviceId,
            status,
            deploymentId: latest?.id,
          }),
        );
      }
      if (instance !== undefined && deployReady(status)) {
        return Effect.succeed(instance);
      }
      return Effect.fail(
        new ServiceDeployPending({
          serviceId,
          status: status ?? "pending",
        }),
      );
    }),
    Effect.retry({
      while: (e) => e._tag === "Railway.ServiceDeployPending",
      times: 10,
      schedule: Schedule.spaced("5 seconds"),
    }),
    Effect.catchTag("Railway.ServiceDeployPending", () =>
      getInstance(environmentId, serviceId),
    ),
  );

const upsertVariable = (input: {
  projectId: string;
  environmentId: string;
  serviceId: string;
  name: string;
  value: string;
}) =>
  railway
    .variableUpsert({
      input: {
        projectId: input.projectId,
        environmentId: input.environmentId,
        serviceId: input.serviceId,
        name: input.name,
        value: input.value,
        skipDeploys: true,
      },
    })
    .pipe(RailwayRetry.none, Effect.retry(rateLimited));

const asVariableMap = (value: unknown): Record<string, string> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      out[key] = item;
    }
  }
  return out;
};

const listVariableMap = (
  projectId: string,
  environmentId: string,
  serviceId: string,
) =>
  railway
    .variables({
      projectId,
      environmentId,
      serviceId,
      unrendered: true,
    })
    .pipe(
      Effect.map(asVariableMap),
      Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
        Effect.succeed({} as Record<string, string>),
      ),
    );

const syncEnv = Effect.fn(function* (input: {
  projectId: string;
  environmentId: string;
  serviceId: string;
  desired: Record<string, string>;
}) {
  if (Object.keys(input.desired).length === 0) return false;
  const observed = yield* listVariableMap(
    input.projectId,
    input.environmentId,
    input.serviceId,
  );
  let changed = false;
  for (const [name, value] of Object.entries(input.desired)) {
    if (observed[name] !== value) {
      yield* upsertVariable({
        projectId: input.projectId,
        environmentId: input.environmentId,
        serviceId: input.serviceId,
        name,
        value,
      });
      changed = true;
    }
  }
  return changed;
});

const syncMounts = Effect.fn(function* (input: {
  environmentId: string;
  serviceId: string;
  mounts: MountSpec[];
}) {
  for (const mount of input.mounts) {
    if (mount.volumeId.length === 0) continue;
    yield* railway
      .volumeInstanceUpdate({
        volumeId: mount.volumeId,
        environmentId: input.environmentId,
        input: {
          serviceId: input.serviceId,
          mountPath: mount.path,
        },
      })
      .pipe(
        RailwayRetry.none,
        Effect.retry(rateLimited),
        Effect.catchTag(["RailwayNotFound", "NotFound"], () => Effect.void),
      );
  }
});

const toAttrs = (input: {
  service: CloudService;
  instance: ServiceInstanceResponse | undefined;
  domain: ServiceDomainRecord | undefined;
  projectId: string;
  environmentId: string;
  port: number | undefined;
  codeHash: string;
}): Service["Attributes"] => ({
  serviceId: input.service.id,
  name: input.service.name,
  projectId: input.projectId,
  environmentId: input.environmentId,
  image: input.instance?.source?.image ?? undefined,
  repo: input.instance?.source?.repo ?? undefined,
  healthcheckPath: input.instance?.healthcheckPath ?? undefined,
  healthcheckTimeout: input.instance?.healthcheckTimeout ?? undefined,
  replicas: input.instance?.numReplicas ?? undefined,
  buildCommand: input.instance?.buildCommand ?? undefined,
  startCommand: input.instance?.startCommand ?? undefined,
  cronSchedule: input.instance?.cronSchedule ?? undefined,
  rootDirectory: input.instance?.rootDirectory ?? undefined,
  region: input.instance?.region ?? undefined,
  port: input.port,
  url: input.domain?.url,
  domain: input.domain?.domain,
  dnsName: `${input.service.name}.railway.internal`,
  domainId: input.domain?.id,
  deploymentId: input.instance?.latestDeployment?.id,
  deploymentStatus: input.instance?.latestDeployment?.status,
  code: { hash: input.codeHash },
});

export const ServiceProvider = () =>
  Provider.effect(
    Service,
    Effect.gen(function* () {
      const stack = yield* Stack;
      const docker = yield* Docker;
      const { dotAlchemy } = yield* AlchemyContext;
      const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;
      const hosted = createRailwayHostedSupport({
        stackName: stack.name,
        stage: stack.stage,
        virtualEntryPlugin,
        docker,
        dotAlchemy,
      });

      return Service.Provider.of({
        stables: ["serviceId", "projectId", "environmentId"],
        nuke: { dependsOn: ["Railway.Project"] },

        diff: Effect.fn(function* ({ id, news, output }) {
          if (news === undefined || !isResolved(news)) return undefined;
          if (output === undefined) return undefined;
          const nextProject = projectIdOf(news.project);
          const projectChanged =
            nextProject !== undefined && nextProject !== output.projectId;
          const nextEnv = environmentIdOf(news.environment);
          const environmentChanged =
            nextEnv !== undefined && nextEnv !== output.environmentId;
          if (projectChanged || environmentChanged) {
            return { action: "replace" as const };
          }
          if (news.main !== undefined && news.main.length > 0) {
            const hash = yield* hosted.hash({
              main: news.main,
              handler: news.handler,
              port: news.port,
              image: news.image,
              env: news.env,
              isExternal: news.isExternal,
              build: news.build,
              registry: news.registry,
            });
            if (hash !== output.code.hash) {
              return { action: "update" as const };
            }
          }
          return undefined;
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const projectId =
            output?.projectId ??
            (olds !== undefined ? projectIdOf(olds.project) : undefined);
          const environmentId =
            output?.environmentId ??
            (olds !== undefined
              ? (environmentIdOf(olds.environment) ??
                environmentIdOf(olds.project))
              : undefined);
          const name = yield* resolveName(id, olds?.name, output?.name);
          const byId =
            output?.serviceId !== undefined && output.serviceId.length > 0
              ? yield* getById(output.serviceId)
              : undefined;
          const found =
            byId ??
            (projectId !== undefined
              ? yield* findByName(projectId, name)
              : undefined);
          if (found === undefined) return undefined;
          const resolvedProjectId = projectIdOf(found) ?? projectId ?? "";
          const resolvedEnvId =
            environmentId ??
            environmentIdOf(olds?.project) ??
            output?.environmentId ??
            "";
          const instance =
            resolvedEnvId.length > 0
              ? yield* getInstance(resolvedEnvId, found.id)
              : undefined;
          const attrs = toAttrs({
            service: found,
            instance,
            domain: undefined,
            projectId: resolvedProjectId,
            environmentId: resolvedEnvId,
            port: output?.port ?? olds?.port,
            codeHash: output?.code.hash ?? "",
          });
          if (output !== undefined) return attrs;
          return matchesAlchemyPhysicalName(found.name)
            ? attrs
            : Unowned(attrs);
        }),

        list: Effect.fn(function* () {
          const projects = yield* listOwnedProjects();
          const rows = yield* Effect.forEach(
            projects,
            (project) =>
              listProjectServices(project.projectId).pipe(
                Effect.map((services) =>
                  services
                    .filter((service) =>
                      matchesAlchemyPhysicalName(service.name),
                    )
                    .map((service) =>
                      toAttrs({
                        service,
                        instance: undefined,
                        domain: undefined,
                        projectId: project.projectId,
                        environmentId: project.environmentId,
                        port: undefined,
                        codeHash: "",
                      }),
                    ),
                ),
              ),
            { concurrency: 8 },
          );
          return rows.flat();
        }),

        reconcile: Effect.fn(function* ({
          id,
          news,
          olds,
          output,
          bindings,
          session,
        }) {
          const props = news;
          const projectId = projectIdOf(props.project) ?? output?.projectId;
          if (projectId === undefined) {
            return yield* new ServiceProjectRequired({
              message: "Service requires a resolved Railway.Project",
            });
          }
          const environmentId =
            environmentIdOf(props.environment) ??
            environmentIdOf(props.project) ??
            output?.environmentId;
          if (environmentId === undefined) {
            return yield* new ServiceProjectRequired({
              message:
                "Service requires a Railway environment (pass environment or a Project with environmentId)",
            });
          }
          const name = yield* resolveName(id, props.name, output?.name);
          const hostedMain =
            props.main !== undefined && props.main.length > 0
              ? props.main
              : undefined;
          const bound = collectBindingState(bindings ?? []);
          const port =
            hostedMain !== undefined
              ? (props.port ?? DEFAULT_PORT)
              : props.port;
          const env = {
            ...bound.env,
            ...(hostedMain !== undefined ? hosted.alchemyEnv : {}),
            ...(port !== undefined ? { PORT: String(port) } : {}),
            ...toEnvRecord(props.env),
          };

          let sourceImage: string | undefined;
          let sourceRepo: string | undefined;
          let codeHash = output?.code.hash ?? "";
          let registryCredentials:
            | { username: string; password: string }
            | undefined;
          if (hostedMain !== undefined) {
            const resolved = yield* hosted.resolveImage({
              id,
              props: {
                main: hostedMain,
                handler: props.handler,
                port,
                image: props.image,
                env: props.env,
                isExternal: props.isExternal,
                build: props.build,
                registry: props.registry,
              },
              previousHash: output?.code.hash,
              session,
            });
            sourceImage = resolved.imageRef;
            codeHash = resolved.codeHash;
            registryCredentials = resolved.registryCredentials;
          } else if (props.image !== undefined && props.image.length > 0) {
            sourceImage = props.image;
          } else if (props.repo !== undefined && props.repo.length > 0) {
            sourceRepo = props.repo;
          } else {
            return yield* new ServiceImageOrMainRequired({
              message:
                "Railway.Service requires `image` (public image), `main` + `registry` (Effect-native), or `repo` (GitHub).",
            });
          }

          let current =
            output?.serviceId !== undefined && output.serviceId.length > 0
              ? yield* getById(output.serviceId)
              : undefined;
          if (current === undefined) {
            current = yield* findByName(projectId, name);
          }

          if (current === undefined) {
            const created = yield* railway
              .serviceCreate({
                input: {
                  projectId,
                  environmentId,
                  name,
                  source:
                    sourceRepo !== undefined
                      ? { repo: sourceRepo }
                      : { image: sourceImage },
                  ...(sourceRepo !== undefined && props.branch !== undefined
                    ? { branch: props.branch }
                    : {}),
                  ...(registryCredentials !== undefined
                    ? { registryCredentials }
                    : {}),
                  ...(Object.keys(env).length > 0 ? { variables: env } : {}),
                },
              })
              .pipe(
                RailwayRetry.none,
                Effect.retry(rateLimited),
                Effect.catchTag("RailwayValidationError", (e) =>
                  alreadyExists(e.message)
                    ? Effect.succeed(undefined)
                    : Effect.fail(e),
                ),
                Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
              );
            current = created ?? (yield* findByName(projectId, name));
          }

          if (current === undefined || isGoneService(current)) {
            return yield* new ServiceNotCreated({ name, projectId });
          }

          if (current.name !== name) {
            current = yield* railway.serviceUpdate({
              id: current.id,
              input: { name },
            });
          }

          let instance = yield* waitForInstance(environmentId, current.id);
          let needsDeploy = false;

          const instanceDelta = instanceSettingsDelta({
            instance,
            sourceImage,
            sourceRepo,
            registryCredentials,
            previousReplicas: olds?.replicas,
            props,
          });
          if (instanceDelta !== undefined) {
            yield* railway
              .serviceInstanceUpdate({
                environmentId,
                serviceId: current.id,
                input: instanceDelta,
              })
              .pipe(RailwayRetry.none, Effect.retry(rateLimited));
            needsDeploy = true;
            instance =
              (yield* getInstance(environmentId, current.id)) ?? instance;
          }

          if (sourceRepo !== undefined) {
            const branchChanged = yield* syncBranch({
              projectId,
              environmentId,
              serviceId: current.id,
              repo: sourceRepo,
              branch: props.branch,
            });
            if (branchChanged) needsDeploy = true;
          }

          yield* syncAutoUpdates({
            projectId,
            environmentId,
            serviceId: current.id,
            enabled: props.autoUpdates,
          });

          const envChanged = yield* syncEnv({
            projectId,
            environmentId,
            serviceId: current.id,
            desired: env,
          });
          if (envChanged) needsDeploy = true;

          yield* syncMounts({
            environmentId,
            serviceId: current.id,
            mounts: bound.mounts,
          });

          const domain = yield* ensureServiceDomain({
            projectId,
            environmentId,
            serviceId: current.id,
            targetPort: port,
          });

          if (needsDeploy || instance?.latestDeployment == null) {
            yield* railway
              .serviceInstanceDeployV2({
                environmentId,
                serviceId: current.id,
              })
              .pipe(
                RailwayRetry.none,
                Effect.retry(rateLimited),
                Effect.catchTag("RailwayValidationError", () => Effect.void),
              );
          }

          instance =
            sourceRepo !== undefined
              ? ((yield* getInstance(environmentId, current.id)) ?? instance)
              : ((yield* waitForDeployment(environmentId, current.id)) ??
                instance);

          return toAttrs({
            service: current,
            instance,
            domain,
            projectId,
            environmentId,
            port,
            codeHash,
          });
        }),

        delete: Effect.fn(function* ({ output }) {
          const serviceId = output.serviceId;
          if (serviceId.length === 0) return;
          yield* railway
            .serviceDelete({
              id: serviceId,
              ...(output.environmentId.length > 0
                ? { environmentId: output.environmentId }
                : {}),
            })
            .pipe(
              Effect.catchTag(
                ["RailwayNotFound", "NotFound"],
                () => Effect.void,
              ),
            );
          yield* getById(serviceId).pipe(
            Effect.map((service) => service === undefined),
            Effect.repeat({
              schedule: Schedule.spaced("1 second"),
              until: (gone) => gone,
              times: 8,
            }),
          );
        }),
      });
    }),
  ).pipe(Layer.provide(DockerLive));
