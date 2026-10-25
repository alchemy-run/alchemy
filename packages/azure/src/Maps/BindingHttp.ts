import type { Input } from "alchemy/Input";
import * as Effect from "effect/Effect";
import { RoleDefinition } from "../Authorization/RoleDefinition.ts";
import * as AzureBindings from "../AzureBindings.ts";
import type { Account } from "./Account.ts";

/**
 * Shared scaffolding for the Azure Maps bindings: resolves the distilled
 * `maps-*` operation once when the layer is built, sends the bound account's
 * unique ID as `x-ms-client-id` on each call (Microsoft Entra ID calls to
 * Maps must name the account), and assigns the binding's role on the
 * account at deploy time.
 *
 * NOT exported from `index.ts`.
 */

/**
 * Azure Maps data actions (Azure RBAC): one read action per REST service,
 * plus `batch/action`, which the synchronous batch endpoints
 * (`…:batch`) also require.
 */
export const MapsDataAction = {
  batch: "Microsoft.Maps/accounts/services/batch/action",
  geolocation: "Microsoft.Maps/accounts/services/geolocation/read",
  render: "Microsoft.Maps/accounts/services/render/read",
  route: "Microsoft.Maps/accounts/services/route/read",
  search: "Microsoft.Maps/accounts/services/search/read",
  timezone: "Microsoft.Maps/accounts/services/timezone/read",
  traffic: "Microsoft.Maps/accounts/services/traffic/read",
  weather: "Microsoft.Maps/accounts/services/weather/read",
} as const;

/**
 * A custom role (`Azure.Authorization.RoleDefinition`, defined once per
 * stack at the subscription and assigned only on the bound account) with
 * exactly `dataActions`. The built-in roles are broader: **Azure Maps Data
 * Reader** grants `Microsoft.Maps/accounts/*\/read` (every Maps service) and
 * **Azure Maps Search and Render Data Reader** grants both search and render,
 * and **Azure Maps Data Read and Batch Role** grants every service plus
 * batch.
 */
export interface MapsGrant {
  readonly role: string;
  readonly dataActions: readonly string[];
}

/** Custom role per data action; the logical ID is `AzureMaps<role>Role`. */
export const MapsRole = {
  Batch: { role: "Batch", dataActions: [MapsDataAction.batch] },
  GeolocationRead: { role: "GeolocationRead", dataActions: [MapsDataAction.geolocation] },
  RenderRead: { role: "RenderRead", dataActions: [MapsDataAction.render] },
  RouteRead: { role: "RouteRead", dataActions: [MapsDataAction.route] },
  SearchRead: { role: "SearchRead", dataActions: [MapsDataAction.search] },
  TimezoneRead: { role: "TimezoneRead", dataActions: [MapsDataAction.timezone] },
  TrafficRead: { role: "TrafficRead", dataActions: [MapsDataAction.traffic] },
  WeatherRead: { role: "WeatherRead", dataActions: [MapsDataAction.weather] },
} as const satisfies Record<string, MapsGrant>;

/** Assign `grants` on the account to the host, creating the custom roles they name. */
const GrantMapsRoles = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // Roles are deploy-time resources: a host bundle never declares them.
  const AzureRoleDefinition = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* RoleDefinition;
  return Effect.fn(function* (tag: string, account: Account, grants: readonly MapsGrant[]) {
    if (!globalThis.__ALCHEMY_RUNTIME__ && AzureRoleDefinition !== undefined) {
      const roleAssignments: Input<AzureBindings.HostRoleAssignment>[] = [];
      for (const grant of grants) {
        const role = yield* AzureRoleDefinition(`AzureMaps${grant.role}Role`, {
          description: `Alchemy Azure Maps binding: ${grant.dataActions.join(", ")}`,
          permissions: [{ dataActions: [...grant.dataActions] }],
        });
        roleAssignments.push({ roleDefinitionId: role.roleDefinitionId, scope: account.accountId });
      }
      yield* bind`${tag}(${account})`({ roleAssignments });
    }
  });
});

/** A distilled operation, resolved with the host's credentials. */
type Operation<I, A, E> = (input: I) => Effect.Effect<A, E>;

/**
 * Build a per-operation Maps binding: assigns `grants` on the account at
 * deploy and returns `operation` with the account's unique ID sent as
 * `x-ms-client-id`.
 */
export const makeMapsOperationBinding = <I extends { xMsClientId?: string }, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.Maps.GetTimezoneByID`. */
  tag: string;
  /** The distilled `maps-*` operation; `xMsClientId` is injected. */
  operation: Effect.Effect<Operation<I, A, E>, never, any>;
  /** Roles assigned on the account. */
  grants: readonly MapsGrant[];
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantMapsRoles;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (account: Account) {
      yield* grant(options.tag, account, options.grants);
      const clientId = yield* account.uniqueId;
      return Effect.fn(`${options.tag}(${account.LogicalId})`)(function* (
        request: Omit<I, "xMsClientId">,
      ) {
        const xMsClientId = yield* clientId;
        // `Omit<I, "xMsClientId"> & Pick<I, "xMsClientId">` is `I`, but TypeScript
        // cannot prove it for a generic `I`.
        return yield* op({ ...request, xMsClientId } as I);
      });
    });
  });
