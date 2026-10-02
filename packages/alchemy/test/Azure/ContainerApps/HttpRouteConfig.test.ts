import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as app from "@distilled.cloud/azure/app";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import {
  CONSUMPTION_PROFILES,
  logLevel,
  QUICKSTART_IMAGE,
  STANDARD_LOCATION,
  waitGone,
  withStandardEnvironment,
} from "./fixtures/shared.ts";
import { runExpensive } from "../gates.ts";

const LOCATION = STANDARD_LOCATION;

const { test } = Test.make({ providers: Azure.providers() });

const getRoute = (
  resourceGroupName: string,
  environmentName: string,
  httpRouteName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* app.GetHttpRouteConfig({
      subscriptionId,
      resourceGroupName,
      environmentName,
      httpRouteName,
    });
  });

const program = (props?: { prefix: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
    const env = yield* Azure.ContainerApps.ManagedEnvironment("Env", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      workloadProfiles: CONSUMPTION_PROFILES,
    });
    const web = yield* Azure.ContainerApps.ContainerApp("Web", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      environmentId: env.environmentId,
      configuration: { ingress: { external: true, targetPort: 80 } },
      template: {
        containers: [
          {
            name: "web",
            image: QUICKSTART_IMAGE,
            resources: { cpu: 0.25, memory: "0.5Gi" },
          },
        ],
        scale: { minReplicas: 0, maxReplicas: 1 },
      },
    });
    if (props === undefined) return { group, env, web, routes: undefined };
    const routes = yield* Azure.ContainerApps.HttpRouteConfig("Routes", {
      resourceGroup: group.resourceGroupName,
      environment: env.environmentName,
      rules: [
        {
          description: "web",
          targets: [{ containerApp: web.containerAppName }],
          routes: [
            { match: { prefix: props.prefix }, action: { prefixRewrite: "/" } },
          ],
        },
      ],
    });
    return { group, env, web, routes };
  });

// Cost: Consumption environment (free idle) + a scale-to-zero app inside the
// monthly free grant (~$0). Gated (time, not cost): the trial allows one
// standard environment per subscription, so these lifecycles serialize
// behind `withStandardEnvironment`, and an environment delete takes 5-25
// minutes (~15-35 minutes per test). Run with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete an http route config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, env, routes } = yield* stack.deploy(
        program({ prefix: "/web" }),
      );
      if (routes === undefined) return yield* Effect.die("no route config");
      expect(routes.fqdn).toBeDefined();
      expect(routes.url).toEqual(`https://${routes.fqdn}`);
      const get = getRoute(
        group.resourceGroupName,
        env.environmentName,
        routes.routeName,
      );
      expect(
        (yield* get).properties?.rules?.[0]?.routes?.[0]?.match?.prefix,
      ).toEqual("/web");

      // The route config serves the app under the prefix.
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get(`${routes.url}/web`).pipe(
        Effect.flatMap((res) =>
          res.status === 200 ? Effect.succeed(res) : Effect.fail(res.status),
        ),
        Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 36 }),
      );
      expect(response.status).toEqual(200);

      // In-place update: change the path prefix.
      const updated = yield* stack.deploy(program({ prefix: "/app" }));
      expect(updated.routes?.routeId).toEqual(routes.routeId);
      expect(
        (yield* get).properties?.rules?.[0]?.routes?.[0]?.match?.prefix,
      ).toEqual("/app");

      // Delete the route config while its environment stays.
      yield* stack.deploy(program());
      expect(yield* waitGone(get)).toEqual("gone");

      yield* stack.destroy();
    }).pipe(withStandardEnvironment, logLevel),
  {
    tags: ["provider:azure", "provider:azure:containerapps", "live"],
    timeout: 3_600_000,
  },
);
