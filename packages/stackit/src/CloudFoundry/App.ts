import { makeContainerImageSource } from "@alchemy.run/docker/ImageSource";
import * as cf from "@distilled.cloud/stackit/cloud_foundry";
import { Unowned } from "alchemy/AdoptPolicy";
import type * as Bundle from "alchemy/Bundle/Bundle";
import { isResolved, stripEffects } from "alchemy/Diff";
import type { InputProps } from "alchemy/Input";
import { createPhysicalName } from "alchemy/PhysicalName";
import { Platform, type Main, type PlatformProps } from "alchemy/Platform";
import * as Provider from "alchemy/Provider";
import type { Resource, ResourceBinding } from "alchemy/Resource";
import type { HostRuntimeContext, ServerHost } from "alchemy/Runtime/Process";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { findOwnedByName, readGeneration } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import {
  createRawEnvRuntimeContext,
  hostEnv,
  hostEnvVariable,
  hostImageSource,
  pushHostImage,
  type HostRegistry,
} from "../internal/serverHost.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import { desiredGenerationLabels, hasAlchemyLabels, stripInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import type { HostBinding } from "../StackitBindings.ts";
import {
  APP_START_TIMEOUT,
  awaitJob,
  BUILD_TIMEOUT,
  CF_HOST_MAX_LENGTH,
  CF_NAME_MAX_LENGTH,
  collectCloudFoundryItems,
  deleteRouteAndWait,
  DEPLOYMENT_TIMEOUT,
  ensureDestination,
  findOwnRoute,
  getRouteOrUndefined,
  JOB_TIMEOUT,
  labelUpdate,
  observedLabels,
  relationTo,
  requireGuid,
  resolveDomain,
  usableCredentials,
  withCloudFoundry,
  type CloudFoundryCredentialsProps,
} from "./internal.ts";

export type { InferEnv } from "../InferEnv.ts";

/**
 * ASSUMPTION for the first live deploy: the port an app's image declares. Cloud Foundry
 * routes to the port a Docker image exposes (docs.cloudfoundry.org/adminguide/docker.html),
 * and the program reads it from `PORT`.
 */
export const APP_PORT = 8080;

/** How an instance is checked for health. */
export interface AppHealthCheck {
  /** `process` (the process runs), `port` (it accepts connections) or `http`. */
  type: "process" | "port" | "http";
  /** Path to request, when `type` is `http`. */
  endpoint?: string;
}

export interface AppProps<
  Env extends Record<string, any> = Record<string, any>,
> extends PlatformProps {
  /** Space to deploy into. Changing it replaces the app. */
  spaceId: string;
  /**
   * A user with `space_developer` in the space: an organization manager with a
   * `Stackit.CloudFoundry.SpaceRole`, or a `space-scoped-service-account` user. Updates in
   * place, with no restart.
   */
  credentials: CloudFoundryCredentialsProps;
  /**
   * Name of the app in its space. Updates in place. If omitted, a unique name is generated
   * from the stack, stage and logical ID.
   */
  name?: string;
  /**
   * Module to run. On an effectful App this is `import.meta.url`: the file is both the
   * bundle entry and the program. On an async App it is a file exporting
   * `{ fetch(request, env) }`, which is bundled with no Effect runtime.
   *
   * Either way, Alchemy builds a bun image with Docker on the deploying machine and pushes
   * it to {@link registry}, which `main` requires.
   */
  main?: string;
  /**
   * Named export to load from {@link main}.
   *
   * @default "default"
   */
  handler?: string;
  /**
   * Without {@link main}, the image to run. With `main`, the base image the program is
   * layered on, which must be able to run bun.
   *
   * @default "oven/bun:1" with `main`
   */
  image?: string;
  /** Where the image built from {@link main} is pushed. */
  registry?: HostRegistry;
  /** Bundler configuration for {@link main}. */
  build?: Bundle.BundleConfig;
  /**
   * Login Cloud Foundry pulls the image with, for a private registry. Defaults to
   * {@link registry}'s login.
   */
  imageCredentials?: {
    username: string;
    password: string | Redacted.Redacted<string>;
  };
  /**
   * Instances of the app's web process. Updates in place, with no restart.
   *
   * @default the API's default of 1
   */
  instances?: number;
  /**
   * Memory per instance in MB. Billed per MB and hour while started. A new value rolls the
   * instances.
   *
   * @default the platform's default
   */
  memoryInMb?: number;
  /** Disk per instance in MB. A new value rolls the instances. @default the platform's default */
  diskInMb?: number;
  /**
   * How instances are checked for health. A new value rolls the instances.
   *
   * @default a `port` check, the platform's default
   */
  healthCheck?: AppHealthCheck;
  /**
   * Environment variables. A new value rolls the instances. `Redacted` values stay
   * `Redacted` in state, but the platform holds them as plain text, and anyone with a role
   * that can read the app's environment can read them.
   *
   * On an async App, {@link InferEnv} types the handler's second argument from these keys,
   * and each value arrives as a `string`.
   */
  env?: Env;
  /**
   * `Stackit.CloudFoundry.ServiceInstance` ids to bind. Their credentials reach the app
   * through `VCAP_SERVICES`. A change rolls the instances.
   */
  services?: string[];
  /**
   * Host of the app's route, the part before the domain. A new value creates a new route
   * and deletes the old one. A host you choose can't be held twice, so replacing the app deletes
   * the old one first, and the app is down until the new one runs.
   *
   * @default a unique name generated from the stack, stage and logical ID
   */
  host?: string;
  /**
   * Name of the domain of the app's route. A new value creates a new route and deletes the
   * old one.
   *
   * @default the platform's first shared HTTP domain
   */
  domain?: string;
  /**
   * Don't give the app a route of its own, for a worker or for one using
   * `Stackit.CloudFoundry.Route`. `url` is then `undefined`.
   *
   * @default false
   */
  noRoute?: boolean;
  /** User labels. Alchemy's ownership labels are always merged in. Updates in place. */
  labels?: Record<string, string>;
}

export interface AppAttributes {
  /** Cloud Foundry id of the app. Stable across updates. */
  appId: string;
  /** Name of the app. */
  name: string;
  /** Space the app runs in. */
  spaceId: string;
  /** Desired state: `STARTED` after a deploy. */
  state: string;
  /** `https://` URL of the app's route, if it has one. */
  url: string | undefined;
  /** The app's route, if it has one. */
  routeId: string | undefined;
  /** Host of the app's route. */
  host: string | undefined;
  /** Domain of the app's route. */
  domain: string | undefined;
  /** Image the app runs. */
  image: string | undefined;
  /** Content hash of the program built from `main`; undefined for an `image`. */
  codeHash: string | undefined;
  /** The droplet staged from that image. */
  dropletId: string | undefined;
  /** Instances of the web process. */
  instances: number | undefined;
  /** Memory per instance in MB. */
  memoryInMb: number | undefined;
  /** Names of the environment variables this resource set. */
  envNames: string[];
  /** Service credential bindings this resource created, by service instance id. */
  serviceBindings: Record<string, string>;
  /** User labels (Alchemy ownership labels stripped). */
  labels: Record<string, string>;
}

export type App<Env extends Record<string, any> = Record<string, any>> = Resource<
  "Stackit.CloudFoundry.App",
  AppProps<Env>,
  AppAttributes,
  HostBinding,
  Providers
>;

export type AppServices = ServerHost;
export type AppShape = Main<AppServices>;
export type AppRuntimeContext = HostRuntimeContext;

/**
 * A STACKIT Cloud Foundry app: an image the platform runs behind its router, as many
 * instances as you ask for, in a space.
 *
 * It ships in two forms, both built from `main` into a bun image with Docker on the
 * deploying machine and pushed to `registry`. Or pass a pre-built `image` instead of
 * `main`. Alchemy doesn't upload source for a buildpack to stage: there is no buildpack
 * for bun, and the image is what both forms share with `Stackit.Functions.Function`.
 *
 * Changing `spaceId` replaces the app; everything else updates in place. A deploy waits
 * until a new image has staged and the instances run. Once the app is started, a new
 * image, new variables or new limits roll out one instance at a time with a Cloud Foundry
 * deployment. A destroy waits until the app is gone, and deletes the route it created.
 *
 * It needs `credentials` for the platform's Cloud Foundry API, which takes UAA tokens
 * rather than STACKIT ones: an organization manager with `space_developer`, or a
 * `space-scoped-service-account` user.
 *
 * Ownership is tracked with Cloud Foundry labels (`alchemy.stack`, `alchemy.stage`,
 * `alchemy.id`, `alchemy.instance`). An app with the same explicit `name` that lacks them
 * is reported as unowned, and only taken over with `--adopt`.
 *
 * Alchemy creates the app, its route and, for a binding, a service account and key. It
 * doesn't create the space or the credentials the platform's API takes: declare a
 * `Stackit.CloudFoundry.Space` and an `OrganizationManager` as the first example shows,
 * and pass both. It doesn't create a registry: pass `registry` to push to one you own, or
 * pass a pre-built `image`. See [Cloud Foundry on STACKIT](/stackit/compute/cloud-foundry)
 * for the full guide.
 *
 * See [STACKIT's Cloud Foundry docs](https://docs.stackit.cloud/products/runtime/cloud-foundry/).
 *
 * :::caution[Docker images on STACKIT]
 * Cloud Foundry only runs images when the platform enables its `diego_docker` flag.
 * STACKIT's docs describe `cf push --docker-image`, but don't state the flag.
 * :::
 *
 * :::caution[Variables are readable]
 * Environment variables are plain text on the platform, including the service account key
 * a binding adds to the app. Anyone who can read the app's environment can read them.
 * :::
 *
 * :::caution[Changing `spaceId` replaces the App]
 * The app is created in the new space, with a new id, and the old one is deleted. A route
 * with a chosen `host` has to wait for the old one to go.
 * :::
 *
 * ### Async Apps
 * You don't have to use Effect. Pass `main` pointing at a file and no implementation.
 * Alchemy bundles that file as-is, serves its `fetch` from a small server in the image, and
 * passes the environment as the second argument. `InferEnv` types it.
 *
 * **Example:** Defining an async App in your stack
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 *
 * export const Org = Stackit.CloudFoundry.Organization("Org", {});
 * export const Dev = Effect.gen(function* () {
 *   const organization = yield* Org;
 *   return yield* Stackit.CloudFoundry.Space("Dev", {
 *     organizationId: organization.organizationId,
 *   });
 * });
 * export const Manager = Effect.gen(function* () {
 *   const organization = yield* Org;
 *   return yield* Stackit.CloudFoundry.OrganizationManager("Manager", {
 *     organizationId: organization.organizationId,
 *   });
 * });
 * export const Deployer = Effect.gen(function* () {
 *   const organization = yield* Org;
 *   const space = yield* Dev;
 *   const manager = yield* Manager;
 *   const credentials = {
 *     apiUrl: manager.apiUrl,
 *     username: manager.username,
 *     password: manager.password,
 *   };
 *   const role = yield* Stackit.CloudFoundry.SpaceRole("Developer", {
 *     organizationId: organization.organizationId,
 *     spaceId: space.spaceId,
 *     type: "space_developer",
 *     userGuid: manager.userId,
 *     credentials,
 *   });
 *   // `role.spaceId`, so an app deploys after the manager holds the role.
 *   return { spaceId: role.spaceId, credentials };
 * });
 *
 * export const Ping = Effect.gen(function* () {
 *   const deployer = yield* Deployer;
 *   return yield* Stackit.CloudFoundry.App("Ping", {
 *     ...deployer,
 *     main: "./src/ping.ts",
 *     registry: { repository: "ghcr.io/my-org/ping" },
 *     memoryInMb: 256,
 *     env: { GREETING: "hello" },
 *   });
 * });
 *
 * export type PingEnv = Stackit.InferEnv<typeof Ping>;
 * ```
 *
 * **Example:** Writing the async handler
 * ```typescript
 * import type { PingEnv } from "../alchemy.run.ts";
 *
 * export default {
 *   async fetch(_request: Request, env: PingEnv) {
 *     return new Response(env.GREETING);
 *   },
 * };
 * ```
 *
 * ### Effect-native Apps
 * An App is a class. Props describe the app, and the Effect is the program that runs in it.
 * `main: import.meta.url` makes the file the bundle entry. Construction binds resources, and
 * the returned handlers run per request.
 *
 * **Example:** A class with a `fetch` handler
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { Deployer } from "./deployer.ts";
 *
 * export default class Api extends Stackit.CloudFoundry.App<Api>()(
 *   "Api",
 *   Effect.gen(function* () {
 *     const deployer = yield* Deployer;
 *     return {
 *       ...deployer,
 *       main: import.meta.url,
 *       registry: { repository: "ghcr.io/my-org/api" },
 *     };
 *   }),
 *   Effect.succeed({ fetch: Effect.succeed(HttpServerResponse.text("hello")) }),
 * ) {}
 * ```
 *
 * ### Choosing the image
 * **Example:** Push to a STACKIT Container Registry project
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Output from "alchemy/Output";
 * import * as Config from "effect/Config";
 * import { Deployer } from "./deployer.ts";
 *
 * const deployer = yield* Deployer;
 * const harbor = {
 *   username: Config.String("HARBOR_USERNAME"),
 *   secret: Config.Redacted("HARBOR_CLI_SECRET"),
 * };
 * const images = yield* Stackit.ContainerRegistry.Project("Images", {
 *   forceDestroy: true,
 *   harborCredentials: harbor,
 * });
 * const pusher = yield* Stackit.ContainerRegistry.RobotAccount("Pusher", {
 *   project: images.name,
 *   registryUrl: images.url,
 *   credentials: harbor,
 * });
 * const app = yield* Stackit.CloudFoundry.App("Api", {
 *   ...deployer,
 *   main: "./src/api.ts",
 *   registry: {
 *     repository: Output.interpolate`${images.imagePrefix}/api`,
 *     username: pusher.robotName,
 *     password: pusher.secret,
 *   },
 * });
 * ```
 *
 * **Example:** Run a pre-built image
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import { Deployer } from "./deployer.ts";
 *
 * const deployer = yield* Deployer;
 * const app = yield* Stackit.CloudFoundry.App("Api", {
 *   ...deployer,
 *   image: "ghcr.io/my-org/api:v1.2.3",
 * });
 * ```
 *
 * **Example:** A pre-built image from a private registry
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Redacted from "effect/Redacted";
 * import { Deployer } from "./deployer.ts";
 *
 * const deployer = yield* Deployer;
 * const app = yield* Stackit.CloudFoundry.App("Api", {
 *   ...deployer,
 *   image: "registry.example.com/my-org/api:v1.2.3",
 *   imageCredentials: { username: "pull", password: Redacted.make("...") },
 * });
 * ```
 *
 * ### Configuration
 * **Example:** Instances, limits, health check and labels
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import { Deployer } from "./deployer.ts";
 *
 * const deployer = yield* Deployer;
 * const app = yield* Stackit.CloudFoundry.App("Api", {
 *   ...deployer,
 *   image: "ghcr.io/my-org/api:v1.2.3",
 *   name: "orders-api",
 *   instances: 2,
 *   memoryInMb: 512,
 *   diskInMb: 1024,
 *   healthCheck: { type: "http", endpoint: "/healthz" },
 *   labels: { team: "orders" },
 * });
 * ```
 *
 * ### Routes
 * **Example:** A chosen host on a chosen domain
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import { Deployer } from "./deployer.ts";
 *
 * const deployer = yield* Deployer;
 * const app = yield* Stackit.CloudFoundry.App("Api", {
 *   ...deployer,
 *   image: "ghcr.io/my-org/api:v1.2.3",
 *   host: "orders",
 *   domain: "apps.01.cf.eu01.stackit.cloud",
 * });
 * // app.url is https://orders.apps.01.cf.eu01.stackit.cloud
 * ```
 *
 * **Example:** A worker with no route
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import { Deployer } from "./deployer.ts";
 *
 * const deployer = yield* Deployer;
 * const worker = yield* Stackit.CloudFoundry.App("Worker", {
 *   ...deployer,
 *   image: "ghcr.io/my-org/worker:v1.2.3",
 *   noRoute: true,
 *   healthCheck: { type: "process" },
 * });
 * ```
 *
 * ### Services
 * **Example:** Bind a marketplace service, read through `VCAP_SERVICES`
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import { Deployer } from "./deployer.ts";
 *
 * const deployer = yield* Deployer;
 * const database = yield* Stackit.CloudFoundry.ServiceInstance("Db", {
 *   ...deployer,
 *   offering: "postgresql",
 *   plan: "small",
 * });
 * const app = yield* Stackit.CloudFoundry.App("Api", {
 *   ...deployer,
 *   image: "ghcr.io/my-org/api:v1.2.3",
 *   services: [database.serviceInstanceId],
 * });
 * ```
 *
 * ### Using STACKIT bindings
 * An App runs as no STACKIT identity, so a binding gets a service account and key, and the
 * key reaches the app as an environment variable. See the caution above. Grants are
 * project-scoped, because STACKIT binds roles only on organizations, folders and projects.
 *
 * **Example:** Read a DNS zone from the app
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { Deployer } from "./deployer.ts";
 *
 * export const Domain = Stackit.DNS.Zone("Domain", { dnsName: "example.com" });
 *
 * export default class Api extends Stackit.CloudFoundry.App<Api>()(
 *   "Api",
 *   Effect.gen(function* () {
 *     const deployer = yield* Deployer;
 *     return {
 *       ...deployer,
 *       main: import.meta.url,
 *       registry: { repository: "ghcr.io/my-org/api" },
 *     };
 *   }),
 *   Effect.gen(function* () {
 *     const domain = yield* Domain;
 *     const getZone = yield* Stackit.DNS.GetZone(domain);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { zone } = yield* getZone({});
 *         return yield* HttpServerResponse.json({ state: zone.state });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.DNS.GetZoneHttp)),
 * ) {}
 * ```
 *
 * ### Event sources
 * Cloud Foundry has no trigger, schedule or subscription object. An app is reached over its
 * route, and it can consume a queue itself, as a long-running process.
 *
 * A rolling deploy or a scale-in stops a running instance with a signal: HTTP requests get about six seconds to
 * finish, and a consumer's handler is interrupted mid message, so that message comes back. A
 * handler has to tolerate running twice.
 *
 * **Example:** Consume a RabbitMQ queue from the app
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { Deployer } from "./deployer.ts";
 * import { Credential } from "./queue.ts";
 *
 * export default class Consumer extends Stackit.CloudFoundry.App<Consumer>()(
 *   "Consumer",
 *   Effect.gen(function* () {
 *     const deployer = yield* Deployer;
 *     return {
 *       ...deployer,
 *       main: import.meta.url,
 *       registry: { repository: "ghcr.io/my-org/consumer" },
 *     };
 *   }),
 *   Effect.gen(function* () {
 *     yield* Stackit.RabbitMQ.consumeQueueMessages(
 *       Credential,
 *       { queue: "orders", prefetch: 10 },
 *       (message) => Effect.log(message.text),
 *     );
 *     return { fetch: Effect.succeed(HttpServerResponse.text("consuming")) };
 *   }).pipe(Effect.provide(Stackit.RabbitMQ.ServerQueueEventSource)),
 * ) {}
 * ```
 *
 * **Example:** Consume a Pub/Sub subscription
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import { Deployer } from "./deployer.ts";
 *
 * export const Orders = Stackit.PubSub.Topic("Orders", {});
 * export const Billing = Orders.pipe(
 *   Effect.flatMap((topic) => Stackit.PubSub.Subscription("Billing", { topicId: topic.topicId })),
 * );
 *
 * export default class BillingWorker extends Stackit.CloudFoundry.App<BillingWorker>()(
 *   "BillingWorker",
 *   Effect.gen(function* () {
 *     const deployer = yield* Deployer;
 *     return {
 *       ...deployer,
 *       main: import.meta.url,
 *       registry: { repository: "ghcr.io/my-org/billingworker" },
 *     };
 *   }),
 *   Effect.gen(function* () {
 *     yield* Stackit.PubSub.consumeSubscriptionMessages(
 *       Billing,
 *       { maxMessages: 32, concurrency: 8 },
 *       (message) => Effect.log(message.text),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(Stackit.PubSub.ServerSubscriptionEventSource)),
 * ) {}
 * ```
 *
 * ### Packaging
 * `main` is bundled into one file on your machine, with Docker building the image around
 * it. `build` takes the bundler's options. A package you keep out of the bundle has to be
 * in the base image you pass as `image`.
 *
 * **Example:** Minify, and keep a package out of the bundle
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import { Deployer } from "./deployer.ts";
 *
 * const deployer = yield* Deployer;
 * const app = yield* Stackit.CloudFoundry.App("Api", {
 *   ...deployer,
 *   main: "./src/api.ts",
 *   image: "ghcr.io/my-org/bun-with-sharp:1",
 *   registry: { repository: "ghcr.io/my-org/api" },
 *   build: {
 *     input: { external: ["sharp"] },
 *     output: { minify: true },
 *   },
 * });
 * ```
 *
 * ### Object Storage Bindings
 * `ReadBucket`, `WriteBucket` and `ReadWriteBucket` give the app an S3 client on one
 * bucket. Alchemy creates a credentials group and an access key for this host and bucket,
 * and adds statements to the bucket's policy limiting the group to those actions there.
 * Give other buckets their own `policy` to deny such groups, because a bucket policy only
 * speaks for its own bucket.
 *
 * **Example:** Write an object and read it back
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import * as Stream from "effect/Stream";
 * import { Deployer } from "./deployer.ts";
 *
 * export const Uploads = Stackit.ObjectStorage.Bucket("Uploads", {});
 *
 * export default class Api extends Stackit.CloudFoundry.App<Api>()(
 *   "Api",
 *   Effect.gen(function* () {
 *     const deployer = yield* Deployer;
 *     return {
 *       ...deployer,
 *       main: import.meta.url,
 *       registry: { repository: "ghcr.io/my-org/api" },
 *     };
 *   }),
 *   Effect.gen(function* () {
 *     // init
 *     const uploads = yield* Stackit.ObjectStorage.ReadWriteBucket(yield* Uploads);
 *     return {
 *       // runtime
 *       fetch: Effect.gen(function* () {
 *         yield* uploads.putObject({ Key: "hello.txt", Body: "hello" });
 *         const object = yield* uploads.getObject({ Key: "hello.txt" });
 *         const text = yield* Stream.mkString(Stream.decodeText(object.Body!));
 *         return HttpServerResponse.text(text);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ObjectStorage.ReadWriteBucketHttp)),
 * ) {}
 * ```
 *
 * ### PostgreSQL Flex Bindings
 * `Connect` passes a database's host, port, names and password into the app's environment,
 * with the password kept `Redacted`. It grants no STACKIT role, because PostgreSQL
 * connections authenticate with the database user. The app's egress address has to be in
 * the instance's `acl`, or connections time out.
 *
 * **Example:** Resolve the connection settings for your driver
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { Deployer } from "./deployer.ts";
 *
 * export const Db = Stackit.PostgresFlex.Instance("Db", {
 *   flavorId: "2.4",
 *   version: "17",
 *   storage: { class: "premium-perf2-stackit", size: 5 },
 *   backupSchedule: "0 2 * * *",
 *   retentionDays: 32,
 *   acl: ["203.0.113.7/32"],
 * });
 * export const AppUser = Db.pipe(
 *   Effect.flatMap((db) => Stackit.PostgresFlex.User("AppUser", { instanceId: db.instanceId })),
 * );
 * export const AppDatabase = Effect.gen(function* () {
 *   const db = yield* Db;
 *   const user = yield* AppUser;
 *   return yield* Stackit.PostgresFlex.Database("AppDatabase", {
 *     instanceId: db.instanceId,
 *     owner: user.userName,
 *   });
 * });
 *
 * export default class Api extends Stackit.CloudFoundry.App<Api>()(
 *   "Api",
 *   Effect.gen(function* () {
 *     const deployer = yield* Deployer;
 *     return {
 *       ...deployer,
 *       main: import.meta.url,
 *       registry: { repository: "ghcr.io/my-org/api" },
 *     };
 *   }),
 *   Effect.gen(function* () {
 *     // init
 *     const database = yield* AppDatabase;
 *     const user = yield* AppUser;
 *     const connect = yield* Stackit.PostgresFlex.Connect(database, user);
 *     return {
 *       // runtime
 *       fetch: Effect.gen(function* () {
 *         const info = yield* connect;
 *         return yield* HttpServerResponse.json({ database: info.database });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.PostgresFlex.ConnectHttp)),
 * ) {}
 * ```
 *
 * ### Valkey Bindings
 * `ReadValkey` and `ReadWriteValkey` run commands over a credential. They grant no STACKIT
 * role, and STACKIT has no Valkey ACLs, so the credential can do everything on the server:
 * the limit is the client's surface. The app's egress address has to be in the instance's
 * `acl`.
 *
 * **Example:** Set and read a key
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { Deployer } from "./deployer.ts";
 *
 * export const Cache = Stackit.Valkey.Instance("Cache", {
 *   version: "x",
 *   planName: "stackit-keyvalue-1.2.10-replica",
 *   acl: ["203.0.113.7/32"],
 * });
 * export const Login = Cache.pipe(
 *   Effect.flatMap((cache) =>
 *     Stackit.Valkey.Credential("Login", { instanceId: cache.instanceId }),
 *   ),
 * );
 *
 * export default class Api extends Stackit.CloudFoundry.App<Api>()(
 *   "Api",
 *   Effect.gen(function* () {
 *     const deployer = yield* Deployer;
 *     return {
 *       ...deployer,
 *       main: import.meta.url,
 *       registry: { repository: "ghcr.io/my-org/api" },
 *     };
 *   }),
 *   Effect.gen(function* () {
 *     // init
 *     const cache = yield* Stackit.Valkey.ReadWriteValkey(yield* Login);
 *     return {
 *       // runtime
 *       fetch: Effect.gen(function* () {
 *         yield* cache.set("marker", "hello");
 *         const value = yield* cache.get("marker");
 *         return yield* HttpServerResponse.json({ value });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Valkey.ReadWriteValkeyHttp)),
 * ) {}
 * ```
 *
 * ### Pub/Sub Bindings
 * `Publish` and `Pull` grant no role. Alchemy adds the app's service account to this
 * topic's publishers or this subscription's subscribers, so the grant covers that one
 * topic or subscription. The topic's `acl` has to include the app's egress address, and it
 * allows every address by default.
 *
 * **Example:** Publish a message
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { Deployer } from "./deployer.ts";
 *
 * export const Orders = Stackit.PubSub.Topic("Orders", {});
 *
 * export default class Api extends Stackit.CloudFoundry.App<Api>()(
 *   "Api",
 *   Effect.gen(function* () {
 *     const deployer = yield* Deployer;
 *     return {
 *       ...deployer,
 *       main: import.meta.url,
 *       registry: { repository: "ghcr.io/my-org/api" },
 *     };
 *   }),
 *   Effect.gen(function* () {
 *     // init
 *     const publish = yield* Stackit.PubSub.Publish(yield* Orders);
 *     return {
 *       // runtime
 *       fetch: Effect.gen(function* () {
 *         yield* publish({ messages: [{ data: JSON.stringify({ orderId: "1234" }) }] });
 *         return HttpServerResponse.text("published");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.PubSub.PublishHttp)),
 * ) {}
 * ```
 *
 * **Example:** Pull a batch on each request, and acknowledge it
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { Deployer } from "./deployer.ts";
 *
 * export const Orders = Stackit.PubSub.Topic("Orders", {});
 * export const Billing = Orders.pipe(
 *   Effect.flatMap((topic) => Stackit.PubSub.Subscription("Billing", { topicId: topic.topicId })),
 * );
 *
 * export default class Api extends Stackit.CloudFoundry.App<Api>()(
 *   "Api",
 *   Effect.gen(function* () {
 *     const deployer = yield* Deployer;
 *     return {
 *       ...deployer,
 *       main: import.meta.url,
 *       registry: { repository: "ghcr.io/my-org/api" },
 *     };
 *   }),
 *   Effect.gen(function* () {
 *     // init
 *     const billing = yield* Billing;
 *     const pull = yield* Stackit.PubSub.Pull(billing);
 *     const acknowledge = yield* Stackit.PubSub.Acknowledge(billing);
 *     return {
 *       // runtime
 *       fetch: Effect.gen(function* () {
 *         const { messages } = yield* pull({ maxMessages: 10, longPullDuration: 1000 });
 *         yield* acknowledge({ ackIds: messages.map((message) => message.ackId) });
 *         return yield* HttpServerResponse.json({ pulled: messages.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(
 *     Effect.provide([Stackit.PubSub.PullHttp, Stackit.PubSub.AcknowledgeHttp]),
 *   ),
 * ) {}
 * ```
 *
 * ### RabbitMQ Bindings
 * `Publish` publishes one message through the broker's management API over HTTPS, as the
 * credential's user, so it grants no STACKIT role. The app's egress address has to be in
 * the instance's `acl`.
 *
 * **Example:** Publish to a queue
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { Deployer } from "./deployer.ts";
 *
 * export const Broker = Stackit.RabbitMQ.Instance("Broker", {
 *   version: "4.1",
 *   planName: "stackit-rabbitmq-2.4.10-single",
 *   acl: ["203.0.113.7/32"],
 * });
 * export const Login = Broker.pipe(
 *   Effect.flatMap((broker) =>
 *     Stackit.RabbitMQ.Credential("Login", { instanceId: broker.instanceId }),
 *   ),
 * );
 *
 * export default class Api extends Stackit.CloudFoundry.App<Api>()(
 *   "Api",
 *   Effect.gen(function* () {
 *     const deployer = yield* Deployer;
 *     return {
 *       ...deployer,
 *       main: import.meta.url,
 *       registry: { repository: "ghcr.io/my-org/api" },
 *     };
 *   }),
 *   Effect.gen(function* () {
 *     // init
 *     const publish = yield* Stackit.RabbitMQ.Publish(yield* Login);
 *     return {
 *       // runtime
 *       fetch: Effect.gen(function* () {
 *         const { routed } = yield* publish({
 *           routing_key: "jobs",
 *           payload: JSON.stringify({ id: 1 }),
 *         });
 *         return yield* HttpServerResponse.json({ routed });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.RabbitMQ.PublishHttp)),
 * ) {}
 * ```
 *
 * ### Secrets Manager Bindings
 * `ReadSecret` creates a read-only AppRole for this host and instance. It reads every
 * secret in the instance, because STACKIT can't limit an AppRole to a path, so use one
 * instance per trust boundary. The app's egress address has to be in the instance's
 * `acls`.
 *
 * **Example:** Read a secret
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { Deployer } from "./deployer.ts";
 *
 * export const Vault = Stackit.SecretsManager.Instance("Vault", {
 *   acls: ["203.0.113.7/32"],
 * });
 *
 * export default class Api extends Stackit.CloudFoundry.App<Api>()(
 *   "Api",
 *   Effect.gen(function* () {
 *     const deployer = yield* Deployer;
 *     return {
 *       ...deployer,
 *       main: import.meta.url,
 *       registry: { repository: "ghcr.io/my-org/api" },
 *     };
 *   }),
 *   Effect.gen(function* () {
 *     // init
 *     const secrets = yield* Stackit.SecretsManager.ReadSecret(yield* Vault);
 *     return {
 *       // runtime
 *       fetch: Effect.gen(function* () {
 *         const secret = yield* secrets.get({ secretPath: "payments/api" });
 *         return yield* HttpServerResponse.json({ version: secret.data.metadata.version });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.SecretsManager.ReadSecretHttp)),
 * ) {}
 * ```
 *
 * ### KMS Bindings
 * `Encrypt`, `Decrypt`, `Sign` and `Verify` take one key. Alchemy grants `kms.keyring.get`
 * through a custom role on the project holding the key. That one permission allows those
 * operations on every key in the project, so the binding narrows what your code calls, not
 * what its credential could do.
 *
 * **Example:** Encrypt bytes
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as Redacted from "effect/Redacted";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { Deployer } from "./deployer.ts";
 *
 * export const Ring = Stackit.KMS.KeyRing("Ring", {});
 * export const DataKey = Ring.pipe(
 *   Effect.flatMap((ring) =>
 *     Stackit.KMS.Key("DataKey", {
 *       keyRingId: ring.keyRingId,
 *       algorithm: "aes_256_gcm",
 *       purpose: "symmetric_encrypt_decrypt",
 *     }),
 *   ),
 * );
 *
 * export default class Api extends Stackit.CloudFoundry.App<Api>()(
 *   "Api",
 *   Effect.gen(function* () {
 *     const deployer = yield* Deployer;
 *     return {
 *       ...deployer,
 *       main: import.meta.url,
 *       registry: { repository: "ghcr.io/my-org/api" },
 *     };
 *   }),
 *   Effect.gen(function* () {
 *     // init
 *     const encrypt = yield* Stackit.KMS.Encrypt(yield* DataKey);
 *     return {
 *       // runtime
 *       fetch: Effect.gen(function* () {
 *         const { ciphertext, version } = yield* encrypt({
 *           plaintext: Redacted.make(new TextEncoder().encode("hello")),
 *         });
 *         return yield* HttpServerResponse.json({ ciphertext: Array.from(ciphertext), version });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.KMS.EncryptHttp)),
 * ) {}
 * ```
 *
 * @resource
 * @product STACKIT Cloud Foundry
 * @category CloudFoundry
 */
export const App: Platform<App, AppServices, AppShape, AppRuntimeContext> & {
  /**
   * Async (no-impl) constructor: captures the `env` literal so `InferEnv` types the
   * handler's second argument.
   */
  <const Env extends Record<string, any>, PropsReq = never>(
    id: string,
    props: InputProps<AppProps<Env>> | Effect.Effect<InputProps<AppProps<Env>>, never, PropsReq>,
  ): Effect.Effect<App<Env>, never, Providers | PropsReq>;
} = Platform("Stackit.CloudFoundry.App", {
  createRuntimeContext: createRawEnvRuntimeContext("Stackit.CloudFoundry.App"),
});

/** The app declares neither `main` nor `image`. */
export class AppSourceRequired extends Data.TaggedError("Stackit.CloudFoundry.AppSourceRequired")<{
  readonly resourceName: string;
  readonly message: string;
}> {}

/** The app builds from `main` but has nowhere to push the image. */
export class AppRegistryRequired extends Data.TaggedError(
  "Stackit.CloudFoundry.AppRegistryRequired",
)<{
  readonly resourceName: string;
  readonly message: string;
}> {}

const WEB_PROCESS = "web";

const toName = (id: string, name: string | undefined) =>
  name !== undefined
    ? Effect.succeed(name)
    : createPhysicalName({ id, lowercase: true, maxLength: CF_NAME_MAX_LENGTH });

const toHost = (id: string, host: string | undefined) =>
  host !== undefined
    ? Effect.succeed(host)
    : createPhysicalName({ id, lowercase: true, maxLength: CF_HOST_MAX_LENGTH });

const imageSourceOf = (news: AppProps, main: string) =>
  hostImageSource({
    props: news,
    main,
    port: APP_PORT,
    resourceType: "Stackit.CloudFoundry.App",
  });

/**
 * Resolve the image the app runs. Built images are pushed and pinned by digest, unless the
 * deployed app already runs this exact program.
 */
const resolveImage = Effect.fn(function* (args: {
  id: string;
  news: AppProps;
  output: AppAttributes | undefined;
  session: { note: (message: string) => Effect.Effect<void> };
}) {
  const { id, news, output, session } = args;
  if (news.main === undefined) {
    if (news.image === undefined) {
      return yield* new AppSourceRequired({
        resourceName: id,
        message: `${id}: a Stackit.CloudFoundry.App needs \`main\` or \`image\``,
      });
    }
    return { image: news.image, codeHash: undefined };
  }
  const registry = news.registry;
  if (registry === undefined) {
    return yield* new AppRegistryRequired({
      resourceName: id,
      message: `${id}: \`main\` builds an image, so it needs \`registry\` to push it to`,
    });
  }
  return yield* pushHostImage({
    id,
    source: imageSourceOf(news, news.main),
    registry,
    deployed: output,
    session,
  });
});

/** The desired variables as plain text: the API takes nothing else. */
const desiredEnv = Effect.fn(function* (
  news: AppProps,
  bindings: ReadonlyArray<ResourceBinding<HostBinding>>,
) {
  const external = news.isExternal === true || news.main === undefined;
  const env = yield* hostEnv(news, bindings, external);
  return Object.fromEntries(
    Object.entries(env).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, hostEnvVariable(name, value, external)] as const],
    ),
  );
});

/** Variables the API answered, as plain text. Compare them; never log them. */
const plainEnv = (
  variables: { readonly [key: string]: string | Redacted.Redacted<string> | undefined } | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(variables ?? {}).flatMap(([name, value]) =>
      value === undefined
        ? []
        : [[name, Redacted.isRedacted(value) ? Redacted.value(value) : value] as const],
    ),
  );

const getAppOrUndefined = (guid: string) =>
  cf.getApp({ guid }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/** Apps of that name in a space, in the shape {@link findOwnedByName} takes. */
const appsNamed = (spaceId: string, name: string) =>
  collectCloudFoundryItems(
    cf.listApps.items({ per_page: 100, space_guids: spaceId, names: name }),
  ).pipe(Effect.map((apps) => apps.map((app) => ({ ...app, labels: observedLabels(app) }))));

const currentDroplet = (guid: string) =>
  cf.getCurrentDropletForApp({ guid }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/** Stage an image into a droplet: a Docker package, and a build of it. */
const stageImage = Effect.fn(function* (args: {
  appId: string;
  name: string;
  image: string;
  login: AppProps["imageCredentials"];
}) {
  const { appId, name, image, login } = args;
  const created = yield* cf.createPackage({
    type: "docker",
    data: {
      image,
      ...(login !== undefined ? { username: login.username, password: login.password } : {}),
    },
    relationships: { app: relationTo(appId) },
  });
  const packageId = yield* requireGuid(`a package of app ${name}`, created);
  yield* waitFor({
    resource: `Cloud Foundry package of app ${name}`,
    read: cf.getPackage({ guid: packageId }),
    ready: (observed) => observed.state === "READY",
    failed: (observed) =>
      observed.state === "FAILED" || observed.state === "EXPIRED"
        ? (observed.data?.error ?? observed.state)
        : undefined,
    state: (observed) => observed.state,
    timeout: BUILD_TIMEOUT,
  });
  const build = yield* cf.createBuild({ package: { guid: packageId } });
  const buildId = yield* requireGuid(`a build of app ${name}`, build);
  const staged = yield* waitFor({
    resource: `Cloud Foundry build of app ${name}`,
    read: cf.getBuild({ guid: buildId }),
    ready: (observed) => observed.state === "STAGED",
    failed: (observed) =>
      observed.state === "FAILED" ? (observed.error ?? observed.state) : undefined,
    state: (observed) => observed.state,
    timeout: BUILD_TIMEOUT,
  });
  return yield* requireGuid(`the droplet of app ${name}`, staged.droplet ?? {});
});

/**
 * Roll the app's instances to a droplet, one at a time. Without a droplet it reuses the
 * current one, which picks up new variables and limits.
 */
const rollOut = Effect.fn(function* (appId: string, name: string, dropletId: string | undefined) {
  const deployment = yield* cf.createDeployment({
    relationships: { app: relationTo(appId) },
    strategy: "rolling",
    ...(dropletId !== undefined ? { droplet: { guid: dropletId } } : {}),
  });
  const deploymentId = yield* requireGuid(`a deployment of app ${name}`, deployment);
  yield* waitFor({
    resource: `Cloud Foundry deployment of app ${name}`,
    read: cf.getDeployment({ guid: deploymentId }),
    ready: (observed) =>
      observed.status?.value === "FINALIZED" && observed.status.reason === "DEPLOYED",
    failed: (observed) =>
      observed.status?.value === "FINALIZED" && observed.status.reason !== "DEPLOYED"
        ? (observed.status.reason ?? "FINALIZED")
        : undefined,
    state: (observed) => observed.status?.reason,
    timeout: DEPLOYMENT_TIMEOUT,
    maxInterval: "15 seconds",
  });
});

/** Wait for an instance to run. All of them crashing is the app's failure, not a wait. */
const waitForRunning = (appId: string, name: string) =>
  waitFor({
    resource: `Cloud Foundry app ${name}`,
    read: cf.getProcessStatsForApp({ guid: appId, type: WEB_PROCESS }),
    ready: (stats) => (stats.resources ?? []).some((instance) => instance.state === "RUNNING"),
    failed: (stats) => {
      const instances = stats.resources ?? [];
      return instances.length > 0 && instances.every((instance) => instance.state === "CRASHED")
        ? "every instance crashed"
        : undefined;
    },
    state: (stats) => (stats.resources ?? []).map((instance) => instance.state).join(","),
    timeout: APP_START_TIMEOUT,
  });

/** Bind one service instance, unless it is, and wait for the broker. */
const ensureServiceBinding = Effect.fn(function* (appId: string, serviceInstanceId: string) {
  const listed = yield* collectCloudFoundryItems(
    cf.listServiceCredentialBindings.items({
      per_page: 100,
      type: "app",
      app_guids: appId,
      service_instance_guids: serviceInstanceId,
    }),
  );
  let binding = listed[0];
  let created = false;
  if (binding === undefined) {
    const answered = yield* cf.createServiceCredentialBinding({
      type: "app",
      relationships: {
        service_instance: relationTo(serviceInstanceId),
        app: relationTo(appId),
      },
    });
    yield* awaitJob(`binding of service instance ${serviceInstanceId}`, answered.location);
    created = true;
    const after = yield* collectCloudFoundryItems(
      cf.listServiceCredentialBindings.items({
        per_page: 100,
        type: "app",
        app_guids: appId,
        service_instance_guids: serviceInstanceId,
      }),
    );
    binding = after[0];
  }
  const bindingId = yield* requireGuid(
    `the binding of service instance ${serviceInstanceId}`,
    binding ?? {},
  );
  yield* waitFor({
    resource: `Cloud Foundry binding of service instance ${serviceInstanceId}`,
    read: cf.getServiceCredentialBinding({ guid: bindingId }),
    ready: (observed) =>
      observed.last_operation === undefined || observed.last_operation.state === "succeeded",
    failed: (observed) =>
      observed.last_operation?.state === "failed"
        ? (observed.last_operation.description ?? "failed")
        : undefined,
    state: (observed) => observed.last_operation?.state,
    timeout: JOB_TIMEOUT,
  });
  return { bindingId, created };
});

const removeServiceBinding = (bindingId: string) =>
  Effect.gen(function* () {
    const deleted = yield* cf
      .deleteServiceCredentialBinding({ guid: bindingId })
      .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
    if (deleted !== undefined) {
      yield* awaitJob(`service binding ${bindingId} delete`, deleted.location);
    }
  });

const toAttrs = (args: {
  app: {
    readonly name?: string;
    readonly state?: string;
    readonly metadata?: { readonly labels?: unknown } | undefined;
  };
  appId: string;
  spaceId: string;
  route: { readonly routeId: string; readonly host: string; readonly domain: string } | undefined;
  image: string | undefined;
  codeHash: string | undefined;
  dropletId: string | undefined;
  instances: number | undefined;
  memoryInMb: number | undefined;
  envNames: string[];
  serviceBindings: Record<string, string>;
}): AppAttributes => ({
  appId: args.appId,
  name: args.app.name ?? "",
  spaceId: args.spaceId,
  state: args.app.state ?? "",
  url: args.route === undefined ? undefined : `https://${args.route.host}.${args.route.domain}`,
  routeId: args.route?.routeId,
  host: args.route?.host,
  domain: args.route?.domain,
  image: args.image,
  codeHash: args.codeHash,
  dropletId: args.dropletId,
  instances: args.instances,
  memoryInMb: args.memoryInMb,
  envNames: args.envNames,
  serviceBindings: args.serviceBindings,
  labels: stripInternalLabels(observedLabels(args.app)),
});

export const AppProvider = () =>
  Provider.succeed(App, {
    stables: ["appId", "spaceId"],
    nuke: { dependsOn: ["Stackit.CloudFoundry.Space"] },

    // Listing needs Cloud Foundry credentials, which nuke doesn't have and only state
    // holds. Apps go with their space.
    list: () => Effect.succeed([]),

    diff: Effect.fn(function* ({ news: desired, output }) {
      if (output === undefined) return undefined;
      // A chosen host can't exist twice on a domain, whichever space holds it, and the old app's
      // route still holds it until the old app goes. A generated host carries the generation.
      const keepsHost =
        rawProp<AppProps>(desired, "host") !== undefined &&
        rawProp<AppProps>(desired, "noRoute") !== true;
      // An unresolved space can resolve to the one the app is in, and an explicit name
      // can't exist twice there. A generated name carries the generation.
      if (hasUnresolvedTrigger<AppProps>(desired, ["spaceId"])) {
        return {
          action: "replace",
          deleteFirst: keepsHost || rawProp<AppProps>(desired, "name") !== undefined,
        } as const;
      }
      if (triggerProps<AppProps>(desired).spaceId !== output.spaceId) {
        return { action: "replace", deleteFirst: keepsHost } as const;
      }
      // Runtime exports are covered by the bundle hash, not infrastructure inputs.
      const news = stripEffects(desired);
      if (news === undefined || !isResolved(news)) return undefined;
      // A code-only change leaves the props untouched: hash the program so it still
      // surfaces as an update.
      if (news.main !== undefined) {
        const images = yield* makeContainerImageSource;
        const hash = yield* images.hash(imageSourceOf(news as AppProps, news.main));
        if (hash !== output.codeHash) return { action: "update" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output, previous }) {
      if (!usableCredentials(olds?.credentials)) return undefined;
      const spaceId = output?.spaceId ?? olds.spaceId;
      const name = output?.name ?? (yield* toName(id, olds.name));
      return yield* Effect.gen(function* () {
        let app: (cf.GetAppResponse & { readonly labels?: unknown }) | undefined =
          output?.appId !== undefined ? yield* getAppOrUndefined(output.appId) : undefined;
        if (app === undefined) {
          const found = yield* appsNamed(spaceId, name);
          app = yield* findOwnedByName(id, name, found, {
            instanceId: readGeneration({ instanceId, output, previous }),
          });
          // A foreign app at the explicit name this resource would create.
          if (app === undefined && output === undefined && previous === undefined) {
            app = found.find((candidate) => candidate.name === name);
          }
        }
        if (app?.guid === undefined) return undefined;
        const attrs = toAttrs({
          app,
          appId: app.guid,
          spaceId,
          route:
            output?.routeId !== undefined &&
            output.host !== undefined &&
            output.domain !== undefined
              ? { routeId: output.routeId, host: output.host, domain: output.domain }
              : undefined,
          image: output?.image,
          codeHash: output?.codeHash,
          dropletId: output?.dropletId,
          instances: output?.instances,
          memoryInMb: output?.memoryInMb,
          envNames: output?.envNames ?? [],
          serviceBindings: output?.serviceBindings ?? {},
        });
        return (yield* hasAlchemyLabels(id, observedLabels(app))) ? attrs : Unowned(attrs);
      }).pipe(withCloudFoundry(id, olds.credentials));
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, olds, output, bindings, session }) {
      const { spaceId, credentials } = news;
      const name = yield* toName(id, news.name);
      const labels = yield* desiredGenerationLabels(id, instanceId, news.labels);
      const env = yield* desiredEnv(news, bindings as ReadonlyArray<ResourceBinding<HostBinding>>);
      const host = news.noRoute === true ? undefined : yield* toHost(id, news.host);

      // Build first, so a bad image or a failed build creates nothing.
      const { image, codeHash } = yield* resolveImage({ id, news, output, session });
      const login =
        news.imageCredentials ??
        (news.registry?.username !== undefined && news.registry.password !== undefined
          ? { username: news.registry.username, password: news.registry.password }
          : undefined);

      return yield* Effect.gen(function* () {
        // 1. Observe. `output` is a cache, and its id only counts in this space.
        const known = output?.spaceId === spaceId ? output : undefined;
        let app: cf.GetAppResponse | undefined =
          known !== undefined ? yield* getAppOrUndefined(known.appId) : undefined;
        // Crash recovery: this generation's labels and name.
        if (app === undefined) {
          const found = yield* appsNamed(spaceId, name);
          app = yield* findOwnedByName(id, name, found, { instanceId });
        }

        // 2. Ensure
        if (app === undefined) {
          app = yield* cf.createApp({
            name,
            relationships: { space: relationTo(spaceId) },
            lifecycle: { type: "docker", data: {} },
            metadata: { labels },
          });
        }
        const appId = yield* requireGuid(`app ${name}`, app);

        // 3. Sync name and labels against the observed app.
        const labelChanges = labelUpdate(observedLabels(app), labels, olds?.labels);
        if (app.name !== name || labelChanges !== undefined) {
          app = yield* cf.updateApp({
            guid: appId,
            ...(app.name !== name ? { name } : {}),
            ...(labelChanges !== undefined ? { metadata: { labels: labelChanges } } : {}),
          });
        }

        // Anything the running instances only read when they start sets this.
        let needsRollout = false;

        // Sync variables against the observed ones, and remove only what this resource set.
        const liveEnv = yield* cf.getEnvironmentVariablesForApp({ guid: appId });
        const observedEnv = plainEnv(liveEnv.var);
        const envDelta: Record<string, string | null> = {};
        for (const [key, value] of Object.entries(env)) {
          if (observedEnv[key] !== value) envDelta[key] = value;
        }
        for (const key of known?.envNames ?? []) {
          if (!(key in env) && key in observedEnv) envDelta[key] = null;
        }
        if (Object.keys(envDelta).length > 0) {
          yield* cf.updateEnvironmentVariablesForApp({ guid: appId, var: envDelta });
          needsRollout = true;
        }

        // Sync service bindings. Only those this resource created are removed.
        const serviceBindings: Record<string, string> = {};
        for (const serviceInstanceId of news.services ?? []) {
          const { bindingId, created } = yield* ensureServiceBinding(appId, serviceInstanceId);
          serviceBindings[serviceInstanceId] = bindingId;
          needsRollout = needsRollout || created;
        }
        for (const [serviceInstanceId, bindingId] of Object.entries(known?.serviceBindings ?? {})) {
          if (serviceInstanceId in serviceBindings) continue;
          yield* removeServiceBinding(bindingId);
          needsRollout = true;
        }

        // Sync the web process: scale and health check against the observed process.
        const webProcess = yield* cf.getProcessForApp({ guid: appId, type: WEB_PROCESS });
        const resized =
          (news.memoryInMb !== undefined && webProcess.memory_in_mb !== news.memoryInMb) ||
          (news.diskInMb !== undefined && webProcess.disk_in_mb !== news.diskInMb);
        if (resized || (news.instances !== undefined && webProcess.instances !== news.instances)) {
          yield* cf.scaleProcessForApp({
            guid: appId,
            type: WEB_PROCESS,
            ...(news.instances !== undefined ? { instances: news.instances } : {}),
            ...(news.memoryInMb !== undefined ? { memory_in_mb: news.memoryInMb } : {}),
            ...(news.diskInMb !== undefined ? { disk_in_mb: news.diskInMb } : {}),
          });
          needsRollout = needsRollout || resized;
        }
        const health = news.healthCheck;
        if (
          health !== undefined &&
          (webProcess.health_check?.type !== health.type ||
            (health.type === "http" && webProcess.health_check?.data?.endpoint !== health.endpoint))
        ) {
          const processId = yield* requireGuid(`the web process of app ${name}`, webProcess);
          yield* cf.updateProcess({
            guid: processId,
            health_check: {
              type: health.type,
              ...(health.endpoint !== undefined ? { data: { endpoint: health.endpoint } } : {}),
            },
          });
          needsRollout = true;
        }

        // Sync the route: the desired one, and the removal of the one this resource made.
        let route:
          | { readonly routeId: string; readonly host: string; readonly domain: string }
          | undefined;
        if (host !== undefined) {
          const domain = yield* resolveDomain(id, news.domain);
          const liveRoute =
            (known?.routeId !== undefined && known.host === host && known.domain === domain.domain
              ? yield* getRouteOrUndefined(known.routeId)
              : undefined) ??
            (yield* findOwnRoute({
              id,
              instanceId,
              spaceId,
              domainId: domain.domainId,
              host,
              path: undefined,
            })) ??
            (yield* cf.createRoute({
              host,
              relationships: {
                space: relationTo(spaceId),
                domain: relationTo(domain.domainId),
              },
              metadata: { labels },
            }));
          const routeId = yield* requireGuid(`the route of app ${name}`, liveRoute);
          yield* ensureDestination(routeId, appId);
          route = { routeId, host, domain: domain.domain };
        }
        if (known?.routeId !== undefined && known.routeId !== route?.routeId) {
          yield* deleteRouteAndWait(`Cloud Foundry route of app ${name}`, known.routeId);
        }

        // Sync the droplet: stage only when the observed one runs another image.
        const droplet = yield* currentDroplet(appId);
        const stagedId =
          droplet?.image === image && droplet.guid !== undefined
            ? undefined
            : yield* stageImage({ appId, name, image, login });
        const dropletId = stagedId ?? droplet?.guid;

        // Start or roll: a stopped app takes the droplet directly. A started one rolls, so
        // the old instances serve until the new ones are healthy.
        if (app.state === "STARTED" && droplet !== undefined) {
          if (stagedId !== undefined || needsRollout) yield* rollOut(appId, name, stagedId);
        } else {
          if (stagedId !== undefined) {
            yield* cf.setCurrentDropletForApp({
              guid: appId,
              data: { guid: stagedId },
            });
          }
          yield* cf.startApp({ guid: appId });
        }
        // 4. Return. An app parked at no instances has nothing to wait for.
        const finalProcess = yield* cf.getProcessForApp({ guid: appId, type: WEB_PROCESS });
        if (finalProcess.instances !== 0) yield* waitForRunning(appId, name);
        const settled = yield* cf.getApp({ guid: appId });
        return toAttrs({
          app: settled,
          appId,
          spaceId,
          route,
          image,
          codeHash,
          dropletId,
          instances: finalProcess.instances,
          memoryInMb: finalProcess.memory_in_mb ?? undefined,
          envNames: Object.keys(env),
          serviceBindings,
        });
      }).pipe(withCloudFoundry(id, credentials));
    }),

    delete: Effect.fn(function* ({ id, olds, output }) {
      const resource = `Cloud Foundry app ${output.name}`;
      yield* Effect.gen(function* () {
        const deleted = yield* cf
          .deleteApp({ guid: output.appId })
          .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
        if (deleted !== undefined) yield* awaitJob(`${resource} delete`, deleted.location);
        yield* waitUntilGone({
          resource,
          read: getAppOrUndefined(output.appId),
          state: (app) => app.state,
          timeout: JOB_TIMEOUT,
        });
        // The route this resource made, which outlives the app otherwise.
        if (output.routeId !== undefined) {
          yield* deleteRouteAndWait(`Cloud Foundry route of app ${output.name}`, output.routeId);
        }
      }).pipe(withCloudFoundry(id, olds.credentials));
    }),
  });
