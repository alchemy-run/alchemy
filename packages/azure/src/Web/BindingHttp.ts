import * as Effect from "effect/Effect";
import { RoleDefinition } from "../Authorization/RoleDefinition.ts";
import * as AzureBindings from "../AzureBindings.ts";
import type { FunctionApp } from "./FunctionApp.ts";
import type { WebApp } from "./WebApp.ts";

/**
 * Shared scaffolding for the App Service runtime-action bindings (start,
 * stop, restart an app, sync a Function App's triggers from a running host).
 * NOT exported from `index.ts`: every `{Op}Http.ts` is a thin
 * `Layer.effect(Cap, makeSiteActionBinding({ … }))`.
 *
 * The built-in **Website Contributor** grants every `Microsoft.Web/sites/*`
 * action (configuration, deployments, slots, delete), so each binding kind
 * gets a custom role (`Azure.Authorization.RoleDefinition`, one per stack,
 * defined at the subscription) with exactly its action, assigned only on the
 * bound app.
 */

const SITES = "Microsoft.Web/sites";

/** An App Service app a site action binds to: a Web App or a Function App. */
export type Site = WebApp | FunctionApp;

/** A custom role a binding assigns on the app; the logical ID is `AzureWeb<role>Role`. */
export interface WebGrant {
  readonly role: string;
  readonly actions: readonly string[];
}

/** Custom role per runtime action (Azure RBAC operation names). */
export const WebRole = {
  SiteStart: { role: "SiteStart", actions: [`${SITES}/start/action`] },
  SiteStop: { role: "SiteStop", actions: [`${SITES}/stop/action`] },
  SiteRestart: { role: "SiteRestart", actions: [`${SITES}/restart/action`] },
  SiteSyncFunctionTriggers: {
    role: "SiteSyncFunctionTriggers",
    actions: [`${SITES}/syncfunctiontriggers/action`],
  },
} as const satisfies Record<string, WebGrant>;

/** Attach the binding to its host and assign `grant` on the app. */
const GrantOnSite = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // Roles are deploy-time resources: a host bundle never declares them.
  const AzureRoleDefinition = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* RoleDefinition;
  return Effect.fn(function* (tag: string, site: Site, grant: WebGrant) {
    if (!globalThis.__ALCHEMY_RUNTIME__ && AzureRoleDefinition !== undefined) {
      const role = yield* AzureRoleDefinition(`AzureWeb${grant.role}Role`, {
        description: `Alchemy App Service binding: ${grant.actions.join(", ")}`,
        permissions: [{ actions: [...grant.actions] }],
      });
      yield* bind`${tag}(${site})`({
        roleAssignments: [{ roleDefinitionId: role.roleDefinitionId, scope: site.siteId }],
      });
    }
  });
});

/** Subscription, resource group, and name of an ARM resource ID. */
const parseResourceId = (resourceId: string) => {
  const parts = resourceId.split("/");
  return {
    subscriptionId: parts[2] ?? "",
    resourceGroupName: parts[4] ?? "",
    name: parts[parts.length - 1] ?? "",
  };
};

/** A distilled operation, resolved with the host's credentials. */
type Operation<I, A, E> = Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;

type SiteKeys = "subscriptionId" | "resourceGroupName" | "name";

/**
 * Build the impl Effect for an action on an App Service app ({@link Site}):
 * the runtime callable injects the app's subscription, resource group, and
 * name (parsed from its ARM ID), and the deploy-time half assigns `grant` on
 * the app.
 */
export const makeSiteActionBinding = <
  I extends { subscriptionId: string; resourceGroupName: string; name: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.Web.StartWebApp`. */
  tag: string;
  /** The distilled operation; the app's identifiers are injected. */
  operation: Operation<I, A, E>;
  /** Custom role assigned on the app. */
  grant: WebGrant;
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantOnSite;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (site: Site) {
      yield* grant(options.tag, site, options.grant);
      const siteId = yield* site.siteId;
      return Effect.fn(`${options.tag}(${site.LogicalId})`)(function* (
        request?: Omit<I, SiteKeys>,
      ) {
        const id = yield* siteId;
        const { subscriptionId, resourceGroupName, name } = parseResourceId(id);
        // `Omit<I, K> & Pick<I, K>` is `I`, but TypeScript cannot prove it for a generic `I`.
        return yield* op({ ...request, subscriptionId, resourceGroupName, name } as I);
      });
    });
  });
