import type { Input } from "alchemy/Input";
import * as Effect from "effect/Effect";
import { RoleDefinition } from "../Authorization/RoleDefinition.ts";
import * as AzureBindings from "../AzureBindings.ts";
import type { DeidService } from "./DeidService.ts";

/**
 * Shared scaffolding for the de-identification service data-plane
 * bindings: resolves the distilled `healthdataaiservices-data` operation
 * once when the layer is built, injects the bound service's `serviceUrl`,
 * and assigns the binding's role on that service at deploy time.
 *
 * NOT exported from `index.ts`.
 */

const DEID = "Microsoft.HealthDataAIServices/DeidServices";

/** De-identification service data actions (Azure RBAC). */
export const DeidDataAction = {
  realtime: `${DEID}/Realtime/action`,
  batchRead: `${DEID}/Batch/read`,
  batchWrite: `${DEID}/Batch/write`,
  batchDelete: `${DEID}/Batch/delete`,
} as const;

/**
 * The role a binding assigns on the bound service: a built-in role whose
 * data actions are exactly what the operation calls, or a custom role
 * (`Azure.Authorization.RoleDefinition`, one per stack, logical ID
 * `AzureDeid<role>Role`) when every built-in role grants more.
 */
export type DeidGrant =
  | { readonly builtIn: string }
  | { readonly role: string; readonly dataActions: readonly string[] };

const A = DeidDataAction;

/** The roles the de-identification bindings assign. */
export const DeidRole = {
  /** Built-in **DeID Realtime Data User**: exactly `Realtime/action`. */
  RealtimeUser: { builtIn: "bb6577c4-ea0a-40b2-8962-ea18cb8ecd4e" },
  /** Built-in **DeID Batch Data Reader**: exactly `Batch/read`. */
  BatchReader: { builtIn: "b73a14ee-91f5-41b7-bd81-920e12466be9" },
  /**
   * Custom role with `Batch/write` only. The built-in **DeID Batch Data
   * Owner** also grants `Batch/read` and `Batch/delete`.
   */
  BatchWrite: { role: "BatchWrite", dataActions: [A.batchWrite] },
  /**
   * Custom role with `Batch/delete` only. The built-in **DeID Batch Data
   * Owner** also grants `Batch/read` and `Batch/write`.
   */
  BatchDelete: { role: "BatchDelete", dataActions: [A.batchDelete] },
} as const satisfies Record<string, DeidGrant>;

/** Assign `grant` on the service to the host, creating its custom role. */
const GrantDeidRole = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // Roles are deploy-time resources: a host bundle never declares them.
  const AzureRoleDefinition = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* RoleDefinition;
  return Effect.fn(function* (tag: string, service: DeidService, grant: DeidGrant) {
    if (!globalThis.__ALCHEMY_RUNTIME__ && AzureRoleDefinition !== undefined) {
      let roleDefinitionId: Input<string>;
      if ("builtIn" in grant) {
        roleDefinitionId = grant.builtIn;
      } else {
        const role = yield* AzureRoleDefinition(`AzureDeid${grant.role}Role`, {
          description: `Alchemy de-identification binding: ${grant.dataActions.join(", ")}`,
          permissions: [{ dataActions: [...grant.dataActions] }],
        });
        roleDefinitionId = role.roleDefinitionId;
      }
      const roleAssignments: Input<AzureBindings.HostRoleAssignment>[] = [
        { roleDefinitionId, scope: service.deidServiceId },
      ];
      yield* bind`${tag}(${service})`({ roleAssignments });
    }
  });
});

/**
 * Build the impl Effect for a de-identification data-plane operation: the
 * runtime callable injects the bound {@link DeidService}'s `serviceUrl` as
 * `endpoint`, and the deploy-time half assigns `grant` on the service.
 */
export const makeDeidHttpBinding = <I extends { endpoint: string }, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.HealthDataAIServices.DeidentifyText`. */
  tag: string;
  /** The distilled operation; the endpoint is injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;
  /** Role assigned on the service. */
  grant: DeidGrant;
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantDeidRole;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (service: DeidService) {
      yield* grant(options.tag, service, options.grant);
      const serviceUrl = yield* service.serviceUrl;
      return Effect.fn(`${options.tag}(${service.LogicalId})`)(function* (
        request?: Omit<I, "endpoint">,
      ) {
        const endpoint = yield* serviceUrl;
        // `Omit<I, "endpoint"> & { endpoint }` is `I`, but TypeScript cannot prove it for a generic `I`.
        return yield* op({ ...request, endpoint: endpoint ?? "" } as I);
      });
    });
  });
