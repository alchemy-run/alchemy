import * as managedservices from "@distilled.cloud/azure/managedservices";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
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
  descriptionWithMarker,
  descriptionWithoutMarker,
  deterministicGuid,
  MARKER,
  normalizeScope,
  ownershipMarker,
} from "../Authorization/Ownership.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { sameJson } from "../Resources/Shared.ts";

export type LighthouseAuthorization = managedservices.Authorization;
export type LighthouseEligibleAuthorization =
  managedservices.EligibleAuthorization;
export type LighthousePlan = managedservices.Plan;

export interface RegistrationDefinitionProps {
  /**
   * ARM ID of the subscription the definition is created in
   * (`/subscriptions/{id}`). Changing it replaces the definition.
   * @default the current subscription
   */
  scope?: string;
  /**
   * GUID naming the definition. If omitted, a deterministic GUID is derived
   * from the app, stage, logical ID, and instance ID. Changing it replaces
   * the definition.
   */
  registrationDefinitionId?: string;
  /**
   * Display name of the offer shown to the managing tenant and in the
   * portal's Service providers blade.
   * @default the logical ID
   */
  registrationDefinitionName?: string;
  /**
   * Description of the offer. Alchemy appends an ownership marker
   * (`[alchemy <stack>/<stage>/<id>]`) because registration definitions have
   * no tags.
   */
  description?: string;
  /**
   * Entra tenant ID of the managing ("managed by") tenant whose principals
   * receive access. It must be a different tenant than the subscription's
   * own; Azure rejects the home tenant with
   * `LighthouseManagedByTenantNotAllowed`. Changing it replaces the
   * definition.
   */
  managedByTenantId: string;
  /**
   * Permanent access granted to principals of the managing tenant. Each
   * entry pairs a principal object ID in the managing tenant with a
   * built-in role GUID (for example Reader,
   * `acdd72a7-3385-48ef-bd42-f606fba81ae7`). The Owner role is not allowed;
   * User Access Administrator requires `delegatedRoleDefinitionIds`.
   */
  authorizations: LighthouseAuthorization[];
  /**
   * Just-in-time (PIM) access the managing tenant's principals can
   * activate. Requires Entra ID P2 in the managing tenant.
   */
  eligibleAuthorizations?: LighthouseEligibleAuthorization[];
  /**
   * Azure Marketplace plan of a published managed-service offer. Leave
   * unset for definitions created directly. Changing it replaces the
   * definition.
   */
  plan?: LighthousePlan;
}

export interface RegistrationDefinition extends Resource<
  "Azure.Lighthouse.RegistrationDefinition",
  RegistrationDefinitionProps,
  {
    /** GUID naming the definition. */
    registrationDefinitionId: string;
    /** ARM ID, `{scope}/providers/Microsoft.ManagedServices/registrationDefinitions/{guid}`. */
    registrationDefinitionResourceId: string;
    /** Subscription scope holding the definition. */
    scope: string;
    /** Display name of the offer. */
    registrationDefinitionName: string | undefined;
    /** User description (ownership marker removed). */
    description: string | undefined;
    /** Entra tenant ID of the managing tenant. */
    managedByTenantId: string;
    /** Display name of the managing tenant, as resolved by Azure. */
    managedByTenantName: string | undefined;
    /** Entra tenant ID of the managed (customer) tenant. */
    manageeTenantId: string | undefined;
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Azure Lighthouse registration definition — an offer that describes
 * which principals of another ("managing") Entra tenant get which roles
 * when a subscription or resource group is delegated to it. A definition
 * grants nothing on its own: pair it with a
 * {@link RegistrationAssignment} at the scope you want to delegate.
 *
 * Registration definitions cannot be tagged, so Alchemy records ownership as
 * a `[alchemy <stack>/<stage>/<id>]` marker at the end of the description.
 *
 * @see https://learn.microsoft.com/azure/lighthouse/overview
 *
 * ### Defining an Offer
 * **Example:** Give a managing tenant's group Reader access
 * ```typescript
 * const offer = yield* Azure.Lighthouse.RegistrationDefinition("msp-offer", {
 *   registrationDefinitionName: "Contoso MSP monitoring",
 *   description: "Read-only access for the Contoso operations team",
 *   managedByTenantId: "00000000-0000-0000-0000-000000000000",
 *   authorizations: [
 *     {
 *       principalId: "11111111-1111-1111-1111-111111111111",
 *       principalIdDisplayName: "Contoso Ops",
 *       roleDefinitionId: "acdd72a7-3385-48ef-bd42-f606fba81ae7", // Reader
 *     },
 *   ],
 * });
 * ```
 *
 * ### Just-in-Time Access
 * **Example:** Let an engineer activate Contributor on demand
 * ```typescript
 * yield* Azure.Lighthouse.RegistrationDefinition("msp-jit", {
 *   managedByTenantId: "00000000-0000-0000-0000-000000000000",
 *   authorizations: [
 *     {
 *       principalId: "11111111-1111-1111-1111-111111111111",
 *       roleDefinitionId: "acdd72a7-3385-48ef-bd42-f606fba81ae7",
 *     },
 *   ],
 *   eligibleAuthorizations: [
 *     {
 *       principalId: "22222222-2222-2222-2222-222222222222",
 *       roleDefinitionId: "b24988ac-6180-42a0-ab88-20f7382dd24c", // Contributor
 *       justInTimeAccessPolicy: {
 *         multiFactorAuthProvider: "Azure",
 *         maximumActivationDuration: "PT8H",
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const RegistrationDefinition = Resource<RegistrationDefinition>(
  "Azure.Lighthouse.RegistrationDefinition",
);

const getDefinition = (scope: string, registrationDefinitionId: string) =>
  orUndefinedIfNotFound(
    managedservices.GetRegistrationDefinition({
      scope,
      registrationDefinitionId,
    }),
  );

const toAttrs = (
  scope: string,
  guid: string,
  observed: managedservices.RegistrationDefinition,
): RegistrationDefinition["Attributes"] => ({
  registrationDefinitionId: guid,
  registrationDefinitionResourceId:
    observed.id ??
    `${scope}/providers/Microsoft.ManagedServices/registrationDefinitions/${guid}`,
  scope,
  registrationDefinitionName: observed.properties?.registrationDefinitionName,
  description: descriptionWithoutMarker(observed.properties?.description),
  managedByTenantId: observed.properties?.managedByTenantId ?? "",
  managedByTenantName: observed.properties?.managedByTenantName,
  manageeTenantId: observed.properties?.manageeTenantId,
  provisioningState: observed.properties?.provisioningState,
});

const defaultScope = Effect.gen(function* () {
  const { subscriptionId } = yield* AzureEnvironment.current;
  return `/subscriptions/${subscriptionId}`;
});

const sameGuid = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

export const RegistrationDefinitionProvider = () =>
  Provider.succeed(RegistrationDefinition, {
    stables: [
      "registrationDefinitionId",
      "registrationDefinitionResourceId",
      "scope",
      "managedByTenantId",
      "manageeTenantId",
    ],

    list: Effect.fn(function* () {
      const scope = yield* defaultScope;
      const page = yield* managedservices
        .ListRegistrationDefinitions({ scope })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListRegistrationDefinitions", page),
          ),
        );
      return (page.value ?? []).flatMap((definition) =>
        MARKER.test(definition.properties?.description ?? "") &&
        definition.name !== undefined
          ? [toAttrs(scope, definition.name, definition)]
          : [],
      );
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      if (!isResolved(news)) return undefined;
      const scope = news.scope ?? output.scope;
      if (
        normalizeScope(scope) !== normalizeScope(output.scope) ||
        (news.registrationDefinitionId !== undefined &&
          !sameGuid(
            news.registrationDefinitionId,
            output.registrationDefinitionId,
          )) ||
        !sameGuid(news.managedByTenantId, output.managedByTenantId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output }) {
      const scope = output?.scope ?? olds?.scope ?? (yield* defaultScope);
      const guid =
        output?.registrationDefinitionId ??
        olds?.registrationDefinitionId ??
        (yield* deterministicGuid(id, instanceId));
      const observed = yield* getDefinition(scope, guid);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, guid, observed);
      const marker = yield* ownershipMarker(id);
      return (observed.properties?.description ?? "").endsWith(marker)
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ManagedServices");
      const scope = news.scope ?? (yield* defaultScope);
      const guid =
        news.registrationDefinitionId ??
        output?.registrationDefinitionId ??
        (yield* deterministicGuid(id, instanceId));
      const desired: managedservices.RegistrationDefinitionPropertiesInput = {
        registrationDefinitionName: news.registrationDefinitionName ?? id,
        description: descriptionWithMarker(
          news.description,
          yield* ownershipMarker(id),
        ),
        managedByTenantId: news.managedByTenantId,
        authorizations: news.authorizations,
        eligibleAuthorizations: news.eligibleAuthorizations,
      };

      // Observe.
      const observed = yield* getDefinition(scope, guid);

      // Ensure + sync: the PUT is a full-body upsert, so send it only when
      // the definition is missing or an observed property differs.
      const current = observed?.properties;
      const drifted =
        current === undefined ||
        current.registrationDefinitionName !==
          desired.registrationDefinitionName ||
        current.description !== desired.description ||
        !sameGuid(current.managedByTenantId, desired.managedByTenantId) ||
        !sameJson(current.authorizations, desired.authorizations) ||
        !sameJson(
          current.eligibleAuthorizations ?? [],
          desired.eligibleAuthorizations ?? [],
        ) ||
        (news.plan !== undefined && !sameJson(observed?.plan, news.plan));
      if (drifted) {
        yield* managedservices
          .RegistrationDefinitionsCreateOrUpdate({
            scope,
            registrationDefinitionId: guid,
            properties: desired,
            plan: news.plan,
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

      const fresh = yield* waitForProvisioned(
        `registration definition ${guid}`,
        getDefinition(scope, guid),
        (definition) => definition.properties?.provisioningState,
        { interval: "3 seconds", times: 40 },
      );
      return toAttrs(scope, guid, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        managedservices.DeleteRegistrationDefinition({
          scope: output.scope,
          registrationDefinitionId: output.registrationDefinitionId,
        }),
      );
      yield* waitUntilGone(
        `registration definition ${output.registrationDefinitionId}`,
        getDefinition(output.scope, output.registrationDefinitionId),
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup"],
    },
  });
