import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { RoleDefinition } from "../Authorization/RoleDefinition.ts";
import * as AzureBindings from "../AzureBindings.ts";
import type { Instance } from "./Instance.ts";

/**
 * Shared scaffolding for the Digital Twins data-plane bindings: resolves
 * the distilled `digitaltwins-data` operation once when the layer is
 * built, injects the bound instance's endpoint, and assigns the binding's
 * custom role on that instance at deploy time.
 *
 * NOT exported from `index.ts`.
 */

/** Digital Twins data actions (Azure RBAC). */
export const DigitalTwinsDataAction = {
  query: "Microsoft.DigitalTwins/query/action",
  twinRead: "Microsoft.DigitalTwins/digitaltwins/read",
  twinWrite: "Microsoft.DigitalTwins/digitaltwins/write",
  twinDelete: "Microsoft.DigitalTwins/digitaltwins/delete",
  twinCommands: "Microsoft.DigitalTwins/digitaltwins/commands/action",
  /**
   * Sending telemetry checks a twin action Microsoft does not publish, so
   * no custom role can name it; only this wildcard grants it.
   */
  twinAll: "Microsoft.DigitalTwins/digitaltwins/*",
  relationshipRead: "Microsoft.DigitalTwins/digitaltwins/relationships/read",
  relationshipWrite: "Microsoft.DigitalTwins/digitaltwins/relationships/write",
  relationshipDelete: "Microsoft.DigitalTwins/digitaltwins/relationships/delete",
  modelRead: "Microsoft.DigitalTwins/models/read",
  modelWrite: "Microsoft.DigitalTwins/models/write",
  modelDelete: "Microsoft.DigitalTwins/models/delete",
  eventRouteRead: "Microsoft.DigitalTwins/eventroutes/read",
  eventRouteWrite: "Microsoft.DigitalTwins/eventroutes/write",
  eventRouteDelete: "Microsoft.DigitalTwins/eventroutes/delete",
  importJobRead: "Microsoft.DigitalTwins/jobs/imports/read",
  importJobWrite: "Microsoft.DigitalTwins/jobs/imports/write",
  importJobDelete: "Microsoft.DigitalTwins/jobs/imports/delete",
  importJobCancel: "Microsoft.DigitalTwins/jobs/imports/cancel/action",
  deleteJobRead: "Microsoft.DigitalTwins/jobs/delete/read",
  deleteJobWrite: "Microsoft.DigitalTwins/jobs/delete/write",
} as const;

/**
 * A custom role a Digital Twins binding assigns on the bound instance
 * (`Azure.Authorization.RoleDefinition`, defined once per stack at the
 * subscription), with exactly `dataActions`. The built-in roles (**Azure
 * Digital Twins Data Reader** / **Data Owner**) grant every read (or every
 * action) on the instance.
 */
export interface DigitalTwinsGrant {
  readonly role: string;
  readonly dataActions: readonly string[];
}

const A = DigitalTwinsDataAction;

/** Custom role per access kind; the logical ID is `AzureDigitalTwins<role>Role`. */
export const DigitalTwinsRole = {
  Query: { role: "Query", dataActions: [A.query] },
  TwinRead: { role: "TwinRead", dataActions: [A.twinRead] },
  TwinWrite: { role: "TwinWrite", dataActions: [A.twinWrite] },
  TwinDelete: { role: "TwinDelete", dataActions: [A.twinDelete] },
  TwinTelemetry: { role: "TwinTelemetry", dataActions: [A.twinAll] },
  RelationshipRead: { role: "RelationshipRead", dataActions: [A.relationshipRead] },
  RelationshipWrite: { role: "RelationshipWrite", dataActions: [A.relationshipWrite] },
  RelationshipDelete: { role: "RelationshipDelete", dataActions: [A.relationshipDelete] },
  ModelRead: { role: "ModelRead", dataActions: [A.modelRead] },
  ModelWrite: { role: "ModelWrite", dataActions: [A.modelWrite] },
  ModelDelete: { role: "ModelDelete", dataActions: [A.modelDelete] },
  EventRouteRead: { role: "EventRouteRead", dataActions: [A.eventRouteRead] },
  EventRouteWrite: { role: "EventRouteWrite", dataActions: [A.eventRouteWrite] },
  EventRouteDelete: { role: "EventRouteDelete", dataActions: [A.eventRouteDelete] },
  ImportJobRead: { role: "ImportJobRead", dataActions: [A.importJobRead] },
  ImportJobWrite: { role: "ImportJobWrite", dataActions: [A.importJobWrite] },
  ImportJobDelete: { role: "ImportJobDelete", dataActions: [A.importJobDelete] },
  ImportJobCancel: { role: "ImportJobCancel", dataActions: [A.importJobCancel] },
  DeleteJobRead: { role: "DeleteJobRead", dataActions: [A.deleteJobRead] },
  DeleteJobWrite: { role: "DeleteJobWrite", dataActions: [A.deleteJobWrite] },
} as const satisfies Record<string, DigitalTwinsGrant>;

/** Assign `grant` on the instance to the host, creating its custom role. */
const GrantDigitalTwinsRole = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // Roles are deploy-time resources: a host bundle never declares them.
  const AzureRoleDefinition = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* RoleDefinition;
  return Effect.fn(function* (tag: string, instance: Instance, grant: DigitalTwinsGrant) {
    if (!globalThis.__ALCHEMY_RUNTIME__ && AzureRoleDefinition !== undefined) {
      const role = yield* AzureRoleDefinition(`AzureDigitalTwins${grant.role}Role`, {
        description: `Alchemy Digital Twins binding: ${grant.dataActions.join(", ")}`,
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
 * Build the impl Effect for a Digital Twins data-plane operation whose
 * request carries `endpoint`: the runtime callable injects the bound
 * {@link Instance}'s `https://{hostName}` endpoint, and the deploy-time half
 * assigns `grant` on the instance.
 */
export const makeDigitalTwinsHttpBinding = <I extends { endpoint: string }, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.DigitalTwins.GetDigitalTwin`. */
  tag: string;
  /** The distilled operation; the endpoint is injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;
  /** Custom role assigned on the instance. */
  grant: DigitalTwinsGrant;
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantDigitalTwinsRole;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (instance: Instance) {
      yield* grant(options.tag, instance, options.grant);
      const endpoint = yield* Output.interpolate`https://${instance.hostName}`;
      return Effect.fn(`${options.tag}(${instance.LogicalId})`)(function* (
        request?: Omit<I, "endpoint">,
      ) {
        const url = yield* endpoint;
        return yield* op({ ...request, endpoint: url } as I);
      });
    });
  });
