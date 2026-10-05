import * as Azure from "@/Azure";
import { ensureRegistered, orUndefinedIfNotFound } from "@/Azure/Arm";
import * as Test from "@/Test/Alchemy";
import * as managedservices from "@distilled.cloud/azure/managedservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const tags = ["provider:azure", "provider:azure:lighthouse", "live"];

/**
 * Azure validates every authorization's principal against the managing
 * tenant, so the lifecycle needs a second Entra tenant you control plus a
 * principal (user or group object ID) in it: set
 * `AZURE_TEST_LIGHTHOUSE_TENANT_ID` and `AZURE_TEST_LIGHTHOUSE_PRINCIPAL_ID`.
 * A definition alone delegates nothing. Free, < 1 minute.
 */
const managedByTenantId = process.env.AZURE_TEST_LIGHTHOUSE_TENANT_ID;
const principalId = process.env.AZURE_TEST_LIGHTHOUSE_PRINCIPAL_ID;
const hasManagingTenant = !!managedByTenantId && !!principalId;

/** Public Microsoft corporate tenant, used only by the rejection probe. */
const foreignTenantId = "72f988bf-86f1-41af-91ab-2d7cd011db47";
/** A principal object ID that exists in no tenant. */
const missingPrincipalId = "5c3e2b6a-0d4f-4c8e-9a1b-7f6d2e8c4a10";
const Reader = "acdd72a7-3385-48ef-bd42-f606fba81ae7";
const MonitoringReader = "43d0d8ad-25c7-4714-9337-8ba259a9fe05";

const getDefinition = (scope: string, registrationDefinitionId: string) =>
  orUndefinedIfNotFound(
    managedservices.GetRegistrationDefinition({
      scope,
      registrationDefinitionId,
    }),
  );

const definitionGone = (scope: string, registrationDefinitionId: string) =>
  getDefinition(scope, registrationDefinitionId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (observed) => observed === undefined,
      times: 20,
    }),
  );

const program = (props: {
  description?: string;
  roles: string[];
  registrationDefinitionId?: string;
}) =>
  Azure.Lighthouse.RegistrationDefinition("Offer", {
    registrationDefinitionName: "alchemy-test-offer",
    description: props.description,
    managedByTenantId: managedByTenantId!,
    registrationDefinitionId: props.registrationDefinitionId,
    authorizations: props.roles.map((roleDefinitionId) => ({
      principalId: principalId!,
      principalIdDisplayName: "alchemy-test",
      roleDefinitionId,
    })),
  });

test.provider(
  "the home tenant is rejected as the managing tenant",
  (_stack) =>
    Effect.gen(function* () {
      const { subscriptionId, tenantId } =
        yield* Azure.AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ManagedServices");
      const result = yield* managedservices
        .RegistrationDefinitionsCreateOrUpdate({
          scope: `/subscriptions/${subscriptionId}`,
          registrationDefinitionId: "0a1c8d43-6e2f-4b57-9c0d-3f1e2a4b5c6d",
          properties: {
            registrationDefinitionName: "alchemy-home-tenant-probe",
            managedByTenantId: tenantId,
            authorizations: [
              { principalId: missingPrincipalId, roleDefinitionId: Reader },
            ],
          },
        })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "MissingRegistration",
            schedule: Schedule.spaced("10 seconds"),
            times: 30,
          }),
          Effect.result,
        );
      expect(result._tag).toEqual("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toEqual(
          "LighthouseManagedByTenantNotAllowed",
        );
      }
    }).pipe(logLevel),
  { tags, timeout: 300_000 },
);

test.provider(
  "a principal that does not exist in the managing tenant is rejected",
  (_stack) =>
    Effect.gen(function* () {
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ManagedServices");
      const result = yield* managedservices
        .RegistrationDefinitionsCreateOrUpdate({
          scope: `/subscriptions/${subscriptionId}`,
          registrationDefinitionId: "1b2d9e54-7f3a-4c68-8d1e-4a2f3b5c6d7e",
          properties: {
            registrationDefinitionName: "alchemy-invalid-principal-probe",
            managedByTenantId: foreignTenantId,
            authorizations: [
              { principalId: missingPrincipalId, roleDefinitionId: Reader },
            ],
          },
        })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "MissingRegistration",
            schedule: Schedule.spaced("10 seconds"),
            times: 30,
          }),
          Effect.result,
        );
      expect(result._tag).toEqual("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toEqual("LighthouseInvalidPrincipal");
      }
    }).pipe(logLevel),
  { tags, timeout: 300_000 },
);

test.provider.skipIf(!hasManagingTenant)(
  "create, update authorizations and description, replace, and delete a registration definition",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program({ roles: [Reader] }));
      const scope = created.scope;
      expect(scope).toMatch(/^\/subscriptions\/[0-9a-f-]+$/);
      expect(created.registrationDefinitionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(created.managedByTenantId.toLowerCase()).toEqual(
        managedByTenantId!.toLowerCase(),
      );
      expect(created.description).toBeUndefined();
      const observed = yield* getDefinition(
        scope,
        created.registrationDefinitionId,
      );
      expect(observed?.properties?.provisioningState).toEqual("Succeeded");
      expect(observed?.properties?.description).toMatch(
        /^\[alchemy .+\/Offer\]$/,
      );
      expect(
        observed?.properties?.authorizations.map((a) => a.roleDefinitionId),
      ).toEqual([Reader]);

      // Authorizations and description update in place.
      const updated = yield* stack.deploy(
        program({
          description: "monitoring",
          roles: [Reader, MonitoringReader],
        }),
      );
      expect(updated.registrationDefinitionId).toEqual(
        created.registrationDefinitionId,
      );
      expect(updated.description).toEqual("monitoring");
      const reobserved = yield* getDefinition(
        scope,
        created.registrationDefinitionId,
      );
      expect(reobserved?.properties?.description).toMatch(
        /^monitoring \[alchemy /,
      );
      expect(
        reobserved?.properties?.authorizations.map((a) => a.roleDefinitionId),
      ).toEqual([Reader, MonitoringReader]);

      // A new definition GUID replaces it.
      const replacementId = "6f2b9d1e-3c4a-4e8b-a7d5-0c9e1f2a3b4c";
      const replaced = yield* stack.deploy(
        program({
          description: "monitoring",
          roles: [Reader],
          registrationDefinitionId: replacementId,
        }),
      );
      expect(replaced.registrationDefinitionId).toEqual(replacementId);
      expect(
        yield* definitionGone(scope, created.registrationDefinitionId),
      ).toBeUndefined();
      expect(
        (yield* getDefinition(scope, replacementId))?.properties
          ?.provisioningState,
      ).toEqual("Succeeded");

      yield* stack.destroy();
      expect(yield* definitionGone(scope, replacementId)).toBeUndefined();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
