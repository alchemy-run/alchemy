import * as app from "@distilled.cloud/azure/app";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createContainerAppsName,
  fingerprint,
  isEnvironmentOwnedByStack,
  lower,
  matchesDesired,
} from "./common.ts";

/** An app (optionally a revision or label) that receives matched requests. */
export interface HttpRouteTarget {
  /** Name of the container app. */
  containerApp: string;
  /** Revision to route to. */
  revision?: string;
  /** Revision label to route to. */
  label?: string;
}

/** A path match and the rewrite applied to it. */
export interface HttpRouteMatchRule {
  /** Request matcher (set exactly one of `prefix`, `path`, `pathSeparatedPrefix`). */
  match: {
    /** Match every path starting with this string. */
    prefix?: string;
    /** Match this exact path. */
    path?: string;
    /** Match this prefix on `/` segment boundaries. */
    pathSeparatedPrefix?: string;
    /**
     * Whether matching is case sensitive.
     * @default true
     */
    caseSensitive?: boolean;
  };
  /** Action taken on a match. */
  action?: {
    /** Replace the matched prefix with this string. */
    prefixRewrite?: string;
  };
}

/** A routing rule: requests matching `routes` go to `targets`. */
export interface HttpRouteRule {
  /** Destination apps. */
  targets: HttpRouteTarget[];
  /** Path matches. */
  routes: HttpRouteMatchRule[];
  /** Description of the rule. */
  description?: string;
}

/** A custom hostname served by the route config. */
export interface HttpRouteCustomDomain {
  /** Hostname. */
  name: string;
  /** TLS binding type. */
  bindingType?: "Disabled" | "SniEnabled" | "Auto";
  /** ARM ID of an environment certificate for the hostname. */
  certificateId?: string;
}

export interface HttpRouteConfigProps {
  /** Resource group of the environment. Changing it replaces the config. */
  resourceGroup: string;
  /** Name of the Container Apps environment. Changing it replaces the config. */
  environment: string;
  /**
   * Route config name: lowercase letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the config.
   */
  name?: string;
  /** Routing rules, evaluated in order. */
  rules: HttpRouteRule[];
  /** Custom hostnames bound to the route config. */
  customDomains?: HttpRouteCustomDomain[];
}

export interface HttpRouteConfig extends Resource<
  "Azure.ContainerApps.HttpRouteConfig",
  HttpRouteConfigProps,
  {
    /** Name of the route config. */
    routeName: string;
    /** ARM resource ID of the route config. */
    routeId: string;
    /** Name of the environment. */
    environment: string;
    /** Resource group of the environment. */
    resourceGroup: string;
    /** Public hostname of the route config. */
    fqdn: string | undefined;
    /** `https://{fqdn}`. */
    url: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Environment-level HTTP routing for Azure Container Apps
 * (`Microsoft.App/managedEnvironments/httpRouteConfigs`) — one hostname
 * that sends requests to different apps by path, with optional prefix
 * rewrites.
 *
 * Route configs cannot be tagged; Alchemy treats one as owned when its
 * environment is owned by the same stack and stage.
 *
 * @see https://learn.microsoft.com/azure/container-apps/rule-based-routing
 *
 * ### Path-Based Routing
 * **Example:** Split `/api` and `/` across two apps
 * ```typescript
 * const routes = yield* Azure.ContainerApps.HttpRouteConfig("routes", {
 *   resourceGroup: group.resourceGroupName,
 *   environment: env.environmentName,
 *   rules: [
 *     {
 *       targets: [{ containerApp: api.containerAppName }],
 *       routes: [{ match: { prefix: "/api" }, action: { prefixRewrite: "/" } }],
 *     },
 *     {
 *       targets: [{ containerApp: web.containerAppName }],
 *       routes: [{ match: { prefix: "/" } }],
 *     },
 *   ],
 * });
 * // routes.url serves both apps
 * ```
 *
 * @resource
 */
export const HttpRouteConfig = Resource<HttpRouteConfig>(
  "Azure.ContainerApps.HttpRouteConfig",
);

const createRouteName = (id: string) => createContainerAppsName(id, 32);

const getRoute = (
  subscriptionId: string,
  resourceGroupName: string,
  environmentName: string,
  httpRouteName: string,
) =>
  orUndefinedIfNotFound(
    app.GetHttpRouteConfig({
      subscriptionId,
      resourceGroupName,
      environmentName,
      httpRouteName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  environment: string,
  name: string,
  observed: app.GetHttpRouteConfigResponse,
): HttpRouteConfig["Attributes"] => {
  const fqdn = observed.properties?.fqdn;
  return {
    routeName: name,
    routeId: observed.id ?? "",
    environment,
    resourceGroup,
    fqdn,
    url: fqdn === undefined ? undefined : `https://${fqdn}`,
  };
};

const toProperties = (
  props: HttpRouteConfigProps,
): app.HttpRouteConfigPropertiesInput => ({
  rules: props.rules,
  customDomains: props.customDomains ?? [],
});

export const HttpRouteConfigProvider = () =>
  Provider.succeed(HttpRouteConfig, {
    stables: ["routeName", "routeId", "environment", "resourceGroup"],

    // Lives inside an environment; nuke removes it with the environment.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        news.environment !== output.environment ||
        (news.name !== undefined && news.name !== output.routeName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const environment = output?.environment ?? olds?.environment;
      if (resourceGroup === undefined || environment === undefined) {
        return undefined;
      }
      const name =
        output?.routeName ?? olds?.name ?? (yield* createRouteName(id));
      const observed = yield* getRoute(
        subscriptionId,
        resourceGroup,
        environment,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, environment, name, observed);
      return (yield* isEnvironmentOwnedByStack(
        subscriptionId,
        resourceGroup,
        environment,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.App");
      const { resourceGroup, environment } = news;
      const name =
        news.name ?? output?.routeName ?? (yield* createRouteName(id));
      const properties = toProperties(news);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        environmentName: environment,
        httpRouteName: name,
      };
      const get = getRoute(subscriptionId, resourceGroup, environment, name);
      const ready = waitForProvisioned(
        `http route config ${name}`,
        get,
        (route) => route.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* app.HttpRouteConfigCreateOrUpdate({ ...where, properties });
        observed = yield* ready;
      } else {
        observed = yield* ready;
        // Sync: PATCH the rules when the observed config differs (removals
        // are detected against the previous props).
        if (
          !matchesDesired(properties, observed.properties) ||
          (olds !== undefined &&
            fingerprint(properties) !== fingerprint(toProperties(olds)))
        ) {
          yield* app.UpdateHttpRouteConfig({ ...where, properties });
          observed = yield* ready;
        }
      }

      return toAttrs(resourceGroup, environment, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        app.DeleteHttpRouteConfig({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          environmentName: output.environment,
          httpRouteName: output.routeName,
        }),
      );
      yield* waitUntilGone(
        `http route config ${output.routeName}`,
        getRoute(
          subscriptionId,
          output.resourceGroup,
          output.environment,
          output.routeName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),
  });
