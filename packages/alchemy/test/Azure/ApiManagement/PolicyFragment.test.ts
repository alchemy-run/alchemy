import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  consumptionService,
  logLevel,
  subscriptionId,
  tags,
  untilGone,
} from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getFragment = (
  resourceGroupName: string,
  serviceName: string,
  id: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetPolicyFragment({
      subscriptionId,
      resourceGroupName,
      serviceName,
      id,
    }),
  );

const fragment = (value: string) => `<fragment>
  <set-header name="x-served-by" exists-action="override">
    <value>${value}</value>
  </set-header>
</fragment>`;

const program = (spec?: { name: string; value: string }) =>
  Effect.gen(function* () {
    const { group, service } = yield* consumptionService;
    const created = spec
      ? yield* Azure.ApiManagement.PolicyFragment("Stamp", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          name: spec.name,
          description: "Stamps a header",
          value: fragment(spec.value),
        })
      : undefined;
    return { group, service, fragment: created };
  });

// One Consumption service (no idle cost, ~3 min create, ~5 min delete).
test.provider(
  "create, update, replace, and delete a policy fragment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        program({ name: "alchemy-stamp", value: "one" }),
      );
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.fragment?.fragmentName).toEqual("alchemy-stamp");
      const observed = yield* getFragment(rg, svc, "alchemy-stamp");
      expect(observed.properties?.value).toContain("one");
      expect(observed.properties?.description).toEqual("Stamps a header");

      // In-place update of the fragment XML.
      yield* stack.deploy(program({ name: "alchemy-stamp", value: "two" }));
      expect(
        (yield* getFragment(rg, svc, "alchemy-stamp")).properties?.value,
      ).toContain("two");

      // Replacement: a new identifier creates a new fragment.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-stamp-v2", value: "two" }),
      );
      expect(replaced.fragment?.fragmentName).toEqual("alchemy-stamp-v2");
      expect(yield* untilGone(getFragment(rg, svc, "alchemy-stamp"))).toEqual(
        "gone",
      );

      // Removing the resource deletes the fragment.
      yield* stack.deploy(program());
      expect(
        yield* untilGone(getFragment(rg, svc, "alchemy-stamp-v2")),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
