import * as managedservices from "@distilled.cloud/azure/managedservices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Output from "../../Output.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  requireSinglePage,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import {
  deterministicGuid,
  MARKER,
  normalizeScope,
} from "../Authorization/Ownership.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface RegistrationAssignmentProps {
  /**
   * ARM ID of the delegated scope — a subscription (`/subscriptions/{id}`)
   * or a resource group (`group.resourceGroupId`). Changing it replaces the
   * assignment.
   */
  scope: string;
  /**
   * Full ARM ID of the registration definition to project onto the scope,
   * e.g. `definition.registrationDefinitionResourceId`. Changing it replaces
   * the assignment.
   */
  registrationDefinitionId: string;
  /**
   * GUID naming the assignment. If omitted, a deterministic GUID is derived
   * from the app, stage, logical ID, and instance ID. Changing it replaces
   * the assignment.
   */
  registrationAssignmentId?: string;
}

export interface RegistrationAssignment extends Resource<
  "Azure.Lighthouse.RegistrationAssignment",
  RegistrationAssignmentProps,
  {
    /** GUID naming the assignment. */
    registrationAssignmentId: string;
    /** ARM ID, `{scope}/providers/Microsoft.ManagedServices/registrationAssignments/{guid}`. */
    registrationAssignmentResourceId: string;
    /** Delegated scope. */
    scope: string;
    /** Full ARM ID of the projected registration definition. */
    registrationDefinitionId: string;
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Azure Lighthouse registration assignment — delegates a subscription or
 * resource group to a managing tenant by projecting a
 * {@link RegistrationDefinition} onto it. Once it succeeds, the principals in
 * the definition's `authorizations` can work on the scope from their own
 * tenant.
 *
 * Assignments have no tags or description, so the assignment name is a GUID
 * derived from the stack, stage, logical ID, and instance ID; an assignment
 * with any other name is reported as unowned.
 *
 * @see https://learn.microsoft.com/azure/lighthouse/how-to/onboard-customer
 *
 * ### Delegating a Resource Group
 * **Example:** Delegate one resource group to a managing tenant
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("managed", {});
 * const offer = yield* Azure.Lighthouse.RegistrationDefinition("msp-offer", {
 *   managedByTenantId: "00000000-0000-0000-0000-000000000000",
 *   authorizations: [
 *     {
 *       principalId: "11111111-1111-1111-1111-111111111111",
 *       roleDefinitionId: "acdd72a7-3385-48ef-bd42-f606fba81ae7", // Reader
 *     },
 *   ],
 * });
 * yield* Azure.Lighthouse.RegistrationAssignment("msp-delegation", {
 *   scope: group.resourceGroupId,
 *   registrationDefinitionId: offer.registrationDefinitionResourceId,
 * });
 * ```
 *
 * ### Delegating a Subscription
 * **Example:** Delegate the whole subscription
 * ```typescript
 * yield* Azure.Lighthouse.RegistrationAssignment("msp-subscription", {
 *   scope: offer.scope,
 *   registrationDefinitionId: offer.registrationDefinitionResourceId,
 * });
 * ```
 *
 * @resource
 */
export const RegistrationAssignment = Resource<RegistrationAssignment>(
  "Azure.Lighthouse.RegistrationAssignment",
);

const getAssignment = (
  scope: string,
  registrationAssignmentId: string,
  expand = false,
) =>
  orUndefinedIfNotFound(
    managedservices.GetRegistrationAssignment({
      scope,
      registrationAssignmentId,
      _expandRegistrationDefinition: expand || undefined,
    }),
  );

const toAttrs = (
  scope: string,
  guid: string,
  observed: managedservices.RegistrationAssignment,
): RegistrationAssignment["Attributes"] => ({
  registrationAssignmentId: guid,
  registrationAssignmentResourceId:
    observed.id ??
    `${scope}/providers/Microsoft.ManagedServices/registrationAssignments/${guid}`,
  scope,
  registrationDefinitionId: observed.properties?.registrationDefinitionId ?? "",
  provisioningState: observed.properties?.provisioningState,
});

const sameGuid = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

const sameArmId = (a: string, b: string) =>
  normalizeScope(a) === normalizeScope(b);

export const RegistrationAssignmentProvider = () =>
  Provider.succeed(RegistrationAssignment, {
    stables: [
      "registrationAssignmentId",
      "registrationAssignmentResourceId",
      "scope",
      "registrationDefinitionId",
    ],

    // Assignments carry no marker of their own; an assignment is listed when
    // the definition it projects carries Alchemy's description marker.
    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const scope = `/subscriptions/${subscriptionId}`;
      const page = yield* managedservices
        .ListRegistrationAssignments({
          scope,
          _expandRegistrationDefinition: true,
        })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListRegistrationAssignments", page),
          ),
        );
      return (page.value ?? []).flatMap((assignment) => {
        const id = assignment.id;
        const name = assignment.name;
        if (id === undefined || name === undefined) return [];
        const description =
          assignment.properties?.registrationDefinition?.properties
            ?.description ?? "";
        if (!MARKER.test(description)) return [];
        const assignmentScope = id.replace(
          /\/providers\/Microsoft\.ManagedServices\/registrationAssignments\/[^/]+$/i,
          "",
        );
        return [toAttrs(assignmentScope, name, assignment)];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // The whole props object may be one unresolved expression.
      const fields =
        Output.isOutput(news) || Effect.isEffect(news) || Config.isConfig(news)
          ? undefined
          : news;
      if (fields === undefined) return undefined;
      // The definition ID is a stable attribute upstream; an unresolved one
      // means the definition is being replaced.
      if (
        !isResolved(fields.scope) ||
        !isResolved(fields.registrationDefinitionId)
      ) {
        return { action: "replace" } as const;
      }
      if (!isResolved(news)) return undefined;
      if (
        !sameArmId(news.scope, output.scope) ||
        !sameArmId(
          news.registrationDefinitionId,
          output.registrationDefinitionId,
        ) ||
        (news.registrationAssignmentId !== undefined &&
          !sameGuid(
            news.registrationAssignmentId,
            output.registrationAssignmentId,
          ))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output }) {
      const scope = output?.scope ?? olds?.scope;
      // An interrupted create can persist props with unresolved holes;
      // nothing can exist without its scope.
      if (scope === undefined) return undefined;
      const ownedGuid = yield* deterministicGuid(id, instanceId);
      const guid =
        output?.registrationAssignmentId ??
        olds?.registrationAssignmentId ??
        ownedGuid;
      const observed = yield* getAssignment(scope, guid);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, guid, observed);
      return output !== undefined || sameGuid(guid, ownedGuid)
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ManagedServices");
      const scope = news.scope;
      const guid =
        news.registrationAssignmentId ??
        output?.registrationAssignmentId ??
        (yield* deterministicGuid(id, instanceId));

      // Observe.
      const observed = yield* getAssignment(scope, guid);

      // Ensure. The assignment is existence-only: its definition is
      // immutable (a change replaces it), so there is nothing to sync.
      if (
        observed === undefined ||
        observed.properties?.provisioningState === "Failed"
      ) {
        yield* managedservices
          .RegistrationAssignmentsCreateOrUpdate({
            scope,
            registrationAssignmentId: guid,
            properties: {
              registrationDefinitionId: news.registrationDefinitionId,
            },
          })
          .pipe(
            // Microsoft.ManagedServices answers MissingRegistration for
            // minutes after the namespace reports Registered.
            Effect.retry({
              while: (e) => e._tag === "MissingRegistration",
              schedule: Schedule.spaced("10 seconds"),
              times: 30,
            }),
          );
      }

      // The PUT is asynchronous; delegation takes up to a few minutes.
      const fresh = yield* waitForProvisioned(
        `registration assignment ${guid}`,
        getAssignment(scope, guid),
        (assignment) => assignment.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );
      return toAttrs(scope, guid, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        managedservices.DeleteRegistrationAssignment({
          scope: output.scope,
          registrationAssignmentId: output.registrationAssignmentId,
        }),
      );
      yield* waitUntilGone(
        `registration assignment ${output.registrationAssignmentId}`,
        getAssignment(output.scope, output.registrationAssignmentId),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Lighthouse.RegistrationDefinition",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
