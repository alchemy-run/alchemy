import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as servicenetworking from "@distilled.cloud/azure/servicenetworking";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, untilGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const controllerOnly = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "eastus",
  });
  const controller = yield* Azure.ServiceNetworking.TrafficController(
    "Controller",
    { resourceGroup: group.resourceGroupName },
  );
  return { group, controller };
});

const withFrontend = (props: { name?: string; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const { group, controller } = yield* controllerOnly;
    const frontend = yield* Azure.ServiceNetworking.Frontend("Frontend", {
      resourceGroup: group.resourceGroupName,
      trafficController: controller.trafficControllerName,
      name: props.name,
      tags: props.tags,
    });
    return { group, controller, frontend };
  });

const getFrontend = (
  resourceGroupName: string,
  trafficControllerName: string,
  frontendName: string,
) =>
  Effect.flatMap(subscription, (subscriptionId) =>
    servicenetworking.GetFrontendsInterface({
      subscriptionId,
      resourceGroupName,
      trafficControllerName,
      frontendName,
    }),
  );

// Cost: traffic controller (~$0.017/hour) + frontends (~$0.01/hour) for a
// few minutes (< $0.05). ~5-10 minutes.
test.provider(
  "create, update tags, replace, and delete an AGC frontend",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create.
      const { group, controller, frontend } = yield* stack.deploy(
        withFrontend({ tags: { env: "test" } }),
      );
      const rg = group.resourceGroupName;
      const tc = controller.trafficControllerName;
      expect(frontend.fqdn).toMatch(/\.alb\.azure\.com$/);
      expect(frontend.tags).toEqual({ env: "test" });
      const observed = yield* getFrontend(rg, tc, frontend.frontendName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.fqdn).toEqual(frontend.fqdn);
      expect(observed.tags?.["alchemy::id"]).toEqual("Frontend");

      // In-place update: tags.
      const updated = yield* stack.deploy(
        withFrontend({ tags: { env: "prod" } }),
      );
      expect(updated.frontend.frontendName).toEqual(frontend.frontendName);
      expect(
        (yield* getFrontend(rg, tc, frontend.frontendName)).tags?.env,
      ).toEqual("prod");

      // Replacement: an explicit name.
      const replaced = yield* stack.deploy(
        withFrontend({ name: "alchemy-test-frontend-renamed", tags: {} }),
      );
      expect(replaced.frontend.frontendName).toEqual(
        "alchemy-test-frontend-renamed",
      );
      expect(
        (yield* getFrontend(rg, tc, "alchemy-test-frontend-renamed")).properties
          ?.provisioningState,
      ).toEqual("Succeeded");
      expect(
        yield* untilGone(getFrontend(rg, tc, frontend.frontendName)),
      ).toEqual("gone");

      // Delete the frontend, keep the controller.
      yield* stack.deploy(controllerOnly);
      expect(
        yield* untilGone(getFrontend(rg, tc, "alchemy-test-frontend-renamed")),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
