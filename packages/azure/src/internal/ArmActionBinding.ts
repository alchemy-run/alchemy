import type * as Output from "alchemy/Output";
import type { ResourceLike } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { RoleDefinition } from "../Authorization/RoleDefinition.ts";
import * as AzureBindings from "../AzureBindings.ts";

/**
 * Shared scaffolding for bindings over ARM runtime actions (start, stop,
 * restart, pause, resume, failover, run a pipeline): POST operations on a
 * resource's ARM ID that change what the resource is doing, not how it is
 * configured.
 *
 * Package-internal: services build their `*Http` layers with
 * {@link makeArmActionBinding}.
 */

/**
 * A custom role (`Azure.Authorization.RoleDefinition`) with exactly
 * `actions`, defined once per stack at the subscription and assigned only
 * on the bound resource. The logical ID is `Azure<role>Role`, so every host
 * of the stack shares one definition per binding kind.
 */
export interface ArmActionRole {
  /** Role name suffix, unique across Azure services, e.g. `DataFactoryRunPipeline`. */
  readonly role: string;
  /** The ARM actions the role grants, e.g. `Microsoft.DataFactory/factories/pipelines/createrun/action`. */
  readonly actions: readonly string[];
}

/** The parts of an ARM resource ID. */
export interface ArmResourceId {
  readonly subscriptionId: string;
  readonly resourceGroupName: string;
  /**
   * The name that follows a resource-type segment, case-insensitively:
   * `name("factories")` on `…/factories/etl/pipelines/copy` is `etl`.
   */
  readonly name: (type: string) => string;
}

/** Split an ARM resource ID (`/subscriptions/{s}/resourceGroups/{g}/providers/{ns}/{type}/{name}/…`). */
export const parseArmResourceId = (id: string): ArmResourceId => {
  const segments = id.split("/").filter((segment) => segment.length > 0);
  const valueAfter = (key: string, from = 0) => {
    for (let i = from; i < segments.length - 1; i++) {
      if (segments[i]!.toLowerCase() === key.toLowerCase()) return segments[i + 1]!;
    }
    return "";
  };
  const providers = segments.findIndex((segment) => segment.toLowerCase() === "providers");
  return {
    subscriptionId: valueAfter("subscriptions"),
    resourceGroupName: valueAfter("resourceGroups"),
    // Skip `providers/{namespace}` so a type never matches the namespace.
    name: (type) => valueAfter(type, providers < 0 ? 0 : providers + 2),
  };
};

/** Assign `role` on the resource to the host, creating the custom role. */
const GrantArmActionRole = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // Roles are deploy-time resources: a host bundle never declares them.
  const AzureRoleDefinition = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* RoleDefinition;
  return Effect.fn(function* (
    tag: string,
    resource: ResourceLike,
    scope: Output.Output<string, never>,
    role: ArmActionRole,
  ) {
    if (!globalThis.__ALCHEMY_RUNTIME__ && AzureRoleDefinition !== undefined) {
      const definition = yield* AzureRoleDefinition(`Azure${role.role}Role`, {
        description: `Alchemy binding: ${role.actions.join(", ")}`,
        permissions: [{ actions: [...role.actions] }],
      });
      yield* bind`${tag}(${resource})`({
        roleAssignments: [{ roleDefinitionId: definition.roleDefinitionId, scope }],
      });
    }
  });
});

/**
 * Build the impl Effect of an ARM action binding: the runtime callable fills
 * the bound resource's identifiers (parsed from its ARM ID) into the
 * distilled request, and the deploy-time half assigns `role` on the
 * resource to the host. A binding over more than one resource (a failover
 * group seen from its partner server) derives the one ARM ID it acts on
 * from all of them.
 */
export const makeArmActionBinding = <
  Res extends readonly [ResourceLike, ...ResourceLike[]],
  const K extends string,
  I extends { readonly [P in K]: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.DataFactory.RunPipeline`. */
  tag: string;
  /** The distilled operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;
  /** The custom role assigned on the bound resource. */
  role: ArmActionRole;
  /** ARM ID the action runs on: the role's scope and the request's identifiers. */
  resourceId: (...resources: Res) => Output.Output<string, never>;
  /** The request members the bound resource supplies. */
  identifiers: (id: ArmResourceId) => { readonly [P in K]: string };
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantArmActionRole;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (...resources: Res) {
      const scope = options.resourceId(...resources);
      yield* grant(options.tag, resources[0], scope, options.role);
      const resourceId = yield* scope;
      return Effect.fn(`${options.tag}(${resources[0].LogicalId})`)(function* (
        request?: Omit<I, K>,
      ) {
        const id = yield* resourceId;
        // `I` holds `K` plus `Omit<I, K>`; TS cannot rebuild a generic `I` from them.
        return yield* op({
          ...request,
          ...options.identifiers(parseArmResourceId(id)),
        } as unknown as I);
      });
    });
  });
