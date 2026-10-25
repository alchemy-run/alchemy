import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { RoleDefinition } from "../Authorization/RoleDefinition.ts";
import * as AzureBindings from "../AzureBindings.ts";
import type { Instance } from "./Instance.ts";

/**
 * Shared scaffolding for the Device Update data-plane bindings: resolves the
 * distilled `deviceupdate-data` operation once when the layer is built,
 * injects the bound instance's account endpoint and instance name, and
 * assigns the binding's custom role on that instance at deploy time.
 *
 * NOT exported from `index.ts`.
 */

/** Device Update data actions (Azure RBAC). */
export const DeviceUpdateDataAction = {
  managementRead: "Microsoft.DeviceUpdate/accounts/instances/management/read",
  managementWrite: "Microsoft.DeviceUpdate/accounts/instances/management/write",
  managementDelete: "Microsoft.DeviceUpdate/accounts/instances/management/delete",
  updatesRead: "Microsoft.DeviceUpdate/accounts/instances/updates/read",
  updatesWrite: "Microsoft.DeviceUpdate/accounts/instances/updates/write",
  updatesDelete: "Microsoft.DeviceUpdate/accounts/instances/updates/delete",
} as const;

/**
 * A custom role a Device Update binding assigns on the bound instance
 * (`Azure.Authorization.RoleDefinition`, defined once per stack at the
 * subscription), with exactly `dataActions`. The built-in roles (Device
 * Update Reader / Administrator / Content / Deployments roles) each grant
 * several data actions.
 */
export interface DeviceUpdateGrant {
  readonly role: string;
  readonly dataActions: readonly string[];
}

const A = DeviceUpdateDataAction;

/** Custom role per access kind; the logical ID is `AzureDeviceUpdate<role>Role`. */
export const DeviceUpdateRole = {
  ManagementRead: { role: "ManagementRead", dataActions: [A.managementRead] },
  ManagementWrite: { role: "ManagementWrite", dataActions: [A.managementWrite] },
  ManagementDelete: { role: "ManagementDelete", dataActions: [A.managementDelete] },
  UpdatesRead: { role: "UpdatesRead", dataActions: [A.updatesRead] },
  UpdatesWrite: { role: "UpdatesWrite", dataActions: [A.updatesWrite] },
  UpdatesDelete: { role: "UpdatesDelete", dataActions: [A.updatesDelete] },
} as const satisfies Record<string, DeviceUpdateGrant>;

/** Assign `grant` on the instance to the host, creating its custom role. */
const GrantDeviceUpdateRole = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // Roles are deploy-time resources: a host bundle never declares them.
  const AzureRoleDefinition = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* RoleDefinition;
  return Effect.fn(function* (tag: string, instance: Instance, grant: DeviceUpdateGrant) {
    if (!globalThis.__ALCHEMY_RUNTIME__ && AzureRoleDefinition !== undefined) {
      const role = yield* AzureRoleDefinition(`AzureDeviceUpdate${grant.role}Role`, {
        description: `Alchemy Device Update binding: ${grant.dataActions.join(", ")}`,
        permissions: [{ dataActions: [...grant.dataActions] }],
      });
      const roleAssignments: Input<AzureBindings.HostRoleAssignment>[] = [
        { roleDefinitionId: role.roleDefinitionId, scope: instance.instanceId },
      ];
      yield* bind`${tag}(${instance})`({ roleAssignments });
    }
  });
});

/**
 * Build the impl Effect for a Device Update data-plane operation whose
 * request carries `endpoint` and `instanceId`: the runtime callable injects
 * the bound {@link Instance}'s account endpoint
 * (`{account}.api.adu.microsoft.com`) and instance name, and the deploy-time
 * half assigns `grant` on the instance.
 */
export const makeDeviceUpdateHttpBinding = <
  I extends { endpoint: string; instanceId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.DeviceUpdate.GetUpdate`. */
  tag: string;
  /** The distilled operation; the endpoint and instance name are injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;
  /** Custom role assigned on the instance. */
  grant: DeviceUpdateGrant;
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantDeviceUpdateRole;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (instance: Instance) {
      yield* grant(options.tag, instance, options.grant);
      const endpoint = yield* Output.interpolate`${instance.accountName}.api.adu.microsoft.com`;
      const instanceName = yield* instance.instanceName;
      return Effect.fn(`${options.tag}(${instance.LogicalId})`)(function* (
        request?: Omit<I, "endpoint" | "instanceId">,
      ) {
        const host = yield* endpoint;
        const name = yield* instanceName;
        return yield* op({ ...request, endpoint: host, instanceId: name } as I);
      });
    });
  });
