import * as Azure from "@alchemy.run/azure";
import * as eventgrid from "@distilled.cloud/azure/eventgrid";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./partner.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getRegistration = (resourceGroupName: string, partnerRegistrationName: string) =>
  Effect.gen(function* () {
    return yield* eventgrid.GetPartnerRegistration({
      subscriptionId: yield* subscription,
      resourceGroupName,
      partnerRegistrationName,
    });
  });

const program = (props: { name?: string; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const registration = yield* Azure.EventGrid.PartnerRegistration("Registration", {
      resourceGroup: group.resourceGroupName,
      name: props.name,
      tags: props.tags,
    });
    return { group, registration };
  });

// Partner registrations are free; ~1 minute.
test.provider(
  "create, update, replace, and delete an event grid partner registration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, registration } = yield* stack.deploy(program({ tags: { env: "test" } }));
      expect(registration.partnerRegistrationName).toMatch(/^[A-Za-z0-9-]{3,50}$/);
      expect(registration.partnerRegistrationImmutableId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(registration.tags).toEqual({ env: "test" });
      const observed = yield* getRegistration(
        group.resourceGroupName,
        registration.partnerRegistrationName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.location).toEqual("global");
      expect(observed.tags?.["alchemy::id"]).toEqual("Registration");

      // In place: tags.
      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.registration.partnerRegistrationName).toEqual(
        registration.partnerRegistrationName,
      );
      const reobserved = yield* getRegistration(
        group.resourceGroupName,
        registration.partnerRegistrationName,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: the name.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-test-partner-registration", tags: { env: "prod" } }),
      );
      expect(replaced.registration.partnerRegistrationName).toEqual(
        "alchemy-test-partner-registration",
      );
      const replacement = yield* getRegistration(
        group.resourceGroupName,
        "alchemy-test-partner-registration",
      );
      expect(replacement.properties?.provisioningState).toEqual("Succeeded");
      expect(
        yield* waitGone(
          getRegistration(group.resourceGroupName, registration.partnerRegistrationName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getRegistration(group.resourceGroupName, "alchemy-test-partner-registration"),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
