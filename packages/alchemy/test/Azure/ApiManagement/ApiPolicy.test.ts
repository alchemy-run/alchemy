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

const getApiPolicy = (
  resourceGroupName: string,
  serviceName: string,
  apiId: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetApiPolicy({
      subscriptionId,
      resourceGroupName,
      serviceName,
      apiId,
      policyId: "policy",
    }),
  );

const policy = (body: string) => `<policies>
  <inbound>
    <base />
    <return-response>
      <set-status code="200" reason="OK" />
      <set-body>${body}</set-body>
    </return-response>
  </inbound>
  <backend>
    <base />
  </backend>
  <outbound>
    <base />
  </outbound>
  <on-error>
    <base />
  </on-error>
</policies>`;

const program = (body?: string) =>
  Effect.gen(function* () {
    const { group, service } = yield* consumptionService;
    const api = yield* Azure.ApiManagement.Api("Hello", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      name: "alchemy-policy-api",
      path: "policy",
      serviceUrl: "https://example.com",
    });
    const created =
      body === undefined
        ? undefined
        : yield* Azure.ApiManagement.ApiPolicy("HelloPolicy", {
            resourceGroup: group.resourceGroupName,
            serviceName: service.serviceName,
            apiName: api.apiName,
            value: policy(body),
          });
    return { group, service, api, policy: created };
  });

// One Consumption service (no idle cost, ~3 min create, ~5 min delete).
test.provider(
  "set, update, and delete an API policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(program("hello-one"));
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      const api = first.api.apiName;
      expect(first.policy?.apiName).toEqual(api);
      expect(first.policy?.value).toContain("hello-one");
      const observed = yield* getApiPolicy(rg, svc, api);
      expect(observed.properties?.value).toContain("hello-one");

      // In-place update of the policy document.
      yield* stack.deploy(program("hello-two"));
      const updated = yield* getApiPolicy(rg, svc, api);
      expect(updated.properties?.value).toContain("hello-two");
      expect(updated.properties?.value).not.toContain("hello-one");

      // Removing the resource deletes the API policy while the API stays.
      yield* stack.deploy(program());
      expect(yield* untilGone(getApiPolicy(rg, svc, api))).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
