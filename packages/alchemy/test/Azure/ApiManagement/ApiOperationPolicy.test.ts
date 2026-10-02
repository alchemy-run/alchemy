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

const getPolicy = (
  resourceGroupName: string,
  serviceName: string,
  apiId: string,
  operationId: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetApiOperationPolicy({
      subscriptionId,
      resourceGroupName,
      serviceName,
      apiId,
      operationId,
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
    const { group, service, api } = yield* consumptionApi;
    const operation = yield* Azure.ApiManagement.ApiOperation("Greet", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      apiName: api.apiName,
      name: "greet",
      displayName: "Greet",
      method: "GET",
      urlTemplate: "/greet",
    });
    const created =
      body === undefined
        ? undefined
        : yield* Azure.ApiManagement.ApiOperationPolicy("GreetPolicy", {
            resourceGroup: group.resourceGroupName,
            serviceName: service.serviceName,
            apiName: api.apiName,
            operationName: operation.operationName,
            value: policy(body),
          });
    return { group, service, api, operation, policy: created };
  });

// One Consumption service (no idle cost, ~3 min create, ~5 min delete).
test.provider(
  "set, update, and delete an API operation policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(program("op-one"));
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      const api = first.api.apiName;
      const op = first.operation.operationName;
      expect(first.policy?.operationName).toEqual(op);
      expect(first.policy?.value).toContain("op-one");
      expect((yield* getPolicy(rg, svc, api, op)).properties?.value).toContain(
        "op-one",
      );

      // In-place update of the policy document.
      yield* stack.deploy(program("op-two"));
      const updated = yield* getPolicy(rg, svc, api, op);
      expect(updated.properties?.value).toContain("op-two");
      expect(updated.properties?.value).not.toContain("op-one");

      // Removing the resource deletes the policy while the operation stays.
      yield* stack.deploy(program());
      expect(yield* untilGone(getPolicy(rg, svc, api, op))).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
