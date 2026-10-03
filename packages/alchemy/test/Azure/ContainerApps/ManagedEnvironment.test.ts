import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as app from "@distilled.cloud/azure/app";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  CONSUMPTION_PROFILES,
  logLevel,
  STANDARD_LOCATION,
  waitGone,
  withStandardEnvironment,
} from "./fixtures/shared.ts";
import { runExpensive } from "../gates.ts";

const LOCATION = STANDARD_LOCATION;

const { test } = Test.make({ providers: Azure.providers() });

const getEnvironment = (resourceGroupName: string, environmentName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* app.GetManagedEnvironment({
      subscriptionId,
      resourceGroupName,
      environmentName,
    });
  });

const program = (props: {
  mtlsEnabled: boolean;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
    const env = yield* Azure.ContainerApps.ManagedEnvironment("Env", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      workloadProfiles: CONSUMPTION_PROFILES,
      mtlsEnabled: props.mtlsEnabled,
      tags: props.tags,
    });
    return { group, env };
  });

// Cost: a Consumption environment is free while idle (~$0). Time: create
// ~2-3 minutes, mTLS update ~6 minutes, delete 5-25 minutes (measured 36
// minutes end to end), so it runs only with AZURE_TEST_EXPENSIVE=1. The
// trial allows one standard environment per subscription; the body holds
// `withStandardEnvironment`.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a container apps environment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, env } = yield* stack.deploy(
        program({ mtlsEnabled: false, tags: { env: "test" } }),
      );
      expect(env.environmentName).toMatch(/^[a-z][a-z0-9-]{1,59}$/);
      expect(env.environmentId).toContain(
        `/providers/Microsoft.App/managedEnvironments/${env.environmentName}`,
      );
      expect(env.defaultDomain).toContain("azurecontainerapps.io");
      expect(env.tags).toEqual({ env: "test" });

      const observed = yield* getEnvironment(
        group.resourceGroupName,
        env.environmentName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.workloadProfiles?.[0]?.name).toEqual(
        "Consumption",
      );
      expect(observed.properties?.peerAuthentication?.mtls?.enabled).toEqual(
        false,
      );
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Env");

      // In-place update: mTLS and tags.
      const updated = yield* stack.deploy(
        program({ mtlsEnabled: true, tags: { env: "prod" } }),
      );
      expect(updated.env.environmentId).toEqual(env.environmentId);
      const reobserved = yield* getEnvironment(
        group.resourceGroupName,
        env.environmentName,
      );
      expect(reobserved.properties?.peerAuthentication?.mtls?.enabled).toEqual(
        true,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getEnvironment(group.resourceGroupName, env.environmentName),
        ),
      ).toEqual("gone");
    }).pipe(withStandardEnvironment, logLevel),
  {
    tags: ["provider:azure", "provider:azure:containerapps", "live"],
    timeout: 3_600_000,
  },
);
