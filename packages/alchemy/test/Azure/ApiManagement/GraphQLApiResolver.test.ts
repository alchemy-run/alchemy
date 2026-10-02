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

const getResolver = (
  resourceGroupName: string,
  serviceName: string,
  resolverId: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetGraphQLApiResolver({
      subscriptionId,
      resourceGroupName,
      serviceName,
      apiId: "alchemy-graphql",
      resolverId,
    }),
  );

const program = (resolver?: { name: string; description: string }) =>
  Effect.gen(function* () {
    const { group, service, api, schema } = yield* consumptionGraphQLApi;
    const created = resolver
      ? yield* Azure.ApiManagement.GraphQLApiResolver("Hello", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          apiName: schema.apiName,
          name: resolver.name,
          path: "Query/hello",
          description: resolver.description,
        })
      : undefined;
    return { group, service, api, resolver: created };
  });

// One Consumption service (no idle cost, ~3 min create, ~5 min delete).
test.provider(
  "create, update, replace, and delete a GraphQL resolver",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        program({ name: "alchemy-hello", description: "first" }),
      );
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.resolver?.resolverName).toEqual("alchemy-hello");
      expect(first.resolver?.path).toEqual("Query/hello");
      expect(
        (yield* getResolver(rg, svc, "alchemy-hello")).properties?.description,
      ).toEqual("first");

      // In-place update of the description.
      yield* stack.deploy(
        program({ name: "alchemy-hello", description: "second" }),
      );
      expect(
        (yield* getResolver(rg, svc, "alchemy-hello")).properties?.description,
      ).toEqual("second");

      // Replacement: a new identifier creates a new resolver.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-hello-v2", description: "second" }),
      );
      expect(replaced.resolver?.resolverName).toEqual("alchemy-hello-v2");
      expect(yield* untilGone(getResolver(rg, svc, "alchemy-hello"))).toEqual(
        "gone",
      );

      // Removing the resource deletes the resolver.
      yield* stack.deploy(program());
      expect(
        yield* untilGone(getResolver(rg, svc, "alchemy-hello-v2")),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
