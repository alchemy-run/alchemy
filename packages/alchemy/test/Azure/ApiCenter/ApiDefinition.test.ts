import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apicenter from "@distilled.cloud/azure/apicenter";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  apiCenter,
  logLevel,
  openApi,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: { name: string; title: string; specTitle: string }) =>
  Effect.gen(function* () {
    const { group, center } = yield* apiCenter;
    const api = yield* Azure.ApiCenter.Api("Orders", {
      resourceGroup: group.resourceGroupName,
      serviceName: center.serviceName,
      name: "orders",
      title: "Orders API",
      kind: "rest",
    });
    const version = yield* Azure.ApiCenter.ApiVersion("V1", {
      resourceGroup: group.resourceGroupName,
      serviceName: center.serviceName,
      apiName: api.apiName,
      name: "v1",
      title: "1.0.0",
      lifecycleStage: "production",
    });
    const definition = yield* Azure.ApiCenter.ApiDefinition("OpenApi", {
      resourceGroup: group.resourceGroupName,
      serviceName: center.serviceName,
      apiName: api.apiName,
      versionName: version.versionName,
      name: props.name,
      title: props.title,
      description: "Orders OpenAPI document",
      specification: {
        name: "openapi",
        version: "3.0.1",
        value: openApi(props.specTitle),
      },
    });
    return { group, center, api, version, definition };
  });

// Free-plan API Center: $0, provisions in under a minute.
test.provider(
  "create, update, replace, and delete an API definition",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, center, definition } = yield* stack.deploy(
        program({ name: "openapi", title: "OpenAPI", specTitle: "Orders" }),
      );
      expect(definition.definitionName).toEqual("openapi");
      expect(definition.scopedId).toEqual(
        "/workspaces/default/apis/orders/versions/v1/definitions/openapi",
      );
      expect(definition.specificationName).toEqual("openapi");
      expect(definition.specificationHash).toBeDefined();
      const get = (name: string) =>
        Effect.gen(function* () {
          return yield* apicenter.GetApiDefinition({
            subscriptionId: yield* subscription,
            resourceGroupName: group.resourceGroupName,
            serviceName: center.serviceName,
            workspaceName: "default",
            apiName: "orders",
            versionName: "v1",
            definitionName: name,
          });
        });
      const observed = yield* get("openapi");
      expect(observed.properties?.title).toEqual("OpenAPI");
      expect(observed.properties?.specification?.name).toEqual("openapi");

      // In-place: title and a re-imported specification.
      const updated = yield* stack.deploy(
        program({ name: "openapi", title: "OpenAPI 3", specTitle: "Orders 2" }),
      );
      expect(updated.definition.definitionId).toEqual(definition.definitionId);
      expect(updated.definition.specificationHash).not.toEqual(
        definition.specificationHash,
      );
      expect((yield* get("openapi")).properties?.title).toEqual("OpenAPI 3");

      // Replacement: rename.
      const replaced = yield* stack.deploy(
        program({ name: "openapi-v3", title: "OpenAPI 3", specTitle: "Orders 2" }),
      );
      expect(replaced.definition.definitionName).toEqual("openapi-v3");
      expect(
        (yield* get("openapi-v3")).properties?.specification?.name,
      ).toEqual("openapi");
      expect(yield* waitGone(get("openapi"))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("openapi-v3"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
