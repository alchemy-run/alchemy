import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as app from "@distilled.cloud/azure/app";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Redacted from "effect/Redacted";
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

const getAuthConfig = (resourceGroupName: string, containerAppName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* app.GetContainerAppsAuthConfig({
      subscriptionId,
      resourceGroupName,
      containerAppName,
      authConfigName: "current",
    });
  });

const program = (props: { enabled: boolean }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
    const env = yield* Azure.ContainerApps.ManagedEnvironment("Env", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      workloadProfiles: CONSUMPTION_PROFILES,
    });
    const api = yield* Azure.ContainerApps.ContainerApp("Api", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      environmentId: env.environmentId,
      configuration: { ingress: { external: true, targetPort: 80 } },
      secrets: [
        { name: "github-secret", value: Redacted.make("not-a-real-secret") },
      ],
      template: {
        containers: [
          {
            name: "api",
            image: QUICKSTART_IMAGE,
            resources: { cpu: 0.25, memory: "0.5Gi" },
          },
        ],
        scale: { minReplicas: 0, maxReplicas: 1 },
      },
    });
    const auth = yield* Azure.ContainerApps.AuthConfig("Auth", {
      resourceGroup: group.resourceGroupName,
      containerApp: api.containerAppName,
      platform: { enabled: props.enabled },
      globalValidation: { unauthenticatedClientAction: "Return401" },
      identityProviders: {
        gitHub: {
          registration: {
            clientId: "alchemy-test-client-id",
            clientSecretSettingName: "github-secret",
          },
        },
      },
    });
    return { group, api, auth };
  });

/** GET the app until it answers with the expected status. */
const expectStatus = (url: string, status: number) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === status ? Effect.succeed(res) : Effect.fail(res.status),
      ),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 36 }),
    );
    expect(response.status).toEqual(status);
  });

// Cost: Consumption environment (free idle) + a scale-to-zero app inside the
// monthly free grant (~$0).
// Gated (time, not cost): the trial allows one standard environment per
// subscription, so these lifecycles serialize behind
// `withStandardEnvironment`, and an environment delete takes 5-25 minutes
// (~15-35 minutes per test). Run with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "enable, disable, and delete container app authentication",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, api, auth } = yield* stack.deploy(
        program({ enabled: true }),
      );
      expect(auth.enabled).toEqual(true);
      expect(auth.containerApp).toEqual(api.containerAppName);
      const observed = yield* getAuthConfig(
        group.resourceGroupName,
        api.containerAppName,
      );
      expect(observed.properties?.platform?.enabled).toEqual(true);
      expect(
        observed.properties?.globalValidation?.unauthenticatedClientAction,
      ).toEqual("Return401");
      expect(
        observed.properties?.identityProviders?.gitHub?.registration?.clientId,
      ).toEqual("alchemy-test-client-id");
      // Unauthenticated requests are rejected.
      yield* expectStatus(api.url ?? "", 401);

      // In-place update: disable authentication.
      const updated = yield* stack.deploy(program({ enabled: false }));
      expect(updated.auth.enabled).toEqual(false);
      const reobserved = yield* getAuthConfig(
        group.resourceGroupName,
        api.containerAppName,
      );
      expect(reobserved.properties?.platform?.enabled).toEqual(false);
      yield* expectStatus(api.url ?? "", 200);

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getAuthConfig(group.resourceGroupName, api.containerAppName),
        ),
      ).toEqual("gone");
    }).pipe(withStandardEnvironment, logLevel),
  {
    tags: ["provider:azure", "provider:azure:containerapps", "live"],
    timeout: 3_600_000,
  },
);
