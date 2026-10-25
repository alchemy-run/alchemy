import type { Input } from "alchemy/Input";
import * as Effect from "effect/Effect";
import { RoleDefinition } from "../Authorization/RoleDefinition.ts";
import * as AzureBindings from "../AzureBindings.ts";
import type { ProvisioningService } from "./ProvisioningService.ts";

/**
 * Shared scaffolding for the Device Provisioning Service (DPS) service-API
 * bindings: resolves the distilled `deviceprovisioning-data` operation once
 * when the layer is built, injects the bound service's name, and assigns
 * the binding's custom role on that service at deploy time.
 *
 * NOT exported from `index.ts`.
 */

/** DPS service-API data actions (Azure RBAC). */
export const ProvisioningDataAction = {
  enrollmentGroupRead: "Microsoft.Devices/provisioningServices/enrollmentGroups/read",
  enrollmentGroupWrite: "Microsoft.Devices/provisioningServices/enrollmentGroups/write",
  enrollmentGroupDelete: "Microsoft.Devices/provisioningServices/enrollmentGroups/delete",
  enrollmentRead: "Microsoft.Devices/provisioningServices/enrollments/read",
  enrollmentWrite: "Microsoft.Devices/provisioningServices/enrollments/write",
  enrollmentDelete: "Microsoft.Devices/provisioningServices/enrollments/delete",
  registrationStateRead: "Microsoft.Devices/provisioningServices/registrationStates/read",
  registrationStateDelete: "Microsoft.Devices/provisioningServices/registrationStates/delete",
  attestationDetails: "Microsoft.Devices/provisioningServices/attestationmechanism/details/action",
} as const;

/**
 * A custom role a DPS binding assigns on the bound service
 * (`Azure.Authorization.RoleDefinition`, defined once per stack at the
 * subscription), with exactly `dataActions`. The built-in roles (**Device
 * Provisioning Service Data Reader** / **Data Contributor**) grant every read
 * (or every action) on the service.
 */
export interface ProvisioningGrant {
  readonly role: string;
  readonly dataActions: readonly string[];
}

const A = ProvisioningDataAction;

/** Custom role per access kind; the logical ID is `AzureDps<role>Role`. */
export const ProvisioningRole = {
  EnrollmentGroupRead: { role: "EnrollmentGroupRead", dataActions: [A.enrollmentGroupRead] },
  EnrollmentGroupWrite: { role: "EnrollmentGroupWrite", dataActions: [A.enrollmentGroupWrite] },
  EnrollmentGroupDelete: { role: "EnrollmentGroupDelete", dataActions: [A.enrollmentGroupDelete] },
  EnrollmentGroupBulk: {
    role: "EnrollmentGroupBulk",
    dataActions: [A.enrollmentGroupWrite, A.enrollmentGroupDelete],
  },
  EnrollmentRead: { role: "EnrollmentRead", dataActions: [A.enrollmentRead] },
  EnrollmentWrite: { role: "EnrollmentWrite", dataActions: [A.enrollmentWrite] },
  EnrollmentDelete: { role: "EnrollmentDelete", dataActions: [A.enrollmentDelete] },
  EnrollmentBulk: { role: "EnrollmentBulk", dataActions: [A.enrollmentWrite, A.enrollmentDelete] },
  AttestationDetails: { role: "AttestationDetails", dataActions: [A.attestationDetails] },
  RegistrationStateRead: { role: "RegistrationStateRead", dataActions: [A.registrationStateRead] },
  RegistrationStateDelete: {
    role: "RegistrationStateDelete",
    dataActions: [A.registrationStateDelete],
  },
} as const satisfies Record<string, ProvisioningGrant>;

/** Assign `grant` on the service to the host, creating its custom role. */
const GrantProvisioningRole = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // Roles are deploy-time resources: a host bundle never declares them.
  const AzureRoleDefinition = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* RoleDefinition;
  return Effect.fn(function* (tag: string, service: ProvisioningService, grant: ProvisioningGrant) {
    if (!globalThis.__ALCHEMY_RUNTIME__ && AzureRoleDefinition !== undefined) {
      const role = yield* AzureRoleDefinition(`AzureDps${grant.role}Role`, {
        description: `Alchemy Device Provisioning Service binding: ${grant.dataActions.join(", ")}`,
        permissions: [{ dataActions: [...grant.dataActions] }],
      });
      const roleAssignments: Input<AzureBindings.HostRoleAssignment>[] = [
        { roleDefinitionId: role.roleDefinitionId, scope: service.provisioningServiceId },
      ];
      yield* bind`${tag}(${service})`({ roleAssignments });
    }
  });
});

/**
 * Build the impl Effect for a DPS service-API operation whose request
 * carries `dpsName`: the runtime callable injects the bound
 * {@link ProvisioningService}'s name, and the deploy-time half assigns
 * `grant` on the service.
 */
export const makeProvisioningHttpBinding = <I extends { dpsName: string }, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.IoT.GetEnrollmentGroup`. */
  tag: string;
  /** The distilled operation; the service name is injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;
  /** Custom role assigned on the service. */
  grant: ProvisioningGrant;
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantProvisioningRole;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (service: ProvisioningService) {
      yield* grant(options.tag, service, options.grant);
      const dpsName = yield* service.provisioningServiceName;
      return Effect.fn(`${options.tag}(${service.LogicalId})`)(function* (
        request?: Omit<I, "dpsName">,
      ) {
        const name = yield* dpsName;
        return yield* op({ ...request, dpsName: name } as I);
      });
    });
  });
