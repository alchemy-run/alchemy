import { makeContainerImageSource } from "@alchemy.run/docker/ImageSource";
import * as sca from "@distilled.cloud/stackit/sca";
import { Unowned } from "alchemy/AdoptPolicy";
import type * as Bundle from "alchemy/Bundle/Bundle";
import { isResolved, stripEffects } from "alchemy/Diff";
import type { InputProps } from "alchemy/Input";
import { createPhysicalName } from "alchemy/PhysicalName";
import { Platform, type Main, type PlatformProps } from "alchemy/Platform";
import * as Provider from "alchemy/Provider";
import type { Resource, ResourceBinding } from "alchemy/Resource";
import type { HostRuntimeContext, ServerHost } from "alchemy/Runtime/Process";
import { sha256Object } from "alchemy/Util/sha256";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { StackitEnvironment } from "../Environment.ts";
import { resolveProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { secretsDiffer } from "../internal/equal.ts";
import { isGeneratedPhysicalName } from "../internal/names.ts";
import {
  createRawEnvRuntimeContext,
  hostEnv,
  hostEnvVariable,
  hostImageSource,
  type HostRegistry,
  pushHostImage,
} from "../internal/serverHost.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import type { HostBinding } from "../StackitBindings.ts";
import {
  APPLICATION_DELETE_TIMEOUT,
  APPLICATION_NAME_MAX_LENGTH,
  APPLICATION_TIMEOUT,
  ContainerApplicationsIdMissing,
  DEFAULT_APPLICATION_PORT,
  ensureContainerApplicationsEnabled,
  type EnvironmentScope,
  findApplicationByName,
  getApplicationOrUndefined,
  removeSecretKeys,
  withSecretLock,
} from "./internal.ts";

export type { InferEnv } from "../InferEnv.ts";

/** One autoscaling trigger. */
export type ApplicationScaleRule =
  | {
      /** Name of the rule. */
      name: string;
      /** Scale on HTTP traffic. */
      http: {
        /** Target requests in flight per instance. */
        concurrency?: number;
        /** Target requests per second per instance. */
        rps?: number;
      };
    }
  | {
      /** Name of the rule. */
      name: string;
      /** Scale on a KEDA scaler. */
      custom: {
        /** KEDA scaler type, e.g. `rabbitmq`. */
        type: string;
        /** Scaler metadata, by parameter name. */
        parameters?: Record<string, string>;
        /** Scaler parameters to read from an environment secret: parameter name to secret key. */
        secrets?: Record<string, string>;
      };
    };

/** How many instances run. */
export type ApplicationScaling =
  | {
      /** Scale between a minimum and a maximum on {@link rules}. */
      type: "auto";
      /**
       * Fewest instances.
       * @default 0
       */
      minInstances?: number;
      /**
       * Most instances.
       * @default 1
       */
      maxInstances?: number;
      /**
       * Whether the application may scale to zero.
       * @default true when `minInstances` is 0
       */
      allowScaleToZero?: boolean;
      /**
       * What it scales on.
       * @default one HTTP rule with a target of 10 requests in flight per instance
       */
      rules?: ApplicationScaleRule[];
    }
  | {
      /** Run a fixed number of instances. */
      type: "manual";
      /** Number of instances. */
      instances: number;
    };

/** A container of an application, for anything other than the one `main` or `image` declares. */
export interface ApplicationContainer {
  /** Name of the container, unique in the application. */
  name: string;
  /** Image to run. */
  image: string;
  /** Overrides the image's command. */
  command?: string[];
  /** Overrides the image's arguments. */
  args?: string[];
  /** CPU limit. The spec gives no unit; its example is `1000`. */
  cpu?: number;
  /** Memory limit. The spec gives no unit; its example is `1024`. */
  memory?: number;
  /**
   * Environment variables. A `Redacted` value is kept in the environment's secrets, and
   * the application only references it.
   */
  env?: Record<string, string | Redacted.Redacted<string>>;
  /** Environment variables to read from an environment secret: variable name to secret key. */
  secrets?: Record<string, string>;
}

/** Who can reach the application from the internet. */
export interface ApplicationPublicNetwork {
  /** Whether the application has a public domain. */
  enabled: boolean;
  /**
   * Port the application listens on. Alchemy tells a program built from `main` to use it.
   * @default 8080
   */
  port?: number;
  /** CIDR ranges allowed in and out. */
  accessControl?: {
    /** IPv4 CIDR ranges allowed to reach the application. */
    ingress?: string[];
    /** IPv4 CIDR ranges the application may talk to. */
    egress?: string[];
  };
}

/** Who can reach the application from inside its environment. */
export interface ApplicationInternalNetwork {
  /** Whether the application has an internal domain. */
  enabled: boolean;
  /** Port to expose it on. */
  port?: number;
}

/** How the application is reached. */
export interface ApplicationNetwork {
  /**
   * Public networking.
   * @default { enabled: true, port: 8080 }
   */
  public?: ApplicationPublicNetwork;
  /**
   * Networking inside the environment.
   * @default { enabled: false }
   */
  internal?: ApplicationInternalNetwork;
}

export interface ApplicationProps<
  Env extends Record<string, any> = Record<string, any>,
> extends PlatformProps {
  /**
   * Environment to run in, usually a `Stackit.ContainerApplications.Environment`'s
   * `environmentId`. Changing it replaces the application.
   */
  environmentId: string;
  /**
   * Name of the application. Updates in place. If omitted, a unique name is generated from
   * the stack, stage and logical ID.
   */
  displayName?: string;
  /**
   * Module to run. On an effectful Application this is `import.meta.url`: the file is
   * both the bundle entry and the program. On an async Application it is a file exporting
   * `{ fetch(request, env) }`, which is bundled with no Effect runtime.
   *
   * Either way, Alchemy builds a bun image with Docker on the deploying machine and
   * pushes it to {@link registry}, which `main` requires.
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
   * Name of the container that {@link main} or {@link image} declares.
   *
   * @default "app"
   */
  containerName?: string;
  /** Overrides that container's command. */
  command?: string[];
  /** Overrides that container's arguments. */
  args?: string[];
  /** CPU limit of that container. The spec gives no unit; its example is `1000`. */
  cpu?: number;
  /** Memory limit of that container. The spec gives no unit; its example is `1024`. */
  memory?: number;
  /**
   * Environment variables of that container, or of the first of {@link containers} if
   * there is none. A `Redacted` value is kept in the environment's secrets, and the
   * application only references it.
   *
   * On an async Application, {@link InferEnv} types the handler's second argument from
   * these keys, and each value arrives as a `string`.
   */
  env?: Env;
  /**
   * Environment variables to read from a `Stackit.ContainerApplications.EnvironmentSecret`:
   * variable name to secret key. {@link InferEnv} doesn't see these.
   */
  secrets?: Record<string, string>;
  /**
   * More containers next to the one {@link main} or {@link image} declares, or all of
   * them if neither is set.
   */
  containers?: ApplicationContainer[];
  /**
   * How many instances run.
   *
   * @default up to one instance, scaling to zero on HTTP. A program with an event source or
   * another background loop can't scale to zero, so it defaults to exactly one.
   */
  scaling?: ApplicationScaling;
  /** How the application is reached. */
  network?: ApplicationNetwork;
  /**
   * Stop the application, keeping its configuration.
   *
   * @default false
   */
  stopped?: boolean;
  /** Project of the environment. Defaults to the profile's project. Changing it replaces the application. */
  projectId?: string;
  /** Region of the environment. Defaults to the profile's region. Changing it replaces the application. */
  region?: string;
}

export interface ApplicationAttributes {
  /** STACKIT id of the application. Stable across updates. */
  applicationId: string;
  /** Environment the application runs in. */
  environmentId: string;
  /** Project of the environment. */
  projectId: string;
  /** Region of the environment. */
  region: string;
  /** Name of the application. */
  displayName: string;
  /** Public URL of the application, if it has one: `https://` and its default domain. */
  url: string | undefined;
  /** Domain the application has inside its environment, if it has one. */
  internalDomain: string | undefined;
  /** The API's status, e.g. `CURRENT_STATUS_RUNNING`, or `CURRENT_STATUS_IDLE` at zero. */
  status: string | undefined;
  /** Instances when the application was last read. */
  instances: { name: string | undefined; status: string | undefined }[];
  /** When the application was last deployed, in RFC 3339. */
  lastDeployment: string | undefined;
  /** When the application was created, in RFC 3339. */
  createdAt: string | undefined;
  /** When the application last changed, in RFC 3339. */
  updatedAt: string | undefined;
  /** Image of its first container. */
  image: string | undefined;
  /** Content hash of the program built from `main`; undefined for an `image`. */
  codeHash: string | undefined;
  /** Environment secrets Alchemy keeps for this application's `Redacted` values. */
  stagedSecrets: string[];
}

export type Application<Env extends Record<string, any> = Record<string, any>> = Resource<
  "Stackit.ContainerApplications.Application",
  ApplicationProps<Env>,
  ApplicationAttributes,
  HostBinding,
  Providers
>;

export type ApplicationServices = ServerHost;
export type ApplicationShape = Main<ApplicationServices>;
export type ApplicationRuntimeContext = HostRuntimeContext;

/** Marks a program that registered a background loop, for {@link desiredScaling}. */
const BACKGROUND_WORK_ENV = "ALCHEMY_STACKIT_BACKGROUND_WORK";

/**
 * Note when the program registers a background loop through `ServerHost`, such as an
 * event source. That has to reach `reconcile`, where the host's scaling is decided, and
 * env is the way anything goes from a host's context to its props.
 */
const createApplicationRuntimeContext =
  (type: string) =>
  (id: string): ApplicationRuntimeContext => {
    const base = createRawEnvRuntimeContext(type)(id);
    const run = base.run;
    return Object.assign(base, {
      run: ((effect: Effect.Effect<void, never, any>) =>
        Effect.suspend(() => {
          base.env[BACKGROUND_WORK_ENV] = "true";
          return run(effect);
        })) as typeof base.run,
    });
  };

/**
 * A STACKIT Container Application: a managed container with autoscaling, a generated public
 * domain, and optional scale to zero: STACKIT's Platform as a Service.
 *
 * It ships in two forms, both built from `main` into a bun image with Docker on the deploying
 * machine and pushed to `registry`. Or pass a pre-built `image` instead of `main`.
 *
 * Changing `environmentId`, `projectId` or `region` replaces the application; everything else
 * updates in place. Deploys wait until the application is running, idle at zero, or stopped,
 * and a failure names the application's events. Destroys wait until it is gone.
 *
 * :::caution[Beta API]
 * Container Applications is a beta API, available in `eu01` only. STACKIT documents no
 * container contract, so Alchemy assumes `linux/amd64` images until that can be checked
 * against a live account.
 * :::
 *
 * :::caution[Environments can't be deleted]
 * An application lives in a `Stackit.ContainerApplications.Environment`, and the API can't
 * delete one. Destroying a stack removes its applications and leaves the environment.
 * :::
 *
 * :::caution[Ownership]
 * The API has no labels, and nothing else can carry an ownership marker without changing what
 * runs. A generated `displayName` is what says an application is this resource's. One with
 * your own `displayName`, found with no state, is reported as unowned and only taken over with
 * `--adopt`, and the same goes after a crash between creating it and saving state.
 * :::
 *
 * ### Async Applications
 * You don't have to use Effect. Pass `main` pointing at a file and no implementation. Alchemy
 * bundles that file as-is, serves its `fetch` from a small server in the image, and passes the
 * environment as the second argument. `InferEnv` types it.
 *
 * **Example:** Defining an async Application in your stack
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 *
 * export const Apps = Stackit.ContainerApplications.Environment("Apps", {});
 *
 * export const Ping = Effect.gen(function* () {
 *   const apps = yield* Apps;
 *   return yield* Stackit.ContainerApplications.Application("Ping", {
 *     environmentId: apps.environmentId,
 *     main: "./src/ping.ts",
 *     registry: { repository: "ghcr.io/my-org/ping" },
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
 * ### Effect-native Applications
 * An Application is a class. Props describe the application, and the Effect is the program that
 * runs in it. `main: import.meta.url` makes the file the bundle entry. Construction binds
 * resources, and the returned handlers run per request.
 *
 * **Example:** A class with a `fetch` handler
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Apps = Stackit.ContainerApplications.Environment("Apps", {});
 *
 * export default class Api extends Stackit.ContainerApplications.Application<Api>()(
 *   "Api",
 *   Effect.gen(function* () {
 *     const apps = yield* Apps;
 *     return {
 *       main: import.meta.url,
 *       environmentId: apps.environmentId,
 *       registry: { repository: "ghcr.io/my-org/api" },
 *     };
 *   }),
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("hello")),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * ### Choosing the image
 * When Alchemy builds the image it pins the application to the digest the push reported. A
 * private image needs a `Stackit.ContainerApplications.EnvironmentRegistry` in the environment.
 *
 * **Example:** Run a public image
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const apps = yield* Stackit.ContainerApplications.Environment("Apps", {});
 * const web = yield* Stackit.ContainerApplications.Application("Web", {
 *   environmentId: apps.environmentId,
 *   image: "nginxinc/nginx-unprivileged",
 * });
 * ```
 *
 * **Example:** Push to a STACKIT Container Registry project, and pull with a robot
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Output from "alchemy/Output";
 * import * as Config from "effect/Config";
 *
 * const credentials = {
 *   username: Config.String("HARBOR_USERNAME"),
 *   secret: Config.Redacted("HARBOR_CLI_SECRET"),
 * };
 * const apps = yield* Stackit.ContainerApplications.Environment("Apps", {});
 * const images = yield* Stackit.ContainerRegistry.Project("Images", {});
 * const pusher = yield* Stackit.ContainerRegistry.RobotAccount("Pusher", {
 *   project: images.name,
 *   registryUrl: images.url,
 *   credentials,
 * });
 * const puller = yield* Stackit.ContainerRegistry.RobotAccount("Puller", {
 *   project: images.name,
 *   registryUrl: images.url,
 *   credentials,
 *   permissions: [{ resource: "repository", action: "pull" }],
 * });
 * const login = yield* Stackit.ContainerApplications.EnvironmentRegistry("Images", {
 *   environmentId: apps.environmentId,
 *   server: images.registryHost,
 *   username: puller.robotName,
 *   password: puller.secret,
 * });
 * const api = yield* Stackit.ContainerApplications.Application("Api", {
 *   environmentId: login.environmentId,
 *   main: "./src/api.ts",
 *   registry: {
 *     repository: Output.interpolate`${images.imagePrefix}/api`,
 *     username: pusher.robotName,
 *     password: pusher.secret,
 *   },
 * });
 * ```
 *
 * **Example:** A custom base image for the program
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const apps = yield* Stackit.ContainerApplications.Environment("Apps", {});
 * const api = yield* Stackit.ContainerApplications.Application("Api", {
 *   environmentId: apps.environmentId,
 *   main: "./src/api.ts",
 *   image: "oven/bun:1-slim",
 *   registry: { repository: "ghcr.io/my-org/api" },
 * });
 * ```
 *
 * **Example:** Several containers
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const apps = yield* Stackit.ContainerApplications.Environment("Apps", {});
 * const app = yield* Stackit.ContainerApplications.Application("Proxy", {
 *   environmentId: apps.environmentId,
 *   image: "ghcr.io/my-org/api:v1.0.0",
 *   containers: [{ name: "proxy", image: "ghcr.io/my-org/proxy:v1.0.0", cpu: 250, memory: 256 }],
 * });
 * ```
 *
 * ### Scaling
 * By default an application runs at most one instance and may scale to zero.
 *
 * **Example:** Scale between two and five instances on requests per second
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const apps = yield* Stackit.ContainerApplications.Environment("Apps", {});
 * const api = yield* Stackit.ContainerApplications.Application("Api", {
 *   environmentId: apps.environmentId,
 *   image: "ghcr.io/my-org/api:v1.0.0",
 *   scaling: {
 *     type: "auto",
 *     minInstances: 2,
 *     maxInstances: 5,
 *     rules: [{ name: "traffic", http: { rps: 10 } }],
 *   },
 * });
 * ```
 *
 * **Example:** A fixed number of instances
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const apps = yield* Stackit.ContainerApplications.Environment("Apps", {});
 * const api = yield* Stackit.ContainerApplications.Application("Api", {
 *   environmentId: apps.environmentId,
 *   image: "ghcr.io/my-org/api:v1.0.0",
 *   scaling: { type: "manual", instances: 2 },
 * });
 * ```
 *
 * ### Networking
 * **Example:** Reachable only from an office, on another port
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const apps = yield* Stackit.ContainerApplications.Environment("Apps", {});
 * const api = yield* Stackit.ContainerApplications.Application("Api", {
 *   environmentId: apps.environmentId,
 *   image: "ghcr.io/my-org/api:v1.0.0",
 *   network: {
 *     public: { enabled: true, port: 3000, accessControl: { ingress: ["203.0.113.0/24"] } },
 *   },
 * });
 * ```
 *
 * **Example:** A service only its environment can reach
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const apps = yield* Stackit.ContainerApplications.Environment("Apps", {});
 * const backend = yield* Stackit.ContainerApplications.Application("Backend", {
 *   environmentId: apps.environmentId,
 *   image: "ghcr.io/my-org/backend:v1.0.0",
 *   network: {
 *     public: { enabled: false },
 *     internal: { enabled: true, port: 8080 },
 *   },
 * });
 * ```
 *
 * ### Secrets
 * A `Redacted` value in `env` goes into the environment's secrets under a key Alchemy manages,
 * `alchemy-<displayName>-<variable>`, and the application only references that key. Don't use that
 * prefix for your own secrets: the application overwrites and deletes that key. A new value updates the application too, through
 * a digest of its values among its variables. Or use an `EnvironmentSecret` you declare, through
 * `secrets`; a new value there doesn't touch the application.
 *
 * **Example:** Secrets both ways
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const apps = yield* Stackit.ContainerApplications.Environment("Apps", {});
 * const apiKey = yield* Config.Redacted("API_KEY");
 * const shared = yield* Config.Redacted("SHARED_TOKEN");
 * const token = yield* Stackit.ContainerApplications.EnvironmentSecret("SharedToken", {
 *   environmentId: apps.environmentId,
 *   key: "shared-token",
 *   value: shared,
 * });
 * const api = yield* Stackit.ContainerApplications.Application("Api", {
 *   environmentId: apps.environmentId,
 *   image: "ghcr.io/my-org/api:v1.0.0",
 *   env: { API_KEY: apiKey, LOG_LEVEL: "info" },
 *   secrets: { SHARED_TOKEN: token.key },
 * });
 * ```
 *
 * ### Using STACKIT bindings
 * An Application runs as no STACKIT identity, because the API has no service account field. So
 * a binding gets a service account and key, and the key reaches the application as an
 * environment secret. Grants are project-scoped, because STACKIT binds roles only on
 * organizations, folders and projects.
 *
 * **Example:** Read a DNS zone from the application
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Apps = Stackit.ContainerApplications.Environment("Apps", {});
 * export const Domain = Stackit.DNS.Zone("Domain", { dnsName: "example.com" });
 *
 * export default class Api extends Stackit.ContainerApplications.Application<Api>()(
 *   "Api",
 *   Effect.gen(function* () {
 *     const apps = yield* Apps;
 *     return {
 *       main: import.meta.url,
 *       environmentId: apps.environmentId,
 *       registry: { repository: "ghcr.io/my-org/api" },
 *     };
 *   }),
 *   Effect.gen(function* () {
 *     const getZone = yield* Stackit.DNS.GetZone(yield* Domain);
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
 * ### Reading an Application at runtime
 * **Example:** Read another application's status and logs
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Apps = Stackit.ContainerApplications.Environment("Apps", {});
 * export const Backend = Effect.gen(function* () {
 *   const apps = yield* Apps;
 *   return yield* Stackit.ContainerApplications.Application("Backend", {
 *     environmentId: apps.environmentId,
 *     image: "ghcr.io/my-org/backend:v1.0.0",
 *   });
 * });
 *
 * export default class Front extends Stackit.ContainerApplications.Application<Front>()(
 *   "Front",
 *   Effect.gen(function* () {
 *     const apps = yield* Apps;
 *     return {
 *       main: import.meta.url,
 *       environmentId: apps.environmentId,
 *       registry: { repository: "ghcr.io/my-org/front" },
 *     };
 *   }),
 *   Effect.gen(function* () {
 *     const backend = yield* Backend;
 *     const getApplication = yield* Stackit.ContainerApplications.GetApplication(backend);
 *     const getEvents = yield* Stackit.ContainerApplications.GetApplicationEvents(backend);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getApplication();
 *         const { events } = yield* getEvents();
 *         return yield* HttpServerResponse.json({ status: live.status?.current, events });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(
 *     Effect.provide([
 *       Stackit.ContainerApplications.GetApplicationHttp,
 *       Stackit.ContainerApplications.GetApplicationEventsHttp,
 *     ]),
 *   ),
 * ) {}
 * ```
 *
 * ### Event sources
 * A deploy or a scale-in stops a running instance with a signal: HTTP requests get about six seconds to
 * finish, and a consumer's handler is interrupted mid message, so that message comes back. A
 * handler has to tolerate running twice.
 *
 * The Container Applications API has no trigger of its own. An effectful Application provides
 * core's `ServerHost`, so the consumers in `Stackit.PubSub` and `Stackit.RabbitMQ` run in it for
 * as long as an instance does. Scaling to zero would stop them, so a program with a background
 * loop runs exactly one instance by default, and a deploy that scales such a program to zero
 * with no custom rule to wake it fails with
 * `Stackit.ContainerApplications.ApplicationBackgroundWorkScalesToZero`.
 *
 * **Example:** Consume a Pub/Sub subscription
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 *
 * export const Apps = Stackit.ContainerApplications.Environment("Apps", {});
 * export const Orders = Stackit.PubSub.Topic("Orders", {});
 * export const Billing = Orders.pipe(
 *   Effect.flatMap((topic) =>
 *     Stackit.PubSub.Subscription("Billing", { topicId: topic.topicId }),
 *   ),
 * );
 *
 * export default class BillingWorker extends Stackit.ContainerApplications.Application<BillingWorker>()(
 *   "BillingWorker",
 *   Effect.gen(function* () {
 *     const apps = yield* Apps;
 *     return {
 *       main: import.meta.url,
 *       environmentId: apps.environmentId,
 *       registry: { repository: "ghcr.io/my-org/billing" },
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
 * **Example:** Consume a RabbitMQ queue
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 *
 * export const Apps = Stackit.ContainerApplications.Environment("Apps", {});
 * export const Broker = Stackit.RabbitMQ.Instance("Broker", {
 *   version: "4.1",
 *   planName: "stackit-rabbitmq-2.4.10-single",
 *   acl: ["0.0.0.0/0"],
 * });
 * export const Login = Broker.pipe(
 *   Effect.flatMap((broker) =>
 *     Stackit.RabbitMQ.Credential("App", { instanceId: broker.instanceId }),
 *   ),
 * );
 *
 * export default class JobWorker extends Stackit.ContainerApplications.Application<JobWorker>()(
 *   "JobWorker",
 *   Effect.gen(function* () {
 *     const apps = yield* Apps;
 *     return {
 *       main: import.meta.url,
 *       environmentId: apps.environmentId,
 *       registry: { repository: "ghcr.io/my-org/jobs" },
 *     };
 *   }),
 *   Effect.gen(function* () {
 *     yield* Stackit.RabbitMQ.consumeQueueMessages(
 *       Login,
 *       { queue: "jobs", prefetch: 10 },
 *       (message) => Effect.log(message.text),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(Stackit.RabbitMQ.ServerQueueEventSource)),
 * ) {}
 * ```
 *
 * :::caution[Changing `environmentId`, `projectId` or `region` replaces the Application]
 * The application is created at its new place and gets a new URL. The old one is deleted. An
 * `environmentId` from an `Environment` being replaced replaces its applications too.
 * :::
 *
 * @resource
 * @product STACKIT Container Applications
 * @category Container Applications
 */
export const Application: Platform<
  Application,
  ApplicationServices,
  ApplicationShape,
  ApplicationRuntimeContext
> & {
  /**
   * Async (no-impl) constructor: captures the `env` literal so `InferEnv` types the
   * handler's second argument.
   */
  <const Env extends Record<string, any>, PropsReq = never>(
    id: string,
    props:
      | InputProps<ApplicationProps<Env>>
      | Effect.Effect<InputProps<ApplicationProps<Env>>, never, PropsReq>,
  ): Effect.Effect<Application<Env>, never, Providers | PropsReq>;
} = Platform("Stackit.ContainerApplications.Application", {
  createRuntimeContext: createApplicationRuntimeContext(
    "Stackit.ContainerApplications.Application",
  ),
});

/** The application declares no `main`, `image` or `containers`. */
export class ApplicationSourceRequired extends Data.TaggedError(
  "Stackit.ContainerApplications.ApplicationSourceRequired",
)<{
  readonly resourceName: string;
  readonly message: string;
}> {}

/** The application builds from `main` but has nowhere to push the image. */
export class ApplicationRegistryRequired extends Data.TaggedError(
  "Stackit.ContainerApplications.ApplicationRegistryRequired",
)<{
  readonly resourceName: string;
  readonly message: string;
}> {}

/** The program runs a background loop, and its scaling lets every instance go. */
export class ApplicationBackgroundWorkScalesToZero extends Data.TaggedError(
  "Stackit.ContainerApplications.ApplicationBackgroundWorkScalesToZero",
)<{
  readonly resourceName: string;
  readonly message: string;
}> {}

const DEFAULT_CONTAINER_NAME = "app";

const toDisplayName = (id: string, displayName: string | undefined) =>
  displayName !== undefined
    ? Effect.succeed(displayName)
    : createPhysicalName({ id, lowercase: true, maxLength: APPLICATION_NAME_MAX_LENGTH });

/** The port the first container listens on. */
const portOf = (news: ApplicationProps) =>
  news.network?.public?.port ?? news.network?.internal?.port ?? DEFAULT_APPLICATION_PORT;

const imageSourceOf = (news: ApplicationProps, main: string) =>
  hostImageSource({
    props: news,
    main,
    port: portOf(news),
    resourceType: "Stackit.ContainerApplications.Application",
  });

/** What the first container runs, building it first when there is a `main`. */
const resolveImage = Effect.fn(function* (args: {
  id: string;
  news: ApplicationProps;
  output: ApplicationAttributes | undefined;
  session: { note: (message: string) => Effect.Effect<void> };
}) {
  const { id, news, output, session } = args;
  if (news.main === undefined) return { image: news.image, codeHash: undefined };
  if (news.registry === undefined) {
    return yield* new ApplicationRegistryRequired({
      resourceName: id,
      message: `${id}: \`main\` builds an image, so it needs \`registry\` to push it to`,
    });
  }
  return yield* pushHostImage({
    id,
    source: imageSourceOf(news, news.main),
    registry: news.registry,
    deployed: output,
    session,
  });
});

/** A value this application keeps in its environment's secrets. */
interface StagedSecret {
  readonly key: string;
  readonly value: Redacted.Redacted<string>;
}

interface DesiredContainer {
  readonly container: sca.Container;
  readonly staged: ReadonlyArray<StagedSecret>;
}

/**
 * One container's API shape, and the secrets its `Redacted` values need. Those stay out of the
 * application's own configuration, where `GetApplication` would show them.
 *
 * A secret's new value isn't a change to the application, and that is all Alchemy can ask the API
 * to act on. So a container with staged secrets also carries a digest of their values, which a new
 * value changes. Salted with the generation and cut short, because the configuration is readable
 * to anyone who can read the application.
 */
const toContainer = Effect.fn(function* (args: {
  spec: Omit<ApplicationContainer, "env">;
  env: Record<string, unknown>;
  external: boolean;
  secretPrefix: string;
  instanceId: string;
}) {
  const { spec, env, external, secretPrefix, instanceId } = args;
  const staged: StagedSecret[] = [];
  const variables: sca.ContainerEnvVar[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const text = hostEnvVariable(key, value, external);
    if (Redacted.isRedacted(value)) {
      // Reserved, so a key this application writes, and later deletes, can't be one someone else
      // set under the plain name.
      const secretKey = `alchemy-${secretPrefix}-${key}`.toLowerCase().replaceAll("_", "-");
      staged.push({ key: secretKey, value: Redacted.make(text) });
      variables.push({ key, origin: "ENV_FROM_SOURCE_TYPE_SECRET", value: secretKey });
    } else {
      variables.push({ key, origin: "ENV_FROM_SOURCE_TYPE_MANUAL", value: text });
    }
  }
  for (const [key, secretKey] of Object.entries(spec.secrets ?? {})) {
    variables.push({ key, origin: "ENV_FROM_SOURCE_TYPE_SECRET", value: secretKey });
  }
  if (staged.length > 0) {
    const digest = yield* sha256Object({
      instanceId,
      values: staged.map(({ key, value }) => [key, Redacted.value(value)]),
    });
    variables.push({
      key: "ALCHEMY_STACKIT_SECRETS_VERSION",
      origin: "ENV_FROM_SOURCE_TYPE_MANUAL",
      value: digest.slice(0, 16),
    });
  }
  variables.sort((left, right) => left.key.localeCompare(right.key));
  return {
    container: {
      name: spec.name,
      image: spec.image,
      ...(spec.command !== undefined ? { command: spec.command } : {}),
      ...(spec.args !== undefined ? { args: spec.args } : {}),
      ...(spec.cpu !== undefined ? { cpu: spec.cpu } : {}),
      ...(spec.memory !== undefined ? { memory: spec.memory } : {}),
      environmentVariables: variables,
    },
    staged,
  } satisfies DesiredContainer;
});

/** Every container, the one with the host's env first. */
const desiredContainers = Effect.fn(function* (args: {
  id: string;
  news: ApplicationProps;
  image: string | undefined;
  bindings: ReadonlyArray<ResourceBinding<HostBinding>>;
  displayName: string;
  instanceId: string;
}) {
  const { id, news, image, bindings, displayName, instanceId } = args;
  const external = news.isExternal === true || news.main === undefined;
  const { [BACKGROUND_WORK_ENV]: _background, ...env } = yield* hostEnv(news, bindings, external);
  const [first, ...rest] = news.containers ?? [];
  const primary: Omit<ApplicationContainer, "env"> | undefined =
    image !== undefined
      ? {
          name: news.containerName ?? DEFAULT_CONTAINER_NAME,
          image,
          command: news.command,
          args: news.args,
          cpu: news.cpu,
          memory: news.memory,
          secrets: news.secrets,
        }
      : first !== undefined
        ? { ...first, secrets: { ...first.secrets, ...news.secrets } }
        : undefined;
  if (primary === undefined) {
    return yield* new ApplicationSourceRequired({
      resourceName: id,
      message: `${id}: a Stackit.ContainerApplications.Application needs \`main\`, \`image\` or \`containers\``,
    });
  }
  const others = image !== undefined ? (news.containers ?? []) : rest;
  const plans: ReadonlyArray<Parameters<typeof toContainer>[0]> = [
    {
      spec: primary,
      env: image !== undefined ? env : { ...first?.env, ...env },
      external,
      secretPrefix: displayName,
      instanceId,
    },
    ...others.map(({ env: own, ...spec }) => ({
      spec,
      env: own ?? {},
      // These run the user's own images, not a program of ours that unpacks values.
      external: true,
      secretPrefix: `${displayName}-${spec.name}`,
      instanceId,
    })),
  ];
  return yield* Effect.forEach(plans, (plan) => toContainer(plan));
});

const toScaleRule = (rule: ApplicationScaleRule): sca.ApplicationScaleRule =>
  "http" in rule
    ? { name: rule.name, type: "RULE_TYPE_HTTP", httpRule: rule.http }
    : {
        name: rule.name,
        type: "RULE_TYPE_CUSTOM",
        customRule: {
          type: rule.custom.type,
          parameters: Object.entries(rule.custom.parameters ?? {}).map(([name, value]) => ({
            name,
            value,
          })),
          secretsMapping: Object.entries(rule.custom.secrets ?? {}).map(([parameter, secret]) => ({
            parameter,
            secret,
          })),
        },
      };

/**
 * The scaling to send. A program with a background loop needs an instance to run it, so its
 * default is one, and scaling it to zero fails unless a custom rule can wake it.
 */
const desiredScaling = Effect.fn(function* (id: string, news: ApplicationProps) {
  const background = news.env?.[BACKGROUND_WORK_ENV] !== undefined;
  const scaling: ApplicationScaling = news.scaling ?? {
    type: "auto",
    minInstances: background ? 1 : 0,
    maxInstances: 1,
  };
  if (scaling.type === "manual") {
    return {
      type: "SCALING_TYPE_MANUAL",
      manualScaling: { instances: scaling.instances },
    } satisfies sca.ApplicationScaling;
  }
  const minInstances = scaling.minInstances ?? 0;
  const rules: ReadonlyArray<ApplicationScaleRule> = scaling.rules ?? [
    { name: "traffic", http: { concurrency: 10 } },
  ];
  if (background && minInstances === 0 && !rules.some((rule) => "custom" in rule)) {
    return yield* new ApplicationBackgroundWorkScalesToZero({
      resourceName: id,
      message: `${id}: this program runs a background loop, such as an event source, and nothing would run it at zero instances. Set scaling.minInstances to 1, or add a custom rule that wakes it.`,
    });
  }
  return {
    type: "SCALING_TYPE_AUTO",
    autoScaling: {
      minInstances,
      maxInstances: scaling.maxInstances ?? 1,
      allowScaleToZero: scaling.allowScaleToZero ?? minInstances === 0,
      rules: rules.map(toScaleRule),
    },
  } satisfies sca.ApplicationScaling;
});

const desiredNetwork = (news: ApplicationProps): sca.ApplicationNetwork => {
  const port = news.network?.public?.port ?? portOf(news);
  return {
    public: { enabled: true, ...news.network?.public, port },
    internal: news.network?.internal ?? { enabled: false },
  };
};

const sorted = (values: ReadonlyArray<string> | undefined) => [...(values ?? [])].sort();

const byName = <A extends { readonly name: string }>(items: ReadonlyArray<A>) =>
  [...items].sort((left, right) => left.name.localeCompare(right.name));

/** What of a container is compared. A limit left unset takes whatever the API chose. */
const containerView = (container: sca.Container, observed: sca.Container | undefined) => ({
  name: container.name,
  image: container.image,
  command: container.command ?? [],
  args: container.args ?? [],
  cpu: container.cpu ?? observed?.cpu,
  memory: container.memory ?? observed?.memory,
  env: [...(container.environmentVariables ?? [])]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map(({ key, origin, value }) => ({
      key,
      origin: origin ?? "ENV_FROM_SOURCE_TYPE_MANUAL",
      value,
    })),
});

const scalingView = (scaling: sca.ApplicationScaling) =>
  scaling.type === "SCALING_TYPE_MANUAL"
    ? { type: scaling.type, instances: scaling.manualScaling?.instances }
    : {
        type: scaling.type,
        minInstances: scaling.autoScaling?.minInstances,
        maxInstances: scaling.autoScaling?.maxInstances,
        allowScaleToZero: scaling.autoScaling?.allowScaleToZero ?? false,
        rules: byName(scaling.autoScaling?.rules ?? []).map((rule) => ({
          name: rule.name,
          type: rule.type,
          concurrency: rule.httpRule?.concurrency,
          rps: rule.httpRule?.rps,
          scaler: rule.customRule?.type,
          parameters: byName(rule.customRule?.parameters ?? []).map(
            ({ name, value }) => `${name}=${value}`,
          ),
          secrets: [...(rule.customRule?.secretsMapping ?? [])]
            .map(({ parameter, secret }) => `${parameter}=${secret}`)
            .sort(),
        })),
      };

const networkView = (network: sca.ApplicationNetwork | undefined) => ({
  public: network?.public?.enabled ?? false,
  publicPort: network?.public?.enabled ? network.public.port : undefined,
  ingress: sorted(network?.public?.accessControl?.ingress),
  egress: sorted(network?.public?.accessControl?.egress),
  internal: network?.internal?.enabled ?? false,
  internalPort: network?.internal?.enabled ? network.internal.port : undefined,
});

/** Whether the observed application differs from what is desired, in anything the API takes. */
const applicationDrifted = (
  observed: sca.Application,
  desired: {
    displayName: string;
    containers: ReadonlyArray<sca.Container>;
    scaling: sca.ApplicationScaling;
    network: sca.ApplicationNetwork;
    stopped: boolean;
  },
) =>
  observed.displayName !== desired.displayName ||
  (observed.stopped ?? false) !== desired.stopped ||
  secretsDiffer(scalingView(observed.scaling), scalingView(desired.scaling)) ||
  secretsDiffer(networkView(observed.network), networkView(desired.network)) ||
  secretsDiffer(
    byName(observed.containers).map((container) => containerView(container, undefined)),
    byName(desired.containers).map((container) =>
      containerView(
        container,
        observed.containers.find((candidate) => candidate.name === container.name),
      ),
    ),
  );

const url = (domain: string | undefined) =>
  domain === undefined || domain === ""
    ? undefined
    : domain.includes("://")
      ? domain
      : `https://${domain}`;

const toAttrs = (args: {
  app: sca.Application | sca.ApplicationSummary;
  applicationId: string;
  scope: EnvironmentScope;
  displayName: string;
  image: string | undefined;
  codeHash: string | undefined;
  stagedSecrets: ReadonlyArray<string>;
}): ApplicationAttributes => {
  const { app, scope } = args;
  return {
    applicationId: args.applicationId,
    environmentId: scope.environmentId,
    projectId: scope.projectId,
    region: scope.region,
    displayName: app.displayName ?? args.displayName,
    url: url(app.status?.domains?.default),
    internalDomain: app.status?.domains?.internal,
    status: app.status?.current,
    instances: (app.status?.instances ?? []).map(({ name, status }) => ({ name, status })),
    lastDeployment: app.status?.lastDeployment,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
    image: args.image,
    codeHash: args.codeHash,
    stagedSecrets: [...args.stagedSecrets],
  };
};

/** Wait until the application serves, or fail with what its events say went wrong. */
const waitForApplication = (scope: EnvironmentScope, applicationId: string, displayName: string) =>
  waitFor({
    resource: `STACKIT Container Applications application ${displayName}`,
    read: Effect.gen(function* () {
      const app = yield* sca.getApplication({ ...scope, applicationId });
      if (app.status?.current !== "CURRENT_STATUS_FAILED") return { app, events: [] as string[] };
      const { events } = yield* sca.getApplicationEvents({ ...scope, applicationId });
      return {
        app,
        events: (events ?? []).flatMap((event) =>
          event.message === undefined ? [] : [event.message],
        ),
      };
    }),
    ready: ({ app }) =>
      app.status?.current === "CURRENT_STATUS_RUNNING" ||
      app.status?.current === "CURRENT_STATUS_IDLE" ||
      app.status?.current === "CURRENT_STATUS_NONE",
    failed: ({ app, events }) =>
      app.status?.current === "CURRENT_STATUS_FAILED"
        ? events.length > 0
          ? events.join("; ")
          : app.status.current
        : undefined,
    state: ({ app }) => app.status?.current,
    timeout: APPLICATION_TIMEOUT,
  }).pipe(Effect.map(({ app }) => app));

export const ApplicationProvider = () =>
  Provider.succeed(Application, {
    stables: ["applicationId", "environmentId", "projectId", "region"],
    // An application goes first, so that it stops using what it references.
    nuke: {
      dependsOn: [
        "Stackit.ContainerApplications.EnvironmentSecret",
        "Stackit.ContainerApplications.EnvironmentRegistry",
      ],
    },

    // With no labels, the shape of a generated name is the only ownership signal.
    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const { items } = yield* sca.listProjectApplications({
        projectId: env.projectId,
        region: env.region,
      });
      return (items ?? []).flatMap((app) =>
        app.id !== undefined &&
        app.environmentId !== undefined &&
        app.displayName !== undefined &&
        isGeneratedPhysicalName(app.displayName, APPLICATION_NAME_MAX_LENGTH)
          ? [
              toAttrs({
                app,
                applicationId: app.id,
                scope: {
                  projectId: env.projectId,
                  region: env.region,
                  environmentId: app.environmentId,
                },
                displayName: app.displayName,
                image: undefined,
                codeHash: undefined,
                stagedSecrets: [],
              }),
            ]
          : [],
      );
    }),

    diff: Effect.fn(function* ({ news: desired, output }) {
      if (output === undefined) return undefined;
      // An unresolved scope can resolve to the one the application is already in, and an
      // explicit name may not exist twice there: delete first. A generated name carries the
      // generation, so it never collides.
      if (
        hasUnresolvedTrigger<ApplicationProps>(desired, ["environmentId", "projectId", "region"])
      ) {
        return {
          action: "replace",
          deleteFirst: rawProp<ApplicationProps>(desired, "displayName") !== undefined,
        } as const;
      }
      const resolved = triggerProps<ApplicationProps>(desired);
      const env = yield* StackitEnvironment.current;
      if (
        resolved.environmentId !== output.environmentId ||
        (resolved.projectId ?? env.projectId) !== output.projectId ||
        (resolved.region ?? env.region) !== output.region
      ) {
        return { action: "replace" } as const;
      }
      // Runtime exports are covered by the bundle hash, not infrastructure inputs.
      const news = stripEffects(desired);
      if (news === undefined || !isResolved(news)) return undefined;
      // A code-only change leaves the props untouched: hash the program so it still
      // surfaces as an update.
      if (news.main !== undefined) {
        const images = yield* makeContainerImageSource;
        const hash = yield* images.hash(imageSourceOf(news, news.main));
        if (hash !== output.codeHash) return { action: "update" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const { projectId, region } = yield* resolveProjectScope(olds, output);
      const environmentId = output?.environmentId ?? olds?.environmentId;
      if (typeof environmentId !== "string") return undefined;
      const scope = { projectId, region, environmentId };
      const displayName = output?.displayName ?? (yield* toDisplayName(id, olds?.displayName));
      let app: sca.Application | undefined =
        output !== undefined
          ? yield* getApplicationOrUndefined(scope, output.applicationId)
          : undefined;
      if (app === undefined) app = yield* findApplicationByName(scope, displayName);
      if (app?.id === undefined) return undefined;
      const attrs = toAttrs({
        app,
        applicationId: app.id,
        scope,
        displayName,
        image: app.containers[0]?.image,
        codeHash: output?.codeHash,
        stagedSecrets: output?.stagedSecrets ?? [],
      });
      if (output?.applicationId === app.id) return attrs;
      // A name is only unique per environment, so only this exact place is the replaced one.
      if (
        previous?.displayName === app.displayName &&
        previous.environmentId === environmentId &&
        previous.projectId === projectId &&
        previous.region === region
      ) {
        return attrs;
      }
      // With no labels, a generated name is all that says it is ours.
      return olds?.displayName === undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output, bindings, session }) {
      const { projectId, region } = yield* resolveProjectScope(news, output);
      const scope = { projectId, region, environmentId: news.environmentId };
      const displayName = yield* toDisplayName(id, news.displayName);
      const scaling = yield* desiredScaling(id, news);
      const network = desiredNetwork(news);
      const stopped = news.stopped ?? false;

      // Build first, so a bad image or a failed build creates nothing.
      const { image, codeHash } = yield* resolveImage({ id, news, output, session });

      const built = yield* desiredContainers({
        id,
        news,
        image,
        bindings: bindings as ReadonlyArray<ResourceBinding<HostBinding>>,
        displayName,
        instanceId,
      });
      const containers = built.map(({ container }) => container);
      const staged = built.flatMap((item) => item.staged);

      yield* ensureContainerApplicationsEnabled(projectId, region);

      // The application references these, so they exist before it does. Their values are
      // always sent: the API may not return one to compare. The body is "the subset of
      // secrets to merge or replace", so these keys are all it holds.
      if (staged.length > 0) {
        yield* sca
          .updateEnvironmentSecrets({
            ...scope,
            secrets: staged.map(({ key, value }) => ({ key, value })),
          })
          .pipe(withSecretLock(scope));
      }

      // Observe: `output` is a cache, and its id only counts in this environment.
      let app: sca.Application | undefined =
        output?.environmentId === scope.environmentId &&
        output.projectId === projectId &&
        output.region === region
          ? yield* getApplicationOrUndefined(scope, output.applicationId)
          : undefined;
      // Crash recovery, only by a generated name. It carries this generation, while a name
      // the user chose could be anyone's.
      if (app === undefined && news.displayName === undefined) {
        app = yield* findApplicationByName(scope, displayName);
      }

      const body = { containers, displayName, network, scaling, stopped };

      // Ensure
      const createdNow = app === undefined;
      if (app === undefined) {
        app = yield* sca.createApplication({ ...scope, ...body }).pipe(
          Effect.catchTag("Conflict", (conflict) =>
            // A generated name that exists is a race with this generation's own create.
            news.displayName !== undefined
              ? Effect.fail(conflict)
              : findApplicationByName(scope, displayName).pipe(
                  Effect.flatMap((found) =>
                    found === undefined ? Effect.fail(conflict) : Effect.succeed(found),
                  ),
                ),
          ),
        );
      }
      const applicationId = app.id;
      if (applicationId === undefined) {
        return yield* new ContainerApplicationsIdMissing({
          resourceName: displayName,
          message: `STACKIT returned application ${displayName} without an id`,
        });
      }

      // Sync. The schema requires the whole body on a PATCH.
      if (!createdNow && applicationDrifted(app, body)) {
        yield* sca.updateApplication({ ...scope, applicationId, ...body });
      }

      // An application with a name the user chose can't be recovered without state, so one that
      // never came up would only be reported as unowned next time.
      const ready = yield* waitForApplication(scope, applicationId, displayName).pipe(
        Effect.onError(() =>
          Effect.gen(function* () {
            if (createdNow && news.displayName !== undefined) {
              yield* sca.deleteApplication({ ...scope, applicationId }).pipe(Effect.ignore);
            }
          }),
        ),
      );

      // Prune what this application no longer references.
      const stagedKeys = staged.map(({ key }) => key);
      const stale = (output?.stagedSecrets ?? []).filter((key) => !stagedKeys.includes(key));
      if (stale.length > 0) {
        const left = yield* removeSecretKeys(scope, stale);
        if (left.length > 0) {
          yield* Effect.logWarning(
            `Application ${displayName}: secrets ${left.join(", ")} stay in environment ${scope.environmentId}, which the API gave no way to remove.`,
          );
        }
      }

      return toAttrs({
        app: ready,
        applicationId,
        scope,
        displayName,
        image: containers[0]?.image,
        codeHash,
        stagedSecrets: stagedKeys,
      });
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = {
        projectId: output.projectId,
        region: output.region,
        environmentId: output.environmentId,
      };
      const { applicationId, displayName } = output;
      yield* sca
        .deleteApplication({ ...scope, applicationId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone({
        resource: `STACKIT Container Applications application ${displayName}`,
        read: getApplicationOrUndefined(scope, applicationId),
        state: (app) => app.status?.current,
        timeout: APPLICATION_DELETE_TIMEOUT,
      });
      if (output.stagedSecrets.length > 0) {
        const left = yield* removeSecretKeys(scope, output.stagedSecrets);
        if (left.length > 0) {
          yield* Effect.logWarning(
            `Application ${displayName}: secrets ${left.join(", ")} stay in environment ${scope.environmentId}, which the API gave no way to remove.`,
          );
        }
      }
    }),

    // The API's log lines have no timestamps and it takes no time range, so `since` can't apply,
    // and each line carries the time it was read.
    logs: Effect.fn(function* ({ output, options }) {
      const scope = {
        projectId: output.projectId,
        region: output.region,
        environmentId: output.environmentId,
      };
      const applicationId = output.applicationId;
      const app = yield* getApplicationOrUndefined(scope, applicationId);
      const container = app?.containers[0]?.name;
      if (app === undefined || container === undefined) return [];
      const lines = yield* Effect.forEach(
        (app.status?.instances ?? []).flatMap(({ name }) => (name === undefined ? [] : [name])),
        (instance) =>
          sca.getApplicationLogs({ ...scope, applicationId, instance, container }).pipe(
            Effect.map(({ logs }) => logs ?? []),
            // An instance can go between listing it and asking for its logs.
            Effect.catchTag("NotFound", () => Effect.succeed<sca.ApplicationLog[]>([])),
          ),
        { concurrency: 4 },
      );
      const now = yield* Clock.currentTimeMillis;
      const messages = lines
        .flat()
        .flatMap(({ message }) =>
          message === undefined ? [] : [{ timestamp: new Date(now), message }],
        );
      return options.limit === undefined ? messages : messages.slice(-options.limit);
    }),
  });
