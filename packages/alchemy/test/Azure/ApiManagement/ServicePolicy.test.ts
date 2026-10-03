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
} from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPolicy = (resourceGroupName: string, serviceName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetPolicy({
      subscriptionId,
      resourceGroupName,
      serviceName,
      policyId: "policy",
    }),
  );

const policy = (header: string) => `<policies>
  <inbound />
  <backend>
    <forward-request />
  </backend>
  <outbound>
    <set-header name="x-alchemy" exists-action="override">
      <value>${header}</value>
    </set-header>
  </outbound>
  <on-error />
</policies>`;

const program = (header?: string) =>
  Effect.gen(function* () {
    const { group, service } = yield* consumptionService;
    const created =
      header === undefined
        ? undefined
        : yield* Azure.ApiManagement.ServicePolicy("Global", {
            resourceGroup: group.resourceGroupName,
            serviceName: service.serviceName,
            value: policy(header),
          });
    return { group, service, policy: created };
  });

// One Consumption service (no idle cost, ~3 min create, ~5 min delete).
test.provider(
  "set, update, and reset the global service policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(program("one"));
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.policy?.value).toContain("x-alchemy");
      const observed = yield* getPolicy(rg, svc);
      expect(observed.properties?.value).toContain("<value>one</value>");

      // In-place update of the policy document.
      yield* stack.deploy(program("two"));
      const updated = yield* getPolicy(rg, svc);
      expect(updated.properties?.value).toContain("<value>two</value>");

      // Removing the resource restores the default global policy.
      yield* stack.deploy(program());
      const reset = yield* getPolicy(rg, svc).pipe(
        Effect.map((p) => p.properties?.value ?? ""),
        Effect.catchTag(["ResourceNotFound", "NotFound"], () =>
          Effect.succeed(""),
        ),
      );
      expect(reset).not.toContain("x-alchemy");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
