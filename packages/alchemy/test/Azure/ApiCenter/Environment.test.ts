import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apicenter from "@distilled.cloud/azure/apicenter";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { apiCenter, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  name: string;
  title: string;
  kind: "development" | "production";
}) =>
  Effect.gen(function* () {
    const { group, center } = yield* apiCenter;
    const environment = yield* Azure.ApiCenter.Environment("Prod", {
      resourceGroup: group.resourceGroupName,
      serviceName: center.serviceName,
      name: props.name,
      title: props.title,
      kind: props.kind,
      description: "Public gateway",
      server: {
        type: "Azure API Management",
        managementPortalUri: ["https://portal.azure.com"],
      },
      onboarding: {
        instructions: "Request a key in the developer portal.",
        developerPortalUri: ["https://developer.example.com"],
      },
    });
    return { group, center, environment };
  });

// Free-plan API Center: $0, provisions in under a minute.
test.provider(
  "create, update, replace, and delete an environment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, center, environment } = yield* stack.deploy(
        program({ name: "prod", title: "Production", kind: "production" }),
      );
      expect(environment.environmentName).toEqual("prod");
      expect(environment.scopedId).toEqual(
        "/workspaces/default/environments/prod",
      );
      const get = (name: string) =>
        Effect.gen(function* () {
          return yield* apicenter.GetEnvironment({
            subscriptionId: yield* subscription,
            resourceGroupName: group.resourceGroupName,
            serviceName: center.serviceName,
            workspaceName: "default",
            environmentName: name,
          });
        });
      const observed = yield* get("prod");
      expect(observed.properties?.title).toEqual("Production");
      expect(observed.properties?.kind).toEqual("production");
      expect(observed.properties?.server?.type).toEqual("Azure API Management");
      expect(observed.properties?.onboarding?.developerPortalUri).toEqual([
        "https://developer.example.com",
      ]);

      // In-place: title and kind.
      const updated = yield* stack.deploy(
        program({ name: "prod", title: "Live", kind: "development" }),
      );
      expect(updated.environment.environmentId).toEqual(
        environment.environmentId,
      );
      const after = yield* get("prod");
      expect(after.properties?.title).toEqual("Live");
      expect(after.properties?.kind).toEqual("development");

      // Replacement: rename.
      const replaced = yield* stack.deploy(
        program({ name: "live", title: "Live", kind: "development" }),
      );
      expect(replaced.environment.environmentName).toEqual("live");
      expect((yield* get("live")).name).toEqual("live");
      expect(yield* waitGone(get("prod"))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("live"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
