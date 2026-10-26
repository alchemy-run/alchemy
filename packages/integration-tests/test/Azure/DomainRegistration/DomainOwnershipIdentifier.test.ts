import * as Azure from "@alchemy.run/azure";
import * as domainregistration from "@distilled.cloud/azure/domainregistration";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { runExpensive, runPaidOnly } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const tags = ["provider:azure", "provider:azure:domainregistration", "live"];

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const subscription = Effect.map(Azure.AzureEnvironment.current, (env) => env.subscriptionId);

const getIdentifier = (resourceGroupName: string, domainName: string, name: string) =>
  Effect.gen(function* () {
    const subscriptionId = yield* subscription;
    return yield* domainregistration.GetDomainOwnershipIdentifier({
      subscriptionId,
      resourceGroupName,
      domainName,
      name,
    });
  });

const waitGone = <A, R>(
  get: Effect.Effect<A, domainregistration.GetDomainOwnershipIdentifierError, R>,
) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound", "NotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

/** Domain to purchase in the paid lifecycle test (must be available). */
const domainName = process.env.AZURE_TEST_DOMAIN_NAME ?? "alchemy-effect-test-domain.com";
/** Client IP recorded as the legal-agreement consent. */
const agreedBy = "203.0.113.10";

const registrant = {
  email: "hostmaster@alchemy.run",
  nameFirst: "Alchemy",
  nameLast: "Test",
  phone: "+1.4255550100",
  addressMailing: {
    address1: "1 Microsoft Way",
    city: "Redmond",
    state: "WA",
    postalCode: "98052",
    country: "US",
  },
};

const FIRST_ID = "A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90";
const SECOND_ID = "0F9E8D7C6B5A49382716F5E4D3C2B1A00F9E8D7C6B5A49382716F5E4D3C2B1A0";

const program = (props: { name: string; ownershipId: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const domain = yield* Azure.DomainRegistration.Domain("Domain", {
      resourceGroup: group.resourceGroupName,
      domainName,
      contactRegistrant: registrant,
      consent: { agreedBy },
      privacy: true,
      autoRenew: false,
      forceHardDelete: true,
    });
    const identifier = yield* Azure.DomainRegistration.DomainOwnershipIdentifier("Identifier", {
      resourceGroup: group.resourceGroupName,
      domainName: domain.domainName,
      name: props.name,
      ownershipId: props.ownershipId,
    });
    return { group, domain, identifier };
  });

// ~$12/run (a real, NON-REFUNDABLE .com purchase), 10+ min: the identifier
// needs a registered App Service Domain. Requires an upgraded subscription,
// AZURE_TEST_PAID=1, AZURE_TEST_EXPENSIVE=1 and an available
// AZURE_TEST_DOMAIN_NAME.
test.provider.skipIf(!runPaidOnly || !runExpensive)(
  "create, update, replace, and delete a domain ownership identifier",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ name: "alchemy-first", ownershipId: FIRST_ID }),
      );
      const rg = created.group.resourceGroupName;
      expect(created.identifier.name).toEqual("alchemy-first");
      expect(created.identifier.ownershipId).toEqual(FIRST_ID);
      const observed = yield* getIdentifier(rg, domainName, "alchemy-first");
      expect(observed.properties?.ownershipId).toEqual(FIRST_ID);

      // In place: the ownership ID.
      const updated = yield* stack.deploy(
        program({ name: "alchemy-first", ownershipId: SECOND_ID }),
      );
      expect(updated.identifier.identifierId).toEqual(created.identifier.identifierId);
      const reobserved = yield* getIdentifier(rg, domainName, "alchemy-first");
      expect(reobserved.properties?.ownershipId).toEqual(SECOND_ID);

      // Replacement: a new name creates a new identifier and deletes the old.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-second", ownershipId: SECOND_ID }),
      );
      expect(replaced.identifier.name).toEqual("alchemy-second");
      expect(yield* waitGone(getIdentifier(rg, domainName, "alchemy-first"))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(getIdentifier(rg, domainName, "alchemy-second"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 1_200_000 },
);

// Ungated probe (free: a resource group only): without a registered domain
// the identifier write fails with ARM's code-less 404 for a missing parent,
// the typed `NotFound`.
test.provider(
  "an identifier on a missing domain fails with a typed not-found",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          return { group };
        }),
      );
      const subscriptionId = yield* subscription;
      const error = yield* domainregistration
        .DomainsCreateOrUpdateOwnershipIdentifier({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          domainName: "alchemy-probe-missing.com",
          name: "alchemy-probe",
          properties: { ownershipId: FIRST_ID },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("NotFound");
      expect(error.message).toContain("parent resource");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 300_000 },
);
