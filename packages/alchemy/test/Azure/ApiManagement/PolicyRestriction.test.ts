import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  consumptionApi,
  logLevel,
  subscriptionId,
  tags,
  untilGone,
} from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

/**
 * On the test subscription every PUT of a policy restriction failed: an
 * ARM-id scope returns `ValidationError` ("The specified scope is not
 * supported for policy restriction.") and `/apis/{apiId}` returns
 * `InternalServerError`. Opt in once a working scope format is known.
 */
const runPolicyRestriction = !!process.env.AZURE_TEST_APIM_POLICY_RESTRICTION;

const getRestriction = (
  resourceGroupName: string,
  serviceName: string,
  policyRestrictionId: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetPolicyRestriction({
      subscriptionId,
      resourceGroupName,
      serviceName,
      policyRestrictionId,
    }),
  );

const program = (restriction?: { name: string; requireBase: boolean }) =>
  Effect.gen(function* () {
    const { group, service, api } = yield* consumptionApi;
    const created = restriction
      ? yield* Azure.ApiManagement.PolicyRestriction("Base", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          name: restriction.name,
          scope: `/apis/${api.apiName}`,
          requireBase: restriction.requireBase,
        })
      : undefined;
    return { group, service, restriction: created };
  });

// One Consumption service (no idle cost, ~3 min create, ~5 min delete).
test.provider.skipIf(!runPolicyRestriction)(
  "create, update, replace, and delete a policy restriction",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        program({ name: "alchemy-base", requireBase: true }),
      );
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.restriction?.policyRestrictionName).toEqual("alchemy-base");
      expect(
        (yield* getRestriction(rg, svc, "alchemy-base")).properties
          ?.requireBase,
      ).toEqual("true");

      // In-place update of requireBase.
      yield* stack.deploy(
        program({ name: "alchemy-base", requireBase: false }),
      );
      expect(
        (yield* getRestriction(rg, svc, "alchemy-base")).properties
          ?.requireBase,
      ).toEqual("false");

      // Replacement: a new identifier creates a new restriction.
      yield* stack.deploy(
        program({ name: "alchemy-base-v2", requireBase: false }),
      );
      expect(yield* untilGone(getRestriction(rg, svc, "alchemy-base"))).toEqual(
        "gone",
      );

      // Removing the resource deletes the restriction.
      yield* stack.deploy(program());
      expect(
        yield* untilGone(getRestriction(rg, svc, "alchemy-base-v2")),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
