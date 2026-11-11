import { DockerLive } from "@alchemy.run/docker/Docker";
import {
  makeContainerImageSource,
  type ImageRegistryTarget,
  type ImageSourceLike,
} from "@alchemy.run/docker/ImageSource";
import * as DO from "@distilled.cloud/digitalocean";
import type {
  App as ApiApp,
  AppServiceSpecInstanceSizeSlug,
  AppsDeployment,
} from "@distilled.cloud/digitalocean";

/** An App Platform instance size slug, for example `"apps-s-1vcpu-0.5gb"`. */
export type AppInstanceSize = AppServiceSpecInstanceSizeSlug;
import { Credentials } from "@distilled.cloud/digitalocean/Credentials";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import { Platform, type Main, type PlatformProps } from "alchemy/Platform";
import * as Provider from "alchemy/Provider";
import { type Resource, type ResourceBinding } from "alchemy/Resource";
import {
  createHostRuntimeContext,
  type HostRuntimeContext,
  type ServerHost,
} from "alchemy/Runtime/Process";
import { Stack } from "alchemy/Stack";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { JOB_ENV, type AppBinding } from "./internal/appJobs.ts";
import { noneIfNotFound } from "./internal/notFound.ts";
import { pollUntil, type PollBudget } from "./internal/poll.ts";
import type { Providers } from "./Providers.ts";
import type { Registry } from "./Registry.ts";

export type AppRegion =
  | "nyc"
  | "sfo"
  | "ams"
  | "fra"
  | "lon"
  | "sgp"
  | "blr"
  | "syd"
  | "tor"
  | "atl";

export interface AppProps extends PlatformProps {
  /**
   * App name, unique within the team: 2 to 32 lowercase letters, digits and
   * `-`. A change renames the app in place.
   *
   * @default a generated physical name
   */
  name?: string;
  /** Region the app runs in. A change moves the app. @default "nyc" */
  region?: AppRegion;
  /**
   * The program to run. With an Effect implementation (`main:
   * import.meta.url`), the class's handlers are served. Without one, the
   * module's `export default { fetch }` is served, with `process.env` as
   * its second argument.
   */
  main?: string;
  /** Named export to load from `main`. @default "default" */
  handler?: string;
  /** A Docker build context to run instead of `main`. */
  context?: string;
  /** The Dockerfile for `context`, relative to it. @default "Dockerfile" */
  dockerfile?: string;
  /** A public image (`nginx:1.27`) to mirror into the registry and run instead of `main`. */
  image?: string;
  /** Bundler options for `main`. */
  build?: ImageSourceLike["build"];
  /** Port the program listens on; App Platform routes HTTPS to it. @default 8080 */
  port?: number;
  /**
   * Instance size slug, for example `"apps-s-1vcpu-0.5gb"` or
   * `"apps-d-1vcpu-1gb"`. A change resizes in place.
   *
   * @default "apps-s-1vcpu-0.5gb"
   */
  instanceSizeSlug?: AppInstanceSize;
  /** Instances behind the app's load balancer. @default 1 */
  instanceCount?: number;
  /**
   * Path App Platform probes over HTTP for readiness; it must answer 2xx.
   *
   * @default a TCP check on `port`
   */
  healthCheckPath?: string;
  /** Environment variables, merged after the ones bindings add. */
  env?: Record<string, any>;
  /**
   * Container Registry the image is pushed to, by name or as the
   * `DigitalOcean.Registry` that declares it. App Platform pulls from it
   * with the team's own access.
   *
   * @default the team's registry
   */
  registry?: string | RegistryRef;
}

export type App = Resource<
  "DigitalOcean.App",
  AppProps,
  {
    /** App id (UUID). */
    appId: string;
    /** Uniform resource name, `do:app:<id>`, for `ProjectResources`. */
    urn: string;
    /** App name. */
    name: string;
    /** The app's HTTPS URL. */
    url: string;
    /** Region slug. */
    region: string | undefined;
    /** The deployed image, `registry.digitalocean.com/<registry>/<repo>:<hash>`. */
    imageUri: string;
    /** Content hash of the deployed program. */
    code: { hash: string };
  },
  AppBinding,
  Providers
>;

export type AppAttributes = App["Attributes"];

export type { AppBinding } from "./internal/appJobs.ts";

export type AppServices = ServerHost;

export type AppShape = Main<AppServices>;

export type AppRuntimeContext = HostRuntimeContext;

/**
 * A DigitalOcean App Platform app running your program as an HTTPS service
 * with autoscaled instances behind App Platform's load balancer and CDN.
 * Alchemy builds the program into an image, pushes it to the team's
 * Container Registry, and deploys it; `reconcile` returns once the
 * deployment is live.
 *
 * ### Effect App
 * **Example:** An Effect HTTP handler
 * ```typescript
 * // src/Api.ts
 * export default class Api extends DigitalOcean.App<Api>()(
 *   "Api",
 *   { main: import.meta.url, region: "nyc" },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.gen(function* () {
 *         return yield* HttpServerResponse.json({ ok: true });
 *       }),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * ### Async App
 * **Example:** A plain fetch handler with a typed env
 * ```typescript
 * // alchemy.run.ts
 * export const Ping = DigitalOcean.App("Ping", {
 *   main: "./src/ping.ts",
 *   env: { GREETING: "hello" },
 * });
 * export type PingEnv = DigitalOcean.InferEnv<typeof Ping>;
 * ```
 *
 * ```typescript
 * // src/ping.ts
 * import type { PingEnv } from "../alchemy.run.ts";
 *
 * export default {
 *   async fetch(_request: Request, env: PingEnv) {
 *     return new Response(env.GREETING);
 *   },
 * };
 * ```
 *
 * ### Running an Image
 * **Example:** A Dockerfile build, scaled to three instances
 * ```typescript
 * const web = yield* DigitalOcean.App("Web", {
 *   context: "./web",
 *   port: 3000,
 *   instanceSizeSlug: "apps-d-1vcpu-1gb",
 *   instanceCount: 3,
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Apps
 *
 * @resource
 * @product App Platform
 * @category Compute
 */
export const App: Platform<App, AppServices, AppShape, AppRuntimeContext> = Platform(
  "DigitalOcean.App",
  {
    createRuntimeContext: createHostRuntimeContext("DigitalOcean.App"),
    // `{ registry: Registry(...) }` at module scope is an Effect. Yield it so
    // the registry is declared and `news.registry` is its attributes.
    transformProps: (_id, props) =>
      Effect.gen(function* () {
        if (globalThis.__ALCHEMY_RUNTIME__ || !Effect.isEffect(props.registry)) return props;
        const registry = yield* props.registry as Effect.Effect<Registry, never, Providers>;
        return { ...props, registry };
      }),
  },
);

/** A registry by name, the `Registry` resource, or the Effect that declares it. */
export type RegistryRef = { readonly name: string } | Effect.Effect<Registry, never, Providers>;

const registryNameOf = (registry: AppProps["registry"]) =>
  registry === undefined
    ? undefined
    : typeof registry === "string"
      ? registry
      : Effect.isEffect(registry)
        ? undefined
        : registry.name;

export class AppRegistryMissing extends Data.TaggedError("DigitalOcean.AppRegistryMissing")<{
  readonly message: string;
}> {}

export class AppDeploymentFailed extends Data.TaggedError("DigitalOcean.AppDeploymentFailed")<{
  readonly appId: string;
  readonly deploymentId: string | undefined;
  readonly phase: string | undefined;
}> {
  override get message() {
    return `App ${this.appId} deployment ${this.deploymentId ?? "?"} ended in phase '${this.phase ?? "unknown"}'. See its logs in the control panel.`;
  }
}

const DEFAULT_PORT = 8080;
const DEFAULT_SIZE: AppInstanceSize = "apps-s-1vcpu-0.5gb";
const REGISTRY_HOST = "registry.digitalocean.com";

// A deployment pulls the image and starts in two to ten minutes (≈ 20 min budget).
const DEPLOY_POLL: PollBudget = { maxDelay: "15 seconds", times: 85 };

const FAILED_PHASES = new Set(["ERROR", "CANCELED", "SUPERSEDED"]);

const physicalName = (id: string) => createPhysicalName({ id, lowercase: true, maxLength: 32 });

// App Platform rejects a DOCR image whose `registry/repository` path is
// long (a 63-character registry with a 100-character repository fails,
// misreported as "App name already exists"). A 63-character registry with a
// 64-character repository is accepted.
const repositoryName = (id: string) => createPhysicalName({ id, lowercase: true, maxLength: 64 });

/** The generated entry for an Effect `main`: the bootstrap plus the user's module. */
const effectBootstrap =
  (handler: string) =>
  (importPath: string): string =>
    `
import { bootstrap } from "@alchemy.run/digitalocean/Bootstrap";
import { ${handler} as entrypoint } from ${JSON.stringify(importPath)};

await bootstrap(entrypoint);
`;

/**
 * The generated entry for an async `main`: a Node HTTP server that turns
 * each request into a `Request` and calls the module's `fetch(request,
 * process.env)`.
 */
const asyncBootstrap =
  (handler: string) =>
  (importPath: string): string =>
    `
import { createServer } from "node:http";
import { Readable } from "node:stream";
import * as mod from ${JSON.stringify(importPath)};

const exported = mod[${JSON.stringify(handler)}];
const fetchHandler = typeof exported === "function" ? exported : exported?.fetch;
const port = Number(process.env.PORT ?? ${DEFAULT_PORT});

createServer(async (req, res) => {
  try {
    if (typeof fetchHandler !== "function") throw new Error("main exports no fetch handler");
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) for (const v of value) headers.append(key, v);
      else if (value !== undefined) headers.set(key, value);
    }
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const request = new Request(\`http://\${req.headers.host ?? "localhost"}\${req.url}\`, {
      method: req.method,
      headers,
      body: hasBody ? Readable.toWeb(req) : undefined,
      duplex: "half",
    });
    const response = await fetchHandler(request, process.env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) for await (const chunk of response.body) res.write(chunk);
    res.end();
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(error));
  }
}).listen(port, "0.0.0.0");
`;

// Binding secrets arrive packed as `{"_tag":"Redacted",...}` (see
// `packEnvValue`); both forms become App Platform SECRET variables, which
// are encrypted and hidden in the control panel.
const isPackedRedacted = (value: string) => value.startsWith('{"_tag":"Redacted"');

const toEnvValue = (value: unknown): { value: string; secret: boolean } =>
  Redacted.isRedacted(value)
    ? { value: String(Redacted.value(value)), secret: true }
    : typeof value === "string"
      ? { value, secret: isPackedRedacted(value) }
      : { value: JSON.stringify(value), secret: false };

const activeBindings = (bindings: ReadonlyArray<ResourceBinding<AppBinding>>) =>
  bindings.filter(
    (binding: ResourceBinding<AppBinding> & { action?: string }) => binding.action !== "delete",
  );

const collectBindingEnv = (bindings: ReadonlyArray<ResourceBinding<AppBinding>>) =>
  activeBindings(bindings).reduce<Record<string, any>>(
    (env, binding) => ({ ...env, ...binding.data?.env }),
    {},
  );

const collectJobs = (bindings: ReadonlyArray<ResourceBinding<AppBinding>>) => [
  ...new Map(
    activeBindings(bindings)
      .flatMap((binding) => binding.data?.jobs ?? [])
      .map((job) => [job.name, job] as const),
  ).values(),
];

const observe = (appId: string) =>
  noneIfNotFound(DO.getApp({ id: appId }).pipe(Effect.map((r) => r.app)));

const observeByName = (name: string) =>
  DO.listApps.items({ per_page: 200 }).pipe(
    Stream.filter((app) => app.spec.name === name),
    Stream.runHead,
  );

const teamRegistry = (registry: string | undefined) =>
  registry !== undefined
    ? Effect.succeed(registry)
    : DO.listRegistries({}).pipe(
        Effect.map((r) => r.registries?.[0]?.name),
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        Effect.flatMap((name) =>
          name === undefined
            ? Effect.fail(
                new AppRegistryMissing({
                  message:
                    "DigitalOcean.App pushes its image to the team's Container Registry, and the team has none. Declare one with DigitalOcean.Registry.",
                }),
              )
            : Effect.succeed(name),
        ),
      );

// The registry accepts the API token as both the Docker username and the
// password, the same login `doctl registry login` performs.
const registryTarget = (
  registry: string,
  repository: string,
): ImageRegistryTarget<DO.DigitalOceanOpContext> => ({
  repositoryUri: Effect.succeed(`${REGISTRY_HOST}/${registry}/${repository}`),
  hasTag: (tag) =>
    DO.listRegistryRepositoryTags
      .items({ registry_name: registry, repository_name: repository, per_page: 200 })
      .pipe(
        Stream.filter((t) => t.tag === tag),
        Stream.runHead,
        Effect.map(Option.isSome),
        Effect.catchTag("NotFound", () => Effect.succeed(false)),
      ),
  credentials: Effect.gen(function* () {
    const { apiKey } = yield* yield* Credentials;
    return { server: REGISTRY_HOST, username: Redacted.value(apiKey), password: apiKey };
  }),
});

const deploymentOf = (app: ApiApp): AppsDeployment | undefined => app.active_deployment;

// Live once the active deployment runs the requested image and nothing newer is pending.
const isLive = (app: ApiApp, tag: string) =>
  app.in_progress_deployment === undefined &&
  app.pending_deployment === undefined &&
  deploymentOf(app)?.phase === "ACTIVE" &&
  (deploymentOf(app)?.spec?.services ?? []).some((service) => service.image?.tag === tag) &&
  app.live_url !== undefined;

const waitUntilLive = (appId: string, tag: string) =>
  pollUntil(observe(appId), {
    ...DEPLOY_POLL,
    until: (o): o is Option.Some<ApiApp> =>
      Option.isSome(o) &&
      (isLive(o.value, tag) ||
        FAILED_PHASES.has(o.value.in_progress_deployment?.phase ?? "") ||
        (o.value.in_progress_deployment === undefined &&
          FAILED_PHASES.has(o.value.active_deployment?.phase ?? ""))),
    onTimeout: (last) =>
      new AppDeploymentFailed({
        appId,
        deploymentId: Option.getOrUndefined(last)?.in_progress_deployment?.id,
        phase: Option.getOrUndefined(last)?.in_progress_deployment?.phase ?? "timed out",
      }),
  }).pipe(
    Effect.flatMap(({ value }) =>
      isLive(value, tag)
        ? Effect.succeed(value)
        : Effect.fail(
            new AppDeploymentFailed({
              appId,
              deploymentId: value.in_progress_deployment?.id ?? value.active_deployment?.id,
              phase: value.in_progress_deployment?.phase ?? value.active_deployment?.phase,
            }),
          ),
    ),
  );

export class AppImageNotVisible extends Data.TaggedError("DigitalOcean.AppImageNotVisible")<{
  readonly imageUri: string;
}> {
  override get message() {
    return `The registry did not list ${this.imageUri} after it was pushed.`;
  }
}

// A pushed tag takes a few seconds to be visible to App Platform.
const TAG_POLL: PollBudget = { maxDelay: "5 seconds", times: 24 };

export const AppProvider = () =>
  Provider.effect(
    App,
    Effect.gen(function* () {
      const stack = yield* Stack;
      const images = yield* makeContainerImageSource;

      const imageOptions = (id: string, news: AppProps) => {
        const handler = news.handler ?? "default";
        return {
          id,
          source: news as ImageSourceLike,
          port: news.port ?? DEFAULT_PORT,
          isExternal: false,
          bootstrap: news.isExternal ? asyncBootstrap(handler) : effectBootstrap(handler),
        };
      };

      return {
        stables: ["appId", "urn"],
        nuke: { skip: true },
        read: Effect.fn(function* ({ id, olds, output }) {
          if (output !== undefined) {
            const observed = yield* observe(output.appId);
            return Option.getOrUndefined(
              Option.map(observed, (app) => ({
                ...output,
                name: app.spec.name,
                url: app.live_url ?? output.url,
              })),
            );
          }
          // A generated name is this resource's; a chosen one proves nothing.
          if (olds.name !== undefined) return undefined;
          const generatedName = yield* physicalName(id);
          const named = yield* observeByName(generatedName);
          return Option.getOrUndefined(
            Option.map(named, (app) => ({
              appId: app.id,
              urn: `do:app:${app.id}`,
              name: app.spec.name,
              url: app.live_url ?? "",
              region: app.region?.slug,
              imageUri: "",
              code: { hash: "" },
            })),
          );
        }),
        diff: Effect.fn(function* ({ id, news, output }) {
          if (!isResolved(news) || output === undefined) return undefined;
          const hash = yield* images.hash(imageOptions(id, news));
          if (hash !== output.code.hash) return { action: "update" } as const;
        }),
        reconcile: Effect.fn(function* ({ id, news, output, bindings, session }) {
          const name = news.name ?? output?.name ?? (yield* physicalName(id));
          const registry = yield* teamRegistry(registryNameOf(news.registry));
          const repository = yield* repositoryName(id);
          const image = yield* images.resolve(
            { ...imageOptions(id, news), session },
            registryTarget(registry, repository),
          );
          const tag = image.codeHash;
          const target = registryTarget(registry, repository);
          yield* pollUntil(target.hasTag(tag), {
            ...TAG_POLL,
            until: (visible) => visible,
            onTimeout: () => new AppImageNotVisible({ imageUri: image.imageUri }),
          });

          const env = {
            ...collectBindingEnv(bindings as ReadonlyArray<ResourceBinding<AppBinding>>),
            ALCHEMY_STACK_NAME: stack.name,
            ALCHEMY_STAGE: stack.stage,
            ALCHEMY_PHASE: "runtime",
            PORT: String(news.port ?? DEFAULT_PORT),
            ...news.env,
          };
          const envs = Object.entries(env).map(([key, raw]) => {
            const { value, secret } = toEnvValue(raw);
            return { key, value, scope: "RUN_TIME", type: secret ? "SECRET" : "GENERAL" };
          });
          // Named explicitly: without it App Platform resolves the team's
          // registry from a cache that can still hold a deleted one.
          const appImage = { registry_type: "DOCR", registry, repository, tag };
          const instanceSize = news.instanceSizeSlug ?? DEFAULT_SIZE;
          const spec = {
            name,
            region: news.region ?? "nyc",
            services: [
              {
                name: "web",
                image: appImage,
                http_port: news.port ?? DEFAULT_PORT,
                instance_size_slug: instanceSize,
                instance_count: news.instanceCount ?? 1,
                health_check:
                  news.healthCheckPath === undefined
                    ? { port: news.port ?? DEFAULT_PORT }
                    : { http_path: news.healthCheckPath },
                envs,
              },
            ],
            // A `DigitalOcean.cron` schedule runs the same image as a job.
            jobs: collectJobs(bindings as ReadonlyArray<ResourceBinding<AppBinding>>).map(
              (job) => ({
                name: job.name,
                kind: "SCHEDULED",
                schedule: { cron: job.cron, time_zone: job.timeZone },
                image: appImage,
                instance_size_slug: instanceSize,
                envs: [
                  ...envs,
                  { key: JOB_ENV, value: job.name, scope: "RUN_TIME", type: "GENERAL" },
                ],
              }),
            ),
          };

          const observed =
            output !== undefined
              ? yield* observe(output.appId)
              : news.name === undefined
                ? yield* observeByName(name)
                : Option.none<ApiApp>();
          const app = yield* Option.match(observed, {
            onNone: () => DO.createApp({ spec }).pipe(Effect.map((r) => r.app)),
            onSome: (existing) =>
              DO.updateApp({ id: existing.id, spec }).pipe(Effect.map((r) => r.app)),
          });
          const live = yield* waitUntilLive(app.id, tag);
          return {
            appId: live.id,
            urn: `do:app:${live.id}`,
            name: live.spec.name,
            url: live.live_url ?? "",
            region: live.region?.slug,
            imageUri: image.imageUri,
            code: { hash: tag },
          };
        }),
        delete: Effect.fn(function* ({ id, output }) {
          yield* DO.deleteApp({ id: output.appId }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
          const registry = output.imageUri.split("/")[1];
          if (registry !== undefined) {
            yield* DO.deleteRegistryRepository({
              registry_name: registry,
              repository_name: yield* repositoryName(id),
            }).pipe(Effect.catchTag("NotFound", () => Effect.void));
          }
        }),
      };
    }),
  ).pipe(Layer.provide(DockerLive));
