import { AlchemyContext } from "alchemy/AlchemyContext";
import type { MemoOptions } from "alchemy/Command/Memo";
import type { Input } from "alchemy/Input";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import { ProviderModePolicy } from "alchemy/ProviderMode";
import type { ExtraFile } from "alchemy/Util/extraFiles";
import { initialCwd } from "alchemy/Util/Node";
import {
  staticConfigFromAssets,
  type WebsiteAssetsProps,
  type WebsiteNotFoundHandling,
} from "alchemy/Website/assets";
import { packSiteExtraFiles } from "alchemy/Website/packExtraFiles";
import { Server as FrameworkServer, type ServerDevProps } from "alchemy/Website/Server";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { AfdEndpoint } from "../Cdn/AfdEndpoint.ts";
import { AfdOrigin } from "../Cdn/AfdOrigin.ts";
import { AfdOriginGroup } from "../Cdn/AfdOriginGroup.ts";
import { Profile } from "../Cdn/Profile.ts";
import { Route } from "../Cdn/Route.ts";
import { Rule } from "../Cdn/Rule.ts";
import { RuleSet } from "../Cdn/RuleSet.ts";
import type { Providers } from "../Providers.ts";
import type { ResourceGroup } from "../Resources/ResourceGroup.ts";
import { stackResourceGroup } from "../StackResourceGroup.ts";
import { StorageAccount } from "../Storage/StorageAccount.ts";
import { AppServicePlan } from "../Web/AppServicePlan.ts";
import { WebApp } from "../Web/WebApp.ts";
import { AppDeployment } from "./AppDeployment.ts";
import { StaticWebsite } from "./StaticWebsite.ts";

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* ResourceGroup(...)` and `ResourceGroup(...)` both
 * type-check).
 */
export type Ref<T> = T | Effect.Effect<T, never, Providers>;

const resolveRef = <T>(ref: Ref<T>): Effect.Effect<T, never, Providers> =>
  Effect.isEffect(ref) ? ref : Effect.succeed(ref);

/** Node.js stack of the App Service web app that runs server builds. */
export const DEFAULT_NODE_STACK = "NODE|22-lts";

/** App Service plan SKU created for server builds when `plan` is omitted. */
export const DEFAULT_PLAN_SKU = "B1";

export type { ServerDevProps, WebsiteAssetsProps, WebsiteNotFoundHandling };
export { staticConfigFromAssets };

/** Put an Azure Front Door (Standard) endpoint in front of the site. */
export interface WebsiteFrontDoorProps {
  /**
   * Existing Front Door profile to add the endpoint to. When omitted, a
   * `Standard_AzureFrontDoor` profile is created. Profiles cost a monthly
   * base fee, so share one across sites.
   */
  profile?: Ref<Profile>;
}

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
   * Environment for the build, the local framework dev server and (for
   * server builds) the web app's app settings. Accepts `Output`s (e.g.
   * `VITE_API_URL: api.url`).
   */
  env?: Record<string, string | Redacted.Redacted<string> | Output.Output<string | undefined>>;
  /**
   * Static-asset routing (`notFoundHandling`, `htmlHandling`).
   */
  assets?: WebsiteAssetsProps;
  /**
   * User tags applied to every auto-created Azure resource.
   */
  tags?: Record<string, string>;
  /**
   * Resource group that holds the site.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup?: Ref<ResourceGroup>;
  /**
   * Azure location for auto-created resources.
   * @default the `Azure.Location` layer, else the profile location
   */
  location?: string;
  /**
   * Storage account whose static website endpoint serves an assets-only
   * build. Alchemy owns its `$web` container. When omitted, a
   * `Standard_LRS` account is created.
   */
  storageAccount?: Ref<StorageAccount>;
  /**
   * App Service plan (Linux) that runs a server build. When omitted, a
   * plan with {@link sku} is created.
   */
  plan?: Ref<AppServicePlan>;
  /**
   * SKU of the App Service plan created for a server build.
   * @default "B1"
   */
  sku?: string;
  /**
   * Serve the site through an Azure Front Door endpoint. Front Door adds a
   * global CDN and, for single-page applications, answers deep links with
   * the index page and a `200` status (the storage endpoint alone answers
   * them with the index page and a `404` status). Front Door rejects a
   * `resourceGroup` whose name is longer than 80 characters.
   * @default false
   */
  frontDoor?: boolean | WebsiteFrontDoorProps;
}

/** Per-framework wiring for {@link makeFrameworkSite}. */
export interface FrameworkSiteConfig {
  /** Display name used in error messages (e.g. `"SvelteKit"`). */
  name: string;
  /** Framework-integration module specifier. */
  framework: string;
  /** Node deploy-target module specifier. */
  target: string;
  /**
   * Framework-specific build options forwarded to the integration (e.g.
   * `{ kit }`, `{ nuxt }`, `{ astro }`). Must be JSON-serializable.
   */
  options?: Record<string, unknown> | undefined;
  /**
   * Assets-only mode: no server modules (or every page prerendered). The
   * build's client directory is published to a storage static website.
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
   * Package `.next`, `public/` and `next.config.*` instead of the client
   * directory. Next.js serves them from the package root.
   */
  skipClientAssets?: boolean | undefined;
  /**
   * Packages installed on App Service (remote build) instead of bundled
   * (Next.js needs `next` / `react` / `react-dom`). Versions come from the
   * project's `package.json`.
   */
  install?: string[] | undefined;
}

export interface WebsiteFrontDoor {
  /** Front Door profile. */
  readonly profile: Profile;
  /** Endpoint that serves the site. */
  readonly endpoint: AfdEndpoint;
}

export interface Website {
  /**
   * Local framework URL under `alchemy dev`; on deploy, the Front Door
   * endpoint, else the storage static website endpoint (assets-only
   * builds) or the web app (server builds).
   */
  readonly url: string | Output.Output<string | undefined> | undefined;
  /**
   * Resource group holding the site. `undefined` during `alchemy dev` and
   * when the stack deploys into an existing group by name.
   */
  readonly resourceGroup: ResourceGroup | undefined;
  /** Storage account serving an assets-only build. */
  readonly storageAccount: StorageAccount | undefined;
  /** Published static website of an assets-only build. */
  readonly assets: StaticWebsite | undefined;
  /** App Service plan running a server build. */
  readonly plan: AppServicePlan | undefined;
  /** Web app running a server build. */
  readonly app: WebApp | undefined;
  /** Front Door in front of the site, when {@link FrameworkSiteProps.frontDoor} is set. */
  readonly frontDoor: WebsiteFrontDoor | undefined;
}

/** A {@link Website} for `alchemy dev`, where only the local URL exists. */
export const localWebsite = (url: Website["url"]): Website => ({
  url,
  resourceGroup: undefined,
  storageAccount: undefined,
  assets: undefined,
  plan: undefined,
  app: undefined,
  frontDoor: undefined,
});

export class FrameworkSiteError extends Data.TaggedError("Azure.Website.FrameworkSiteError")<{
  readonly framework: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const unwrapEnv = (
  env:
    | Record<string, string | Redacted.Redacted<string> | Output.Output<string | undefined>>
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

type SiteLocation = Pick<FrameworkSiteProps, "resourceGroup" | "location" | "tags">;

/**
 * The site's resource group: the `resourceGroup` prop, else the stack's
 * resource group. `group` is `undefined` when the stack deploys into an
 * existing group by name.
 */
const siteResourceGroup = Effect.fn(function* (site: SiteLocation) {
  if (site.resourceGroup !== undefined) {
    const group = yield* resolveRef(site.resourceGroup);
    return { name: group.resourceGroupName, group };
  }
  return yield* stackResourceGroup;
});

/**
 * Put a Front Door endpoint in front of `originHost`. For a single-page
 * application, a rule rewrites extensionless paths to `/index.html` so deep
 * links load the app with a `200` status.
 */
const deployFrontDoor = Effect.fn(function* (props: {
  readonly frontDoor: true | WebsiteFrontDoorProps;
  readonly resourceGroup: Input<string>;
  readonly originHost: string;
  readonly spa: boolean;
  readonly tags: Record<string, string> | undefined;
}) {
  const resourceGroup = props.resourceGroup;
  const options = props.frontDoor === true ? {} : props.frontDoor;
  const profile =
    options.profile !== undefined
      ? yield* resolveRef(options.profile)
      : yield* Profile("FrontDoor", { resourceGroup, tags: props.tags });
  // Child resources live in the profile's own resource group.
  const profileGroup = profile.resourceGroup;
  const endpoint = yield* AfdEndpoint("Endpoint", {
    resourceGroup: profileGroup,
    profile: profile.profileName,
    tags: props.tags,
  });
  const originGroup = yield* AfdOriginGroup("Origins", {
    resourceGroup: profileGroup,
    profile: profile.profileName,
    healthProbeSettings: {
      probePath: "/",
      probeProtocol: "Https",
      probeRequestType: "HEAD",
      probeIntervalInSeconds: 100,
    },
  });
  const origin = yield* AfdOrigin("Origin", {
    resourceGroup: profileGroup,
    profile: profile.profileName,
    originGroup: originGroup.originGroupName,
    hostName: props.originHost,
    originHostHeader: props.originHost,
  });
  let ruleSetIds: Output.Output<string[]> | undefined;
  if (props.spa) {
    const ruleSet = yield* RuleSet("SpaRules", {
      resourceGroup: profileGroup,
      profile: profile.profileName,
    });
    const rule = yield* Rule("SpaFallback", {
      resourceGroup: profileGroup,
      profile: profile.profileName,
      ruleSet: ruleSet.ruleSetName,
      order: 1,
      conditions: [
        {
          name: "UrlFileExtension",
          parameters: {
            typeName: "DeliveryRuleUrlFileExtensionMatchConditionParameters",
            operator: "LessThan",
            negateCondition: false,
            matchValues: ["1"],
            transforms: [],
          },
        },
      ],
      actions: [
        {
          name: "UrlRewrite",
          parameters: {
            typeName: "DeliveryRuleUrlRewriteActionParameters",
            sourcePattern: "/",
            destination: "/index.html",
            preserveUnmatchedPath: false,
          },
        },
      ],
    });
    // The route may attach the rule set only once it holds the rule.
    ruleSetIds = Output.map(
      Output.all(rule.ruleId, ruleSet.ruleSetId),
      ([, ruleSetId]: [string, string]) => [ruleSetId],
    ) as Output.Output<string[]>;
  }
  yield* Route("Route", {
    resourceGroup: profileGroup,
    profile: profile.profileName,
    endpoint: endpoint.endpointName,
    // A route needs an origin group that already holds an origin.
    originGroupId: Output.map(
      Output.all(origin.originId, originGroup.originGroupId),
      ([, originGroupId]: [string, string]) => originGroupId,
    ) as unknown as string,
    ruleSetIds: ruleSetIds as unknown as string[] | undefined,
    supportedProtocols: ["Http", "Https"],
    httpsRedirect: "Enabled",
    forwardingProtocol: "HttpsOnly",
    linkToDefaultDomain: "Enabled",
  });
  return {
    frontDoor: { profile, endpoint } satisfies WebsiteFrontDoor,
    url: Output.map(endpoint.hostName, (host: string) => `https://${host}`),
  };
});

/**
 * Host an assets-only build: resource group → storage account → static
 * website (blob upload) → optional Front Door.
 */
export const deployStaticSite = Effect.fn(function* (props: {
  readonly site: Pick<
    FrameworkSiteProps,
    "resourceGroup" | "location" | "tags" | "storageAccount" | "frontDoor"
  >;
  /** Directory to publish (may be an `Output`). */
  readonly path: string;
  readonly spa: boolean;
  readonly errorPage: string | undefined;
}) {
  const { site } = props;
  const resourceGroup = yield* siteResourceGroup(site);
  const storageAccount =
    site.storageAccount !== undefined
      ? yield* resolveRef(site.storageAccount)
      : yield* StorageAccount("Storage", {
          resourceGroup: resourceGroup.name,
          location: site.location,
          sku: "Standard_LRS",
          tags: site.tags,
        });
  const assets = yield* StaticWebsite("Assets", {
    resourceGroup: storageAccount.resourceGroup,
    storageAccount: storageAccount.storageAccountName,
    path: props.path,
    indexDocument: "index.html",
    errorDocument404Path: props.spa ? "index.html" : props.errorPage,
  });
  const edge =
    site.frontDoor !== undefined && site.frontDoor !== false
      ? yield* deployFrontDoor({
          frontDoor: site.frontDoor,
          resourceGroup: resourceGroup.name,
          originHost: assets.hostName as unknown as string,
          spa: props.spa,
          tags: site.tags,
        })
      : undefined;
  return {
    url: edge?.url ?? assets.url,
    resourceGroup: resourceGroup.group,
    storageAccount,
    assets,
    plan: undefined,
    app: undefined,
    frontDoor: edge?.frontDoor,
  } satisfies Website;
});

/**
 * Host a server build: resource group → Linux App Service plan → Node.js
 * web app → zip deployment of the bundled serve entry → optional Front Door.
 */
export const deployAppServiceSite = Effect.fn(function* (props: {
  readonly site: FrameworkSiteProps;
  /** Node serve entry (may be an `Output`). */
  readonly main: string;
  /** Path of the bundled entry inside the package (may be an `Output`). */
  readonly entry: string;
  /** Startup command, `node <entry>` (may be an `Output`). */
  readonly startup: string;
  readonly extraFiles: ExtraFile[] | undefined;
  readonly install: Record<string, string> | undefined;
}) {
  const { site } = props;
  const resourceGroup = yield* siteResourceGroup(site);
  const plan =
    site.plan !== undefined
      ? yield* resolveRef(site.plan)
      : yield* AppServicePlan("Plan", {
          resourceGroup: resourceGroup.name,
          location: site.location,
          sku: site.sku ?? DEFAULT_PLAN_SKU,
          os: "linux",
          tags: site.tags,
        });
  const env = unwrapEnv(site.env) ?? {};
  const app = yield* WebApp("App", {
    resourceGroup: resourceGroup.name,
    location: site.location,
    serverFarmId: plan.appServicePlanId,
    siteConfig: {
      linuxFxVersion: DEFAULT_NODE_STACK,
      appCommandLine: props.startup,
      ftpsState: "Disabled",
      minTlsVersion: "1.2",
    },
    // App Service passes the listening port in PORT.
    appSettings: {
      ...(env as Record<string, string>),
      HOST: "0.0.0.0",
      ...(props.install !== undefined && Object.keys(props.install).length > 0
        ? { SCM_DO_BUILD_DURING_DEPLOYMENT: "true" }
        : {}),
    },
    tags: site.tags,
  });
  const deployment = yield* AppDeployment("Code", {
    resourceGroup: resourceGroup.name,
    siteName: app.siteName,
    main: props.main,
    entry: props.entry,
    extraFiles: props.extraFiles,
    install: props.install,
  });
  const edge =
    site.frontDoor !== undefined && site.frontDoor !== false
      ? yield* deployFrontDoor({
          frontDoor: site.frontDoor,
          resourceGroup: resourceGroup.name,
          originHost: app.defaultHostName as unknown as string,
          spa: false,
          tags: site.tags,
        })
      : undefined;
  return {
    url: edge?.url ?? deployment.url,
    resourceGroup: resourceGroup.group,
    storageAccount: undefined,
    assets: undefined,
    plan,
    app,
    frontDoor: edge?.frontDoor,
  } satisfies Website;
});

/** Versions of `names` from the project's `package.json` (else `latest`). */
const installVersions = Effect.fn(function* (rootDir: string | undefined, names: string[]) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifest = yield* fs
    .readFileString(path.resolve(initialCwd, rootDir ?? ".", "package.json"))
    .pipe(
      Effect.map(
        (text) =>
          JSON.parse(text) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
          },
      ),
      Effect.orElseSucceed(() => ({}) as { dependencies?: Record<string, string> }),
    );
  const declared = {
    ...("devDependencies" in manifest ? manifest.devDependencies : {}),
    ...manifest.dependencies,
  };
  return Object.fromEntries(
    names.map((name) => {
      const version = declared[name];
      return [
        name,
        version === undefined || version.startsWith("workspace:") || version.startsWith("catalog:")
          ? "latest"
          : version,
      ];
    }),
  );
});

/**
 * Shared implementation behind the Azure framework website composites:
 * build through the Node deploy target, then publish an assets-only build
 * to a storage static website, or run a server build on App Service.
 * Neither path uses Docker.
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
      `Cannot provide both "spa" and "errorPage". A SPA answers misses with the index page; "errorPage" answers them with a real 404.`,
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

  if (isLocal) return localWebsite(build.url);

  if (config.static !== undefined) {
    // The build runs at apply time; its client directory is an Output.
    const clientDir = Output.mapEffect((clientDir: string | undefined) =>
      clientDir === undefined
        ? Effect.die(
            new FrameworkSiteError({
              framework: config.framework,
              message: `The ${config.name} build produced no client directory to publish.`,
            }),
          )
        : Effect.succeed(clientDir),
    )(build.clientDir as unknown as Output.Output<string | undefined>);
    return yield* deployStaticSite({
      site: props,
      path: clientDir as unknown as string,
      spa: config.static.spa === true,
      errorPage: config.static.errorPage,
    });
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
        const dist = path.resolve(initialCwd, distDir);
        // The bundled entry keeps the serve entry's place in the package,
        // so its relative path to the client directory still resolves.
        const entry = path
          .join(path.dirname(path.relative(dist, main)), "index.mjs")
          .split(path.sep)
          .join("/");
        return { distDir: dist, main, entry };
      }),
  )(
    Output.all(
      build.serverEntry as unknown as Output.Output<string | undefined>,
      build.distDir as unknown as Output.Output<string | undefined>,
    ) as unknown as Output.Output<[string | undefined, string | undefined]>,
  );
  const main = Output.map(buildOut, (out) => out.main);
  const entry = Output.map(buildOut, (out) => out.entry);
  const startup = Output.map(buildOut, (out) => `node ${out.entry}`);
  const extraFiles = Output.mapEffect((out: { distDir: string }) =>
    packSiteExtraFiles(out.distDir, config.skipClientAssets === true ? "next" : "client"),
  )(buildOut);
  const install =
    config.install !== undefined && config.install.length > 0
      ? yield* installVersions(props.rootDir, config.install)
      : undefined;

  return yield* deployAppServiceSite({
    site: props,
    main: main as unknown as string,
    entry: entry as unknown as string,
    startup: startup as unknown as string,
    extraFiles: extraFiles as unknown as ExtraFile[] | undefined,
    install,
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
export const frameworkSite = (id: string, props: FrameworkSiteProps, config: FrameworkSiteConfig) =>
  makeFrameworkSite(id, props, config).pipe(Namespace.push(id));
