import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as domainregistration from "@distilled.cloud/azure/domainregistration";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { runExpensive, runPaidOnly } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const tags = ["provider:azure", "provider:azure:domainregistration", "live"];

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const subscription = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

const getDomain = (resourceGroupName: string, domainName: string) =>
  Effect.gen(function* () {
    return yield* domainregistration.GetDomain({
      subscriptionId: yield* subscription,
      resourceGroupName,
      domainName,
    });
  });

const waitGone = <A, R>(
  get: Effect.Effect<A, domainregistration.GetDomainError, R>,
) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

/** Domain to purchase in the paid lifecycle test (must be available). */
const domainName =
  process.env.AZURE_TEST_DOMAIN_NAME ?? "alchemy-effect-test-domain.com";
/** Client IP recorded as the legal-agreement consent. */
const agreedBy = process.env.AZURE_TEST_DOMAIN_AGREED_BY ?? "203.0.113.10";

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

const program = (props: {
  autoRenew: boolean;
  tags?: Record<string, string>;
}) =>
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
      autoRenew: props.autoRenew,
      forceHardDelete: true,
      tags: props.tags,
    });
    return { group, domain };
  });

// A real, NON-REFUNDABLE purchase of a DNS domain (~$12 for a .com, billed
// yearly) that takes minutes to register. Free-trial / spending-limit
// subscriptions cannot buy App Service Domains. Never run in CI; requires an
// upgraded subscription, AZURE_TEST_PAID=1, AZURE_TEST_EXPENSIVE=1 and an
// available AZURE_TEST_DOMAIN_NAME. The domain name is the identity, so a
// replacement step would mean a second purchase and is not exercised.
test.provider.skipIf(!runPaidOnly || !runExpensive)(
  "purchase, update, and delete a domain",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, domain } = yield* stack.deploy(
        program({ autoRenew: true, tags: { env: "test" } }),
      );
      const get = getDomain(group.resourceGroupName, domain.domainName);
      expect(domain.domainName).toEqual(domainName);
      expect(domain.location.toLowerCase()).toEqual("global");
      const observed = yield* get;
      expect(observed.properties?.autoRenew).toEqual(true);
      expect(observed.properties?.privacy).toEqual(true);
      expect(observed.tags?.env).toEqual("test");

      // In-place: auto-renew and tags.
      const updated = yield* stack.deploy(
        program({ autoRenew: false, tags: { env: "prod" } }),
      );
      expect(updated.domain.domainId).toEqual(domain.domainId);
      const reobserved = yield* get;
      expect(reobserved.properties?.autoRenew).toEqual(false);
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(yield* waitGone(get)).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free: a resource group plus read-only registrar calls): a
// missing domain is the typed `ResourceNotFound`, and the TLD agreement and
// subscription list APIs the provider relies on respond.
test.provider(
  "a missing domain is reported with a typed not-found error",
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
      const error = yield* getDomain(
        group.resourceGroupName,
        "alchemy-probe-missing.com",
      ).pipe(Effect.flip);
      expect(error._tag).toEqual("ResourceNotFound");

      const subscriptionId = yield* subscription;
      const agreements = yield* domainregistration.ListTopLevelDomainAgreements(
        { subscriptionId, name: "com", includePrivacy: true },
      );
      expect(agreements.value.length).toBeGreaterThan(0);

      const domains = yield* domainregistration.ListDomains({
        subscriptionId,
      });
      expect(Array.isArray(domains.value)).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
