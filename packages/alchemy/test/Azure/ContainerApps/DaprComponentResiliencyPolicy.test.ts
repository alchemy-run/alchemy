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

const getPolicy = (
  resourceGroupName: string,
  environmentName: string,
  componentName: string,
  name: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* app.GetDaprComponentResiliencyPolicy({
      subscriptionId,
      resourceGroupName,
      environmentName,
      componentName,
      name,
    });
  });

const program = (props?: { timeoutSeconds: number; retries?: number }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
    const env = yield* Azure.ContainerApps.ManagedEnvironment("Env", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      workloadProfiles: CONSUMPTION_PROFILES,
    });
    const component = yield* Azure.ContainerApps.DaprComponent("State", {
      resourceGroup: group.resourceGroupName,
      environment: env.environmentName,
      componentType: "state.in-memory",
    });
    if (props === undefined)
      return { group, env, component, policy: undefined };
    const policy = yield* Azure.ContainerApps.DaprComponentResiliencyPolicy(
      "Policy",
      {
        resourceGroup: group.resourceGroupName,
        environment: env.environmentName,
        component: component.componentName,
        outboundPolicy: {
          timeoutPolicy: { responseTimeoutInSeconds: props.timeoutSeconds },
          httpRetryPolicy:
            props.retries === undefined
              ? undefined
              : {
                  maxRetries: props.retries,
                  retryBackOff: {
                    initialDelayInMilliseconds: 500,
                    maxIntervalInMilliseconds: 5000,
                  },
                },
        },
      },
    );
    return { group, env, component, policy };
  });

// Cost: Consumption environment (free idle); Dapr components and policies
// are free (~$0). Gated (time, not cost): the trial allows one standard
// environment per subscription, so these lifecycles serialize behind
// `withStandardEnvironment`, and an environment delete takes 5-25 minutes
// (~15-35 minutes per test). Run with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a dapr component resiliency policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, env, component, policy } = yield* stack.deploy(
        program({ timeoutSeconds: 10 }),
      );
      if (policy === undefined) return yield* Effect.die("no policy");
      expect(policy.component).toEqual(component.componentName);
      const get = getPolicy(
        group.resourceGroupName,
        env.environmentName,
        component.componentName,
        policy.policyName,
      );
      const observed = yield* get;
      expect(
        observed.properties?.outboundPolicy?.timeoutPolicy
          ?.responseTimeoutInSeconds,
      ).toEqual(10);
      expect(
        observed.properties?.outboundPolicy?.httpRetryPolicy,
      ).toBeUndefined();

      // In-place update: new timeout and an added retry policy.
      const updated = yield* stack.deploy(
        program({ timeoutSeconds: 30, retries: 3 }),
      );
      expect(updated.policy?.policyId).toEqual(policy.policyId);
      const reobserved = yield* get;
      expect(
        reobserved.properties?.outboundPolicy?.timeoutPolicy
          ?.responseTimeoutInSeconds,
      ).toEqual(30);
      expect(
        reobserved.properties?.outboundPolicy?.httpRetryPolicy?.maxRetries,
      ).toEqual(3);

      // Delete the policy while its component stays.
      yield* stack.deploy(program());
      expect(yield* waitGone(get)).toEqual("gone");

      yield* stack.destroy();
    }).pipe(withStandardEnvironment, logLevel),
  {
    tags: ["provider:azure", "provider:azure:containerapps", "live"],
    timeout: 3_600_000,
  },
);
