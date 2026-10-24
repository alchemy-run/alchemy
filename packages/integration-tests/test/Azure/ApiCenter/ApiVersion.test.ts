import * as Azure from "@alchemy.run/azure";
import * as apicenter from "@distilled.cloud/azure/apicenter";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { apiCenter, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  name: string;
  title: string;
  lifecycleStage: Azure.ApiCenter.ApiCenterLifecycleStage;
}) =>
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
      name: props.name,
      title: props.title,
      lifecycleStage: props.lifecycleStage,
    });
    return { group, center, version };
  });

// Free-plan API Center: $0, provisions in under a minute.
test.provider(
  "create, update, replace, and delete an API version",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, center, version } = yield* stack.deploy(
        program({ name: "v1", title: "1.0.0", lifecycleStage: "testing" }),
      );
      expect(version.versionName).toEqual("v1");
      expect(version.apiName).toEqual("orders");
      expect(version.title).toEqual("1.0.0");
      expect(version.lifecycleStage).toEqual("testing");
      const get = (name: string) =>
        Effect.gen(function* () {
          return yield* apicenter.GetApiVersion({
            subscriptionId: yield* subscription,
            resourceGroupName: group.resourceGroupName,
            serviceName: center.serviceName,
            workspaceName: "default",
            apiName: "orders",
            versionName: name,
          });
        });
      const observed = yield* get("v1");
      expect(observed.id).toEqual(version.versionId);
      expect(observed.properties?.title).toEqual("1.0.0");
      expect(observed.properties?.lifecycleStage).toEqual("testing");

      // In-place: title and lifecycle stage.
      const updated = yield* stack.deploy(
        program({ name: "v1", title: "1.0.1", lifecycleStage: "production" }),
      );
      expect(updated.version.versionId).toEqual(version.versionId);
      const after = yield* get("v1");
      expect(after.properties?.title).toEqual("1.0.1");
      expect(after.properties?.lifecycleStage).toEqual("production");

      // Replacement: rename.
      const replaced = yield* stack.deploy(
        program({ name: "v2", title: "2.0.0", lifecycleStage: "production" }),
      );
      expect(replaced.version.versionName).toEqual("v2");
      expect((yield* get("v2")).properties?.title).toEqual("2.0.0");
      expect(yield* waitGone(get("v1"))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("v2"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
