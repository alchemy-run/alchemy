import { Credentials } from "@distilled.cloud/azure";
import { AlchemyContext } from "alchemy/AlchemyContext";
import type { MemoOptions } from "alchemy/Command/Memo";
import type { Input } from "alchemy/Input";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import { ProviderModePolicy } from "alchemy/ProviderMode";
import { initialCwd } from "alchemy/Util/Node";
import {
  staticConfigFromAssets,
  type WebsiteAssetsProps,
  type WebsiteNotFoundHandling,
} from "alchemy/Website/assets";
import { Server as FrameworkServer, type ServerDevProps } from "alchemy/Website/Server";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { BuiltInRole, RoleAssignment } from "../Authorization/RoleAssignment.ts";
import { AfdEndpoint } from "../Cdn/AfdEndpoint.ts";
import { AfdOrigin } from "../Cdn/AfdOrigin.ts";
import { AfdOriginGroup } from "../Cdn/AfdOriginGroup.ts";
import { Profile } from "../Cdn/Profile.ts";
import { Route, type AfdRouteCacheConfiguration } from "../Cdn/Route.ts";
import { Rule } from "../Cdn/Rule.ts";
import { RuleSet } from "../Cdn/RuleSet.ts";
import { Function as AzureFunction } from "../Functions/Function.ts";
import type { Providers } from "../Providers.ts";
import type { ResourceGroup } from "../Resources/ResourceGroup.ts";
import { stackResourceGroup } from "../StackResourceGroup.ts";
import { StorageAccount } from "../Storage/StorageAccount.ts";
import { StaticWebsite } from "./StaticWebsite.ts";

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* ResourceGroup(...)` and `ResourceGroup(...)` both
 * type-check).
 */
export type Ref<T> = T | Effect.Effect<T, never, Providers>;

const resolveRef = <T>(ref: Ref<T>): Effect.Effect<T, never, Providers> =>
  Effect.isEffect(ref) ? ref : Effect.succeed(ref);

export type { ServerDevProps, WebsiteAssetsProps, WebsiteNotFoundHandling };
export { staticConfigFromAssets };

/** Front Door settings of a website. */
export interface WebsiteFrontDoorProps {
  /**
   * Existing Front Door profile to add the site's endpoint to. When
   * omitted, a `Standard_AzureFrontDoor` profile is created. A profile
   * costs a monthly base fee, so share one across sites.
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
   * server builds) the server Function's app settings. Accepts `Output`s
   * (e.g. `VITE_API_URL: api.url`).
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
   * Azure location of the storage account and the server Function. A
   * server build needs a location that offers Flex Consumption.
   * @default the `Azure.Location` layer, else the profile location
   */
  location?: string;
  /**
   * Storage account whose static website endpoint holds the static assets.
   * Alchemy owns its `$web` container. When omitted, a `Standard_LRS`
   * account is created.
   */
  storageAccount?: Ref<StorageAccount>;
  /**
   * Azure Front Door in front of the site, on by default. It caches the
   * assets at the edge, sends a server build's pages to the Function, and
   * answers a single-page application's deep links with `200`. Pass
   * `{ profile }` to add the endpoint to an existing profile. `false`
   * serves an assets-only build straight from the storage endpoint, where
   * deep links answer `404` with the index page; a server build needs Front
   * Door. Front Door rejects a `resourceGroup` whose name is longer than 80
   * characters.
   * @default {}
   */
  frontDoor?: false | WebsiteFrontDoorProps;
  /**
   * Memory per instance of the Function that renders a server build, in MB.
   * @default 2048
   */
  instanceMemoryMB?: 512 | 2048 | 4096;
  /**
   * Maximum number of instances the server Function scales out to (40-1000).
   * @default 100
   */
  maximumInstanceCount?: number;
}

/** Per-framework wiring for {@link makeFrameworkSite}. */
export interface FrameworkSiteConfig {
  /** Display name used in error messages (e.g. `"SvelteKit"`). */
  name: string;
  /** Framework-integration module specifier. */
  framework: string;
  /**
   * Deploy-target module specifier. For a server build it is the
   * framework's Azure target (`@alchemy.run/frontend-frameworks/<fw>/azure`):
   * its server entry default-exports a Fetch handler (`{ fetch(request) }`)
   * that runs on Azure Functions.
   */
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
   * @deprecated Azure Functions ignores it: the framework's Azure target
   * bundles the server, and the client directory goes to Blob Storage.
   */
  skipClientAssets?: boolean | undefined;
  /**
   * @deprecated Azure Functions ignores it: the framework's Azure target
   * bundles every dependency into the server entry.
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
   * endpoint (`https://{endpoint}.azurefd.net`), else the storage static
   * website endpoint.
   */
  readonly url: string | Output.Output<string | undefined> | undefined;
  /**
   * Resource group holding the site. `undefined` during `alchemy dev` and
   * when the stack deploys into an existing group by name.
   */
  readonly resourceGroup: ResourceGroup | undefined;
  /** Storage account holding the static assets. */
  readonly storageAccount: StorageAccount | undefined;
  /** Published static assets (the storage account's `$web` container). */
  readonly assets: StaticWebsite | undefined;
  /** Flex Consumption Function that renders a server build's pages. */
  readonly server: AzureFunction | undefined;
  /** Front Door in front of the site. `undefined` with `frontDoor: false`. */
  readonly frontDoor: WebsiteFrontDoor | undefined;
}

/** A {@link Website} for `alchemy dev`, where only the local URL exists. */
export const localWebsite = (url: Website["url"]): Website => ({
  url,
  resourceGroup: undefined,
  storageAccount: undefined,
  assets: undefined,
  server: undefined,
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

type SiteProps = Pick<
  FrameworkSiteProps,
  | "resourceGroup"
  | "location"
  | "tags"
  | "storageAccount"
  | "frontDoor"
  | "env"
  | "instanceMemoryMB"
  | "maximumInstanceCount"
>;

/**
 * The site's resource group: the `resourceGroup` prop, else the stack's
 * resource group. `group` is `undefined` when the stack deploys into an
 * existing group by name.
 */
const siteResourceGroup = Effect.fn(function* (site: SiteProps) {
  if (site.resourceGroup !== undefined) {
    const group = yield* resolveRef(site.resourceGroup);
    return { name: group.resourceGroupName, group };
  }
  return yield* stackResourceGroup;
});

/** Claims of the deployer's ARM token that identify its principal. */
interface DeployerClaims {
  readonly oid?: string;
  readonly idtyp?: string;
}

/**
 * The deployer's principal (the `oid` claim of its ARM token), so the site
 * can grant it upload access to the storage account.
 */
const deployerPrincipal = Effect.gen(function* () {
  const credentials = yield* Credentials;
  const config = yield* credentials;
  const token = Redacted.value(config.bearerToken);
  const claims = yield* Effect.try(
    () =>
      JSON.parse(
        Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
      ) as DeployerClaims,
  );
  if (claims.oid === undefined) {
    return yield* new FrameworkSiteError({
      framework: "Azure.Website",
      message: "The deployer's Azure token carries no object ID (oid claim).",
    });
  }
  return {
    principalId: claims.oid,
    principalType: claims.idtyp === "user" ? ("User" as const) : ("ServicePrincipal" as const),
  };
});

/** `value`, released only once every `waitFor` resolves (orders one resource after others). */
const after = <A>(value: Output.Output<A>, ...waitFor: Output.Output<unknown>[]) =>
  // `Output.all` over a rest parameter does not infer a tuple, so the first value is cast back.
  Output.map(
    Output.all(value, ...waitFor),
    (values: unknown[]) => values[0] as A,
  ) as Output.Output<A>;

/** Edge caching for routes that serve Blob assets; Front Door honours their `Cache-Control`. */
const ASSET_CACHE: AfdRouteCacheConfiguration = {
  queryStringCachingBehavior: "UseQueryString",
  compressionSettings: {
    isCompressionEnabled: true,
    contentTypesToCompress: [
      "text/html",
      "text/css",
      "text/plain",
      "text/xml",
      "text/javascript",
      "application/javascript",
      "application/json",
      "application/xml",
      "image/svg+xml",
    ],
  },
};

/** Front Door matches at most 100 path patterns per route. */
const MAX_ROUTE_PATTERNS = 100;

/**
 * Front Door path patterns for the top-level entries of a client directory
 * (`/assets/*`, `/favicon.ico`). Directories come first; past the route's
 * limit of 100 the remaining files fall through to the server Function.
 */
const assetPatternsOf = Effect.fn(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(initialCwd, dir);
  const entries = yield* fs.readDirectory(root);
  const names = [...entries].sort();
  const dirs: string[] = [];
  const files: string[] = [];
  for (const name of names) {
    const stat = yield* fs.stat(path.join(root, name));
    if (stat.type === "Directory") dirs.push(`/${name}/*`);
    else if (stat.type === "File") files.push(`/${name}`);
  }
  return [...dirs, ...files].slice(0, MAX_ROUTE_PATTERNS);
});

/**
 * Put a Front Door endpoint in front of the site. An assets-only build gets
 * one cached route to Blob Storage; for a single-page application a rule
 * rewrites extensionless paths to `/index.html` so deep links load with a
 * `200` status. A server build sends `/*` to the Function and the client
 * directory's top-level paths to Blob Storage.
 */
const deployFrontDoor = Effect.fn(function* (props: {
  readonly frontDoor: WebsiteFrontDoorProps;
  readonly resourceGroup: Input<string>;
  readonly assetHost: Input<string>;
  readonly serverHost: Input<string> | undefined;
  readonly assetPatterns: Input<string[]> | undefined;
  readonly spa: boolean;
  readonly tags: Record<string, string> | undefined;
}) {
  const profile =
    props.frontDoor.profile !== undefined
      ? yield* resolveRef(props.frontDoor.profile)
      : yield* Profile("FrontDoor", { resourceGroup: props.resourceGroup, tags: props.tags });
  // Child resources live in the profile's own resource group.
  const where = { resourceGroup: profile.resourceGroup, profile: profile.profileName };
  const endpoint = yield* AfdEndpoint("Endpoint", { ...where, tags: props.tags });

  // One origin per group, so health probes stay off.
  const assetGroup = yield* AfdOriginGroup("Origins", where);
  const assetOrigin = yield* AfdOrigin("Origin", {
    ...where,
    originGroup: assetGroup.originGroupName,
    hostName: props.assetHost,
    originHostHeader: props.assetHost,
  });
  // A route needs an origin group that already holds an origin.
  const assetGroupId = after(assetGroup.originGroupId, assetOrigin.originId);

  const common = {
    ...where,
    endpoint: endpoint.endpointName,
    supportedProtocols: ["Http", "Https"] as ("Http" | "Https")[],
    httpsRedirect: "Enabled" as const,
    forwardingProtocol: "HttpsOnly" as const,
    linkToDefaultDomain: "Enabled" as const,
  };

  if (props.serverHost === undefined) {
    let ruleSetIds: Output.Output<string[]> | undefined;
    if (props.spa) {
      const ruleSet = yield* RuleSet("SpaRules", where);
      const rule = yield* Rule("SpaFallback", {
        ...where,
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
      ruleSetIds = Output.map(after(ruleSet.ruleSetId, rule.ruleId), (id: string) => [id]);
    }
    yield* Route("Route", {
      ...common,
      originGroupId: assetGroupId,
      ruleSetIds,
      patternsToMatch: ["/*"],
      cacheConfiguration: ASSET_CACHE,
    });
  } else {
    const serverGroup = yield* AfdOriginGroup("ServerOrigins", where);
    const serverOrigin = yield* AfdOrigin("ServerOrigin", {
      ...where,
      originGroup: serverGroup.originGroupName,
      hostName: props.serverHost,
      originHostHeader: props.serverHost,
    });
    const serverRoute = yield* Route("Route", {
      ...common,
      originGroupId: after(serverGroup.originGroupId, serverOrigin.originId),
      patternsToMatch: ["/*"],
    });
    // Routes on one endpoint are created one at a time.
    yield* Route("AssetRoute", {
      ...common,
      originGroupId: after(assetGroupId, serverRoute.routeId),
      patternsToMatch: props.assetPatterns,
      cacheConfiguration: ASSET_CACHE,
    });
  }
  return {
    frontDoor: { profile, endpoint } satisfies WebsiteFrontDoor,
    url: Output.map(endpoint.hostName, (host: string) => `https://${host}`),
  };
});

/**
 * Host the site: storage account → deployer upload grant → Front Door
 * (profile, endpoint, origins, routes) → static website upload with purge,
 * plus a Flex Consumption Function as the origin of non-asset paths when
 * the build has a server entry.
 */
export const deploySite = Effect.fn(function* (props: {
  readonly site: SiteProps;
  readonly framework: string;
  /** Directory of static assets to publish. */
  readonly clientDir: Input<string>;
  /** Fetch-handler entry of a server build. */
  readonly serverEntry: Input<string> | undefined;
  /** Front Door path patterns served from Blob Storage on a server build. */
  readonly assetPatterns: Input<string[]> | undefined;
  readonly spa: boolean;
  readonly errorPage: string | undefined;
}) {
  const { site } = props;
  if (props.serverEntry !== undefined && site.frontDoor === false) {
    return yield* new FrameworkSiteError({
      framework: props.framework,
      message: `A server build needs Front Door: it sends pages to the Function and assets to Blob Storage. Remove "frontDoor: false".`,
    });
  }
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

  // The deployer uploads with its Entra token: grant it blob data access.
  const deployer = yield* deployerPrincipal;
  const uploader = yield* RoleAssignment("Uploader", {
    scope: storageAccount.storageAccountId,
    roleDefinitionId: BuiltInRole.StorageBlobDataContributor,
    principalId: deployer.principalId,
    principalType: deployer.principalType,
  });

  const server =
    props.serverEntry !== undefined
      ? yield* AzureFunction("Server", {
          main: props.serverEntry,
          resourceGroup: resourceGroup.name,
          location: site.location,
          env: unwrapEnv(site.env),
          instanceMemoryMB: site.instanceMemoryMB,
          maximumInstanceCount: site.maximumInstanceCount,
          tags: site.tags,
        })
      : undefined;

  const assetHost = Output.mapEffect((web: string | undefined) =>
    web === undefined
      ? Effect.die(
          new FrameworkSiteError({
            framework: props.framework,
            message: "The storage account has no static website endpoint.",
          }),
        )
      : Effect.succeed(new URL(web).hostname),
  )(storageAccount.primaryEndpoints.web);
  const edge =
    site.frontDoor === false
      ? undefined
      : yield* deployFrontDoor({
          frontDoor: site.frontDoor ?? {},
          resourceGroup: resourceGroup.name,
          assetHost,
          serverHost: server?.defaultHostName,
          assetPatterns: props.assetPatterns,
          spa: props.spa && server === undefined,
          tags: site.tags,
        });

  const assets = yield* StaticWebsite("Assets", {
    resourceGroup: storageAccount.resourceGroup,
    // Upload once the deployer's grant exists.
    storageAccount: after(storageAccount.storageAccountName, uploader.roleAssignmentId),
    path: props.clientDir,
    indexDocument: "index.html",
    errorDocument404Path: props.spa ? "index.html" : props.errorPage,
    purge:
      edge === undefined
        ? undefined
        : {
            resourceGroup: edge.frontDoor.profile.resourceGroup,
            profile: edge.frontDoor.profile.profileName,
            endpoint: edge.frontDoor.endpoint.endpointName,
          },
  });
  return {
    url: edge?.url ?? assets.url,
    resourceGroup: resourceGroup.group,
    storageAccount,
    assets,
    server,
    frontDoor: edge?.frontDoor,
  } satisfies Website;
});

/**
 * Shared implementation behind the Azure framework website composites:
 * build through the framework's deploy target, upload the client directory
 * to a storage static website behind Front Door, and run a server build's
 * Fetch handler on a Flex Consumption Function as Front Door's origin for
 * every path that is not an asset. No App Service plan, no containers.
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

  const fail = (message: string, cause?: unknown) =>
    Effect.die(new FrameworkSiteError({ framework: config.framework, message, cause }));

  // The build runs at apply time; its attributes are Outputs here.
  const clientDir = Output.mapEffect((dir: string | undefined) =>
    dir === undefined
      ? fail(`The ${config.name} build produced no client directory to publish.`)
      : Effect.succeed(path.resolve(initialCwd, dir)),
  )(build.clientDir);

  if (config.static !== undefined) {
    return yield* deploySite({
      site: props,
      framework: config.framework,
      clientDir,
      serverEntry: undefined,
      assetPatterns: undefined,
      spa: config.static.spa === true,
      errorPage: config.static.errorPage,
    });
  }

  const serverEntry = Output.mapEffect((entry: string | undefined) =>
    Effect.gen(function* () {
      if (entry === undefined) {
        return yield* fail(
          `The ${config.name} build produced no server entry (serverModules[0]). Its Azure target writes a Fetch handler module.`,
        );
      }
      const main = path.resolve(initialCwd, entry);
      const exists = yield* fs.exists(main).pipe(Effect.orElseSucceed(() => false));
      if (!exists) {
        return yield* fail(`The ${config.name} build produced no server entry at ${main}`);
      }
      return main;
    }),
  )(build.serverEntry);

  const assetPatterns = Output.mapEffect((dir: string) =>
    assetPatternsOf(dir).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.catch((cause) => fail(`Failed to list the ${config.name} client directory.`, cause)),
      Effect.flatMap((patterns) =>
        patterns.length > 0
          ? Effect.succeed(patterns)
          : fail(`The ${config.name} build produced an empty client directory at ${dir}.`),
      ),
    ),
  )(clientDir);

  return yield* deploySite({
    site: props,
    framework: config.framework,
    clientDir,
    serverEntry,
    assetPatterns,
    spa: false,
    errorPage: undefined,
  });
});

/**
 * Composite-level tagged errors (`FrameworkSiteError`, credentials) are
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
