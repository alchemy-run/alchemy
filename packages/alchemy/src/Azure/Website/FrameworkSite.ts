import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { AlchemyContext } from "../../AlchemyContext.ts";
import type { MemoOptions } from "../../Command/Memo.ts";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import { ProviderModePolicy } from "../../ProviderMode.ts";
import type { ExtraFile } from "../../Util/extraFiles.ts";
import { initialCwd } from "../../Util/Node.ts";
import {
  staticConfigFromAssets,
  type WebsiteAssetsProps,
  type WebsiteNotFoundHandling,
} from "../../Website/assets.ts";
import { packSiteExtraFiles } from "../../Website/packExtraFiles.ts";
import {
  Server as FrameworkServer,
  type ServerDevProps,
} from "../../Website/Server.ts";
import { ContainerApp } from "../ContainerApps/ContainerApp.ts";
import { ManagedEnvironment } from "../ContainerApps/ManagedEnvironment.ts";
import { Registry } from "../ContainerRegistry/Registry.ts";
import type { Providers } from "../Providers.ts";
import { ResourceGroup } from "../Resources/ResourceGroup.ts";
import { SiteImage } from "./SiteImage.ts";

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* ResourceGroup(...)` and `ResourceGroup(...)` both
 * type-check).
 */
export type Ref<T> = T | Effect.Effect<T, never, Providers>;

const resolveRef = <T>(ref: Ref<T>): Effect.Effect<T, never, Providers> =>
  Effect.isEffect(ref) ? ref : Effect.succeed(ref);

/** Port the Node serve entry listens on inside the container. */
export const DEFAULT_WEBSITE_PORT = 3000;

export type { ServerDevProps, WebsiteAssetsProps, WebsiteNotFoundHandling };
export { staticConfigFromAssets };

/**
 * Props shared by every Azure framework website composite.
 */
export interface FrameworkSiteProps {
  /**
   * Project root directory (the directory containing `package.json`).
   * @default "."
   */
  rootDir?: string;
  /**
   * Controls which files are hashed to decide whether the build re-runs.
   * @default true
   */
  memo?: MemoOptions | boolean;
  /**
   * Options for the local dev server that runs this site under
   * `alchemy dev`.
   */
  dev?: ServerDevProps;
  /**
   * Process environment for the container (and the local framework dev
   * server). Accepts `Output`s (e.g. `VITE_API_URL: api.url`).
   */
  env?: Record<
    string,
    string | Redacted.Redacted<string> | Output.Output<string | undefined>
  >;
  /**
   * Static-asset routing (`notFoundHandling`, `htmlHandling`).
   */
  assets?: WebsiteAssetsProps;
  /**
   * Custom hostname bound to the Container App ingress. The CNAME and
   * `asuid` TXT records must already exist; no certificate is issued
   * (`bindingType: "Disabled"`), so `url` stays the app's
   * `*.azurecontainerapps.io` address.
   */
  domain?: string;
  /**
   * User tags applied to every auto-created Azure resource.
   */
  tags?: Record<string, string>;
  /**
   * Resource group that holds the site. When omitted, one is created
   * under this site's namespace.
   */
  resourceGroup?: Ref<ResourceGroup>;
  /**
   * Azure location for auto-created resources.
   * @default the `Azure.Location` layer, else the profile location
   */
  location?: string;
  /**
   * Container Apps environment the app runs in. When omitted, an
   * `Express` environment is created.
   */
  environment?: Ref<ManagedEnvironment>;
  /**
   * Container registry the image is pushed to. Must have
   * `adminUserEnabled: true`. When omitted, a `Basic` registry is created.
   */
  registry?: Ref<Registry>;
}

/** Per-framework wiring for {@link makeFrameworkSite}. */
export interface FrameworkSiteConfig {
  /** Display name used in error messages (e.g. `"SvelteKit"`). */
  name: string;
  /** Framework-integration module specifier. */
  framework: string;
  /** Node container deploy-target module specifier. */
  target: string;
  /**
   * Framework-specific build options forwarded to the integration (e.g.
   * `{ kit }`, `{ nuxt }`, `{ astro }`). Must be JSON-serializable.
   */
  options?: Record<string, unknown> | undefined;
  /**
   * Assets-only mode: no server modules (or every page prerendered).
   */
  static?:
    | {
        spa?: boolean | undefined;
        errorPage?: string | undefined;
        htmlHandling?: "none" | "drop-trailing-slash" | undefined;
      }
    | undefined;
  /**
   * Vocs/Waku: serve `about/index.html` at `/about`.
   * @default "none"
   */
  htmlHandling?: "none" | "drop-trailing-slash";
  /**
   * Skip baking `clientDirectory` into the image root. Next.js serves
   * `.next` from the image root instead.
   */
  skipClientAssets?: boolean | undefined;
  /**
   * Packages installed into the image instead of bundled (Next.js needs
   * `next` / `react` / `react-dom`).
   */
  install?: string[] | undefined;
}

export interface Website {
  /**
   * Local framework URL under `alchemy dev`, or the Container App's
   * `https://{fqdn}` on deploy.
   */
  readonly url: string | Output.Output<string | undefined> | undefined;
  /** Resource group holding the site. `undefined` during `alchemy dev`. */
  readonly resourceGroup: ResourceGroup | undefined;
  /** Container Apps environment. `undefined` during `alchemy dev`. */
  readonly environment: ManagedEnvironment | undefined;
  /** Registry holding the image. `undefined` during `alchemy dev`. */
  readonly registry: Registry | undefined;
  /** Container App serving the site. `undefined` during `alchemy dev`. */
  readonly app: ContainerApp | undefined;
}

export class FrameworkSiteError extends Data.TaggedError(
  "Azure.Website.FrameworkSiteError",
)<{
  readonly framework: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const unwrapEnv = (
  env:
    | Record<
        string,
        string | Redacted.Redacted<string> | Output.Output<string | undefined>
      >
    | undefined,
): Record<string, string | Output.Output<string | undefined>> | undefined => {
  if (env === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      Redacted.isRedacted(value) ? Redacted.value(value) : value,
    ]),
  );
};

const REGISTRY_PASSWORD_SECRET = "registry-password";

/**
 * Host a built Node serve entry (`main` + `extraFiles`) on Azure Container
 * Apps: resource group → registry → image (built with local Docker and
 * pushed to ACR) → environment → Container App with external ingress.
 */
export const deployContainerSite = Effect.fn(function* (props: {
  readonly site: FrameworkSiteProps;
  readonly main: string;
  readonly extraFiles: ExtraFile[] | undefined;
  readonly install?: string[] | undefined;
}) {
  const { site } = props;
  const port = DEFAULT_WEBSITE_PORT;

  const resourceGroup =
    site.resourceGroup !== undefined
      ? yield* resolveRef(site.resourceGroup)
      : yield* ResourceGroup("ResourceGroup", {
          location: site.location,
          tags: site.tags,
        });

  const registry =
    site.registry !== undefined
      ? yield* resolveRef(site.registry)
      : yield* Registry("Registry", {
          resourceGroup: resourceGroup.resourceGroupName,
          location: site.location,
          sku: "Basic",
          adminUserEnabled: true,
          tags: site.tags,
        });

  const username = Output.map(
    registry.adminUsername,
    (value: string | undefined) => value ?? "",
  );
  const password = Output.map(
    registry.adminPassword,
    (value: Redacted.Redacted<string> | undefined) =>
      value ?? Redacted.make(""),
  );

  const image = yield* SiteImage("Image", {
    main: props.main,
    extraFiles: props.extraFiles,
    install: props.install,
    port,
    repository: "website",
    registry: {
      server: registry.loginServer,
      username,
      password,
    },
  });

  const environment =
    site.environment !== undefined
      ? yield* resolveRef(site.environment)
      : yield* ManagedEnvironment("Environment", {
          resourceGroup: resourceGroup.resourceGroupName,
          location: site.location,
          environmentMode: "Express",
          tags: site.tags,
        });

  const env = Object.entries({
    ...unwrapEnv(site.env),
    PORT: String(port),
  }).map(([name, value]) => ({ name, value }));

  const app = yield* ContainerApp("App", {
    resourceGroup: resourceGroup.resourceGroupName,
    location: site.location,
    environmentId: environment.environmentId,
    configuration: {
      ingress: {
        external: true,
        targetPort: port,
        customDomains:
          site.domain !== undefined
            ? [{ name: site.domain, bindingType: "Disabled" }]
            : undefined,
      },
      registries: [
        {
          server: registry.loginServer,
          username,
          passwordSecretRef: REGISTRY_PASSWORD_SECRET,
        },
      ],
    },
    secrets: [{ name: REGISTRY_PASSWORD_SECRET, value: password }],
    template: {
      containers: [
        {
          name: "web",
          image: image.imageRef,
          env,
          resources: { cpu: 0.5, memory: "1Gi" },
        },
      ],
      scale: { minReplicas: 1, maxReplicas: 1 },
    },
    tags: site.tags,
  });

  return {
    url: app.url,
    resourceGroup,
    environment,
    registry,
    app,
  } satisfies Website;
});

/**
 * Shared implementation behind the Azure framework website composites:
 * build through the Node deploy target, then host the serve entry as a
 * container on Azure Container Apps.
 *
 * During `alchemy dev` the site is the framework's own dev server and no
 * cloud resources are declared; `Alchemy.remote()` opts back into the
 * live deployment.
 */
const runFrameworkSite = Effect.fn("Azure.Website.FrameworkSite")(function* (
  _id: string,
  props: FrameworkSiteProps,
  config: FrameworkSiteConfig,
) {
  const ctx = yield* AlchemyContext;
  const remoted = yield* ProviderModePolicy;
  const isLocal = ctx.dev && remoted !== true;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  if (config.static?.spa && config.static.errorPage) {
    return yield* Effect.die(
      `Cannot provide both "spa" and "errorPage". A SPA answers misses with the index page (200); "errorPage" answers them with a real 404.`,
    );
  }

  const build = yield* FrameworkServer("Build", {
    framework: config.framework,
    target: config.target,
    root: props.rootDir,
    env: unwrapEnv(props.env),
    options: config.options,
    memo: props.memo,
    dev: props.dev,
  });

  if (isLocal) {
    return {
      url: build.url,
      resourceGroup: undefined,
      environment: undefined,
      registry: undefined,
      app: undefined,
    } satisfies Website;
  }

  // The build runs at APPLY time (`Website.Server` is a resource), so its
  // attributes are Outputs here — derive every deploy input lazily.
  const buildOut = Output.mapEffect(
    ([serverEntry, distDir]: [string | undefined, string | undefined]) =>
      Effect.gen(function* () {
        if (serverEntry === undefined || distDir === undefined) {
          return yield* Effect.die(
            new FrameworkSiteError({
              framework: config.framework,
              message: `The ${config.name} build produced no Node serve entry (serverModules[0]). The Node deploy target should write serve-node.mjs.`,
            }),
          );
        }
        const main = path.resolve(initialCwd, serverEntry);
        if (!(yield* fs.exists(main).pipe(Effect.orElseSucceed(() => false)))) {
          return yield* Effect.die(
            new FrameworkSiteError({
              framework: config.framework,
              message: `The ${config.name} build produced no server entry at ${main}`,
            }),
          );
        }
        return { distDir: path.resolve(initialCwd, distDir), main };
      }),
  )(
    Output.all(
      build.serverEntry as unknown as Output.Output<string | undefined>,
      build.distDir as unknown as Output.Output<string | undefined>,
    ) as unknown as Output.Output<[string | undefined, string | undefined]>,
  );
  const main = Output.map(buildOut, (out) => out.main);
  const extraFiles = Output.mapEffect(
    (out: { distDir: string; main: string }) =>
      packSiteExtraFiles(
        out.distDir,
        config.skipClientAssets === true ? "next" : "client",
      ),
  )(buildOut);

  return yield* deployContainerSite({
    site: props,
    main: main as unknown as string,
    extraFiles: extraFiles as unknown as ExtraFile[] | undefined,
    install: config.install,
  });
});

/**
 * Composite-level tagged errors (`FrameworkSiteError`, filesystem) are
 * defects — `Alchemy.Stack` only admits `ConfigError` on the user effect.
 */
export const makeFrameworkSite = (
  id: string,
  props: FrameworkSiteProps,
  config: FrameworkSiteConfig,
) => runFrameworkSite(id, props, config).pipe(Effect.orDie);

/** Push {@link id} then run {@link makeFrameworkSite}. */
export const frameworkSite = (
  id: string,
  props: FrameworkSiteProps,
  config: FrameworkSiteConfig,
) => makeFrameworkSite(id, props, config).pipe(Namespace.push(id));
