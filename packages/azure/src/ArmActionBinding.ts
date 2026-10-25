import type { Input } from "alchemy/Input";
import type * as Output from "alchemy/Output";
import type { ResourceLike } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { RoleDefinition } from "./Authorization/RoleDefinition.ts";
import * as AzureBindings from "./AzureBindings.ts";

/**
 * Shared scaffolding for the ARM runtime-action bindings (start a streaming
 * job, run a Logic App trigger, stop an Automation job, …): resolves the
 * distilled ARM operation once when the layer is built, fills the request's
 * path identifiers from the bound resource's ARM ID per call, and assigns
 * one custom role with exactly the operation's actions on the bound
 * resource at deploy time.
 *
 * NOT exported from `index.ts`; services wrap it in their own
 * `BindingHttp.ts`.
 */

/** The parts of an ARM resource ID a request's path parameters come from. */
export interface ArmId {
  readonly subscriptionId: string;
  readonly resourceGroupName: string;
  /**
   * Resource names keyed by their lower-cased type segment, e.g.
   * `/…/providers/Microsoft.Automation/automationAccounts/a/runbooks/r` →
   * `{ automationaccounts: "a", runbooks: "r" }`.
   */
  readonly names: Readonly<Record<string, string>>;
}

/** Split an ARM resource ID into its subscription, group and resource names. */
export const parseArmId = (id: string): ArmId => {
  const parts = id.split("/").filter((part) => part.length > 0);
  const at = (key: string) => {
    const index = parts.findIndex((part) => part.toLowerCase() === key);
    return index === -1 ? "" : (parts[index + 1] ?? "");
  };
  const names: Record<string, string> = {};
  const provider = parts.findIndex((part) => part.toLowerCase() === "providers");
  if (provider !== -1) {
    // providers/{namespace}/{type}/{name}[/{type}/{name}]…
    for (let i = provider + 2; i + 1 < parts.length; i += 2) {
      names[parts[i]!.toLowerCase()] = parts[i + 1]!;
    }
  }
  return {
    subscriptionId: at("subscriptions"),
    resourceGroupName: at("resourcegroups"),
    names,
  };
};

/**
 * A custom role (`Azure.Authorization.RoleDefinition`, defined once per
 * stack at the subscription with logical ID `Azure<role>Role`, and assigned
 * only on the bound resource) with exactly `actions`.
 */
export interface ArmActionRole {
  readonly role: string;
  readonly actions: readonly string[];
}

/** One custom role and the ARM ID it is assigned on. */
export interface ArmActionGrant {
  readonly role: ArmActionRole;
  /** Deploy-time only, so it may be a mapped Output. */
  readonly scope: Output.Output<string, never>;
}

/** Assign each grant's role on its scope to the host, creating the custom roles. */
const GrantArmActionRoles = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // Roles are deploy-time resources: a host bundle never declares them.
  const AzureRoleDefinition = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* RoleDefinition;
  return Effect.fn(function* (
    tag: string,
    resource: ResourceLike,
    grants: readonly ArmActionGrant[],
  ) {
    if (!globalThis.__ALCHEMY_RUNTIME__ && AzureRoleDefinition !== undefined) {
      const roleAssignments: Input<AzureBindings.HostRoleAssignment>[] = [];
      for (const { role, scope } of grants) {
        const definition = yield* AzureRoleDefinition(`Azure${role.role}Role`, {
          description: `Alchemy ARM action binding: ${role.actions.join(", ")}`,
          permissions: [{ actions: [...role.actions] }],
        });
        roleAssignments.push({ roleDefinitionId: definition.roleDefinitionId, scope });
      }
      yield* bind`${tag}(${resource})`({ roleAssignments });
    }
  });
});

/**
 * Build the impl Effect for an ARM action on a bound resource. The runtime
 * callable builds the operation's input from the caller's request and
 * `target`'s ARM ID (`subscriptionId`, `resourceGroupName`, resource
 * names); the deploy-time half assigns `role` on `scope` (and the `also`
 * grants).
 */
export const makeArmActionBinding = <Res extends ResourceLike, Req, I, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.Logic.RunWorkflowTrigger`. */
  tag: string;
  /** The distilled ARM operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;
  /** The custom role assigned on `scope`. */
  role: ArmActionRole;
  /**
   * ARM ID the role is assigned on. Deploy-time only, so it may be a
   * mapped Output.
   */
  scope: (resource: Res) => Output.Output<string, never>;
  /**
   * Further roles the operation needs on other resources, e.g. on the
   * storage account an operation reads on the caller's behalf.
   * @default none
   */
  also?: (resource: Res) => readonly ArmActionGrant[];
  /**
   * ARM ID the request identifiers come from: a plain attribute of the
   * bound resource (a mapped Output derives a different runtime key in the
   * host bundle).
   */
  target: (resource: Res) => Output.Output<string, never>;
  /** The operation's input from the caller's request and the target's ID. */
  input: (request: Req, id: ArmId) => I;
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantArmActionRoles;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (resource: Res) {
      yield* grant(options.tag, resource, [
        { role: options.role, scope: options.scope(resource) },
        ...(options.also?.(resource) ?? []),
      ]);
      const targetId = yield* options.target(resource);
      return Effect.fn(`${options.tag}(${resource.LogicalId})`)(function* (request: Req) {
        const id = yield* targetId;
        return yield* op(options.input(request, parseArmId(id)));
      });
    });
  });

/** The `subscriptionId` and `resourceGroupName` path parameters of an ARM ID. */
export const groupOf = (id: ArmId) => ({
  subscriptionId: id.subscriptionId,
  resourceGroupName: id.resourceGroupName,
});
