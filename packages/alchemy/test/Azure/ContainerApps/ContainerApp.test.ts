import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as app from "@distilled.cloud/azure/app";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { logLevel, QUICKSTART_IMAGE, waitGone } from "./fixtures/shared.ts";

// Express environment: provisions in seconds, outside the one-standard-
// environment-per-region trial quota.
const LOCATION = "eastus";

const { test } = Test.make({ providers: Azure.providers() });

const getApp = (resourceGroupName: string, containerAppName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* app.GetContainerApp({
      subscriptionId,
      resourceGroupName,
      containerAppName,
    });
  });

const listSecrets = (resourceGroupName: string, containerAppName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* app.ListContainerAppSecrets({
      subscriptionId,
      resourceGroupName,
      containerAppName,
    });
  });

const program = (props: {
  name?: string;
  greeting: string;
  secret: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
    const env = yield* Azure.ContainerApps.ManagedEnvironment("Env", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      environmentMode: "Express",
    });
    const api = yield* Azure.ContainerApps.ContainerApp("Api", {
      resourceGroup: group.resourceGroupName,
      name: props.name,
      location: LOCATION,
      environmentId: env.environmentId,
      configuration: {
        ingress: { external: true, targetPort: 80 },
      },
      secrets: [{ name: "api-key", value: Redacted.make(props.secret) }],
      template: {
        containers: [
          {
            name: "api",
            image: QUICKSTART_IMAGE,
            resources: { cpu: 0.25, memory: "0.5Gi" },
            env: [
              { name: "GREETING", value: props.greeting },
              { name: "API_KEY", secretRef: "api-key" },
            ],
          },
        ],
        scale: { minReplicas: 0, maxReplicas: 1 },
      },
      tags: props.tags,
    });
    return { group, env, api };
  });

// Cost: Express environment (free idle) + a 0.25 vCPU app that scales to
// zero, inside the monthly free grant (~$0). Time: ~5 minutes.
test.provider(
  "create, update, replace, and delete a container app",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, api } = yield* stack.deploy(
        program({ greeting: "hello", secret: "one", tags: { env: "test" } }),
      );
      expect(api.containerAppName).toMatch(/^[a-z][a-z0-9-]{1,31}$/);
      expect(api.fqdn).toContain("azurecontainerapps.io");
      expect(api.url).toEqual(`https://${api.fqdn}`);
      expect(api.latestRevisionName).toBeDefined();

      const observed = yield* getApp(
        group.resourceGroupName,
        api.containerAppName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(
        observed.properties?.template?.containers?.[0]?.env?.find(
          (e) => e.name === "GREETING",
        )?.value,
      ).toEqual("hello");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Api");
      const secrets = yield* listSecrets(
        group.resourceGroupName,
        api.containerAppName,
      );
      expect(secrets.value.find((s) => s.name === "api-key")?.value).toEqual(
        "one",
      );

      // The quickstart image answers on the public ingress.
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get(api.url ?? "").pipe(
        Effect.flatMap((res) =>
          res.status === 200 ? Effect.succeed(res) : Effect.fail(res.status),
        ),
        Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
      );
      expect(response.status).toEqual(200);

      // In-place update: env var (new revision), secret value, and tags.
      const updated = yield* stack.deploy(
        program({ greeting: "goodbye", secret: "two", tags: { env: "prod" } }),
      );
      expect(updated.api.containerAppId).toEqual(api.containerAppId);
      const reobserved = yield* getApp(
        group.resourceGroupName,
        api.containerAppName,
      );
      expect(
        reobserved.properties?.template?.containers?.[0]?.env?.find(
          (e) => e.name === "GREETING",
        )?.value,
      ).toEqual("goodbye");
      expect(reobserved.tags?.env).toEqual("prod");
      const resecrets = yield* listSecrets(
        group.resourceGroupName,
        api.containerAppName,
      );
      expect(resecrets.value.find((s) => s.name === "api-key")?.value).toEqual(
        "two",
      );

      // Replacement: a new name creates a new app; the environment stays.
      const replaced = yield* stack.deploy(
        program({
          name: `${api.containerAppName.slice(0, 28).replace(/-+$/, "")}-two`,
          greeting: "goodbye",
          secret: "two",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.api.containerAppName).not.toEqual(api.containerAppName);
      expect(
        yield* waitGone(getApp(group.resourceGroupName, api.containerAppName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getApp(group.resourceGroupName, replaced.api.containerAppName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:containerapps", "live"],
    timeout: 900_000,
  },
);
