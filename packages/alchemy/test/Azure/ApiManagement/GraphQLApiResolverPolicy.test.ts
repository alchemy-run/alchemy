import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  consumptionGraphQLApi,
  logLevel,
  subscriptionId,
  tags,
  untilGone,
} from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPolicy = (resourceGroupName: string, serviceName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetGraphQLApiResolverPolicy({
      subscriptionId,
      resourceGroupName,
      serviceName,
      apiId: "alchemy-graphql",
      resolverId: "alchemy-users",
      policyId: "policy",
    }),
  );

const dataSource = (path: string) => `<http-data-source>
  <http-request>
    <set-method>GET</set-method>
    <set-url>https://example.com/${path}</set-url>
  </http-request>
</http-data-source>`;

const program = (path?: string) =>
  Effect.gen(function* () {
    const { group, service, schema } = yield* consumptionGraphQLApi;
    const resolver = yield* Azure.ApiManagement.GraphQLApiResolver("Users", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      apiName: schema.apiName,
      name: "alchemy-users",
      path: "Query/users",
    });
    const policy =
      path === undefined
        ? undefined
        : yield* Azure.ApiManagement.GraphQLApiResolverPolicy("UsersPolicy", {
            resourceGroup: group.resourceGroupName,
            serviceName: service.serviceName,
            apiName: schema.apiName,
            resolverName: resolver.resolverName,
            value: dataSource(path),
          });
    return { group, service, policy };
  });

// One Consumption service (no idle cost, ~3 min create, ~5 min delete).
test.provider(
  "set, update, and delete a GraphQL resolver policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(program("users"));
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.policy?.resolverName).toEqual("alchemy-users");
      expect((yield* getPolicy(rg, svc)).properties?.value).toContain(
        "https://example.com/users",
      );

      // In-place update of the data source.
      yield* stack.deploy(program("people"));
      expect((yield* getPolicy(rg, svc)).properties?.value).toContain(
        "https://example.com/people",
      );

      // Removing the resource deletes the policy while the resolver stays.
      yield* stack.deploy(program());
      expect(yield* untilGone(getPolicy(rg, svc))).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
