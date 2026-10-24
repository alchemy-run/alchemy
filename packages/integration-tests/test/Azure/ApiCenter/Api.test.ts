import * as Azure from "@alchemy.run/azure";
import * as apicenter from "@distilled.cloud/azure/apicenter";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { apiCenter, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: { name: string; title: string; summary?: string }) =>
  Effect.gen(function* () {
    const { group, center } = yield* apiCenter;
    const api = yield* Azure.ApiCenter.Api("Orders", {
      resourceGroup: group.resourceGroupName,
      serviceName: center.serviceName,
      name: props.name,
      title: props.title,
      kind: "rest",
      description: "Order management",
      summary: props.summary,
      termsOfServiceUrl: "https://example.com/terms",
      externalDocumentation: [{ title: "Guide", url: "https://example.com/docs" }],
      contacts: [{ name: "Platform", email: "platform@example.com" }],
      license: { name: "MIT", identifier: "MIT" },
    });
    return { group, center, api };
  });

// Free-plan API Center: $0, provisions in under a minute.
test.provider(
  "create, update, replace, and delete an API",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, center, api } = yield* stack.deploy(
        program({ name: "orders", title: "Orders API" }),
      );
      expect(api.apiName).toEqual("orders");
      expect(api.title).toEqual("Orders API");
      expect(api.kind).toEqual("rest");
      // Read-only on the API; a new API reports the first stage.
      expect(api.lifecycleStage).toEqual("design");
      const get = (name: string) =>
        Effect.gen(function* () {
          return yield* apicenter.GetApis({
            subscriptionId: yield* subscription,
            resourceGroupName: group.resourceGroupName,
            serviceName: center.serviceName,
            workspaceName: "default",
            apiName: name,
          });
        });
      const observed = yield* get("orders");
      expect(observed.id).toEqual(api.apiId);
      expect(observed.properties?.title).toEqual("Orders API");
      expect(observed.properties?.description).toEqual("Order management");
      expect(observed.properties?.termsOfService?.url).toEqual("https://example.com/terms");
      expect(observed.properties?.externalDocumentation?.[0]?.url).toEqual(
        "https://example.com/docs",
      );
      expect(observed.properties?.contacts?.[0]?.email).toEqual("platform@example.com");
      expect(observed.properties?.license?.identifier).toEqual("MIT");

      // In-place: title and summary.
      const updated = yield* stack.deploy(
        program({
          name: "orders",
          title: "Orders",
          summary: "Create and track orders",
        }),
      );
      expect(updated.api.apiId).toEqual(api.apiId);
      const after = yield* get("orders");
      expect(after.properties?.title).toEqual("Orders");
      expect(after.properties?.summary).toEqual("Create and track orders");
      // Unchanged neighbours survive the full-body upsert.
      expect(after.properties?.contacts?.[0]?.email).toEqual("platform@example.com");

      // Replacement: rename.
      const replaced = yield* stack.deploy(program({ name: "orders-v2", title: "Orders" }));
      expect(replaced.api.apiName).toEqual("orders-v2");
      expect((yield* get("orders-v2")).name).toEqual("orders-v2");
      expect(yield* waitGone(get("orders"))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("orders-v2"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
