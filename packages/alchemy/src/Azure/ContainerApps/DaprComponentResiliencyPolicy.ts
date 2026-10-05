import * as app from "@distilled.cloud/azure/app";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createContainerAppsName,
  fingerprint,
  isEnvironmentOwnedByStack,
  lower,
  matchesDesired,
} from "./common.ts";

/** Resiliency settings applied to one direction of component traffic. */
export interface DaprResiliencyPolicyConfiguration {
  /** Retry failed HTTP calls. */
  httpRetryPolicy?: {
    /** Maximum number of retries. */
    maxRetries?: number;
    /** Exponential backoff between retries. */
    retryBackOff?: {
      /** Initial delay in milliseconds. */
      initialDelayInMilliseconds?: number;
      /** Maximum delay in milliseconds. */
      maxIntervalInMilliseconds?: number;
    };
  };
  /** Fail calls that take longer than the timeout. */
  timeoutPolicy?: {
    /** Response timeout in seconds. */
    responseTimeoutInSeconds?: number;
  };
  /** Stop calling the component after consecutive failures. */
  circuitBreakerPolicy?: {
    /** Consecutive errors before the circuit opens. */
    consecutiveErrors?: number;
    /** Seconds the circuit stays open before a trial call. */
    timeoutInSeconds?: number;
    /** Seconds after which the error count resets (0 = never). */
    intervalInSeconds?: number;
  };
}

export interface DaprComponentResiliencyPolicyProps {
  /** Resource group of the environment. Changing it replaces the policy. */
  resourceGroup: string;
  /** Name of the Container Apps environment. Changing it replaces the policy. */
  environment: string;
  /** Name of the Dapr component the policy applies to. Changing it replaces the policy. */
  component: string;
  /**
   * Policy name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the policy.
   */
  name?: string;
  /** Policy for calls from the component into apps (e.g. pub/sub delivery). */
  inboundPolicy?: DaprResiliencyPolicyConfiguration;
  /** Policy for calls from apps to the component. */
  outboundPolicy?: DaprResiliencyPolicyConfiguration;
}

export interface DaprComponentResiliencyPolicy extends Resource<
  "Azure.ContainerApps.DaprComponentResiliencyPolicy",
  DaprComponentResiliencyPolicyProps,
  {
    /** Name of the policy. */
    policyName: string;
    /** ARM resource ID of the policy. */
    policyId: string;
    /** Name of the Dapr component. */
    component: string;
    /** Name of the environment. */
    environment: string;
    /** Resource group of the environment. */
    resourceGroup: string;
  },
  never,
  Providers
> {}

/**
 * A resiliency policy for a Dapr component
 * (`Microsoft.App/managedEnvironments/daprComponents/resiliencyPolicies`) —
 * retries, timeouts, and circuit breaking for traffic between apps and the
 * component.
 *
 * Policies cannot be tagged; Alchemy treats a policy as owned when its
 * environment is owned by the same stack and stage.
 *
 * @see https://learn.microsoft.com/azure/container-apps/dapr-component-resiliency
 *
 * ### Creating a Policy
 * **Example:** Outbound timeout and retries
 * ```typescript
 * yield* Azure.ContainerApps.DaprComponentResiliencyPolicy("statePolicy", {
 *   resourceGroup: group.resourceGroupName,
 *   environment: env.environmentName,
 *   component: state.componentName,
 *   outboundPolicy: {
 *     timeoutPolicy: { responseTimeoutInSeconds: 15 },
 *     httpRetryPolicy: {
 *       maxRetries: 5,
 *       retryBackOff: {
 *         initialDelayInMilliseconds: 1000,
 *         maxIntervalInMilliseconds: 10000,
 *       },
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const DaprComponentResiliencyPolicy =
  Resource<DaprComponentResiliencyPolicy>(
    "Azure.ContainerApps.DaprComponentResiliencyPolicy",
  );

const createPolicyName = (id: string) => createContainerAppsName(id, 30);

const getPolicy = (
  subscriptionId: string,
  resourceGroupName: string,
  environmentName: string,
  componentName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    app.GetDaprComponentResiliencyPolicy({
      subscriptionId,
      resourceGroupName,
      environmentName,
      componentName,
      name,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  environment: string,
  component: string,
  name: string,
  observed: app.GetDaprComponentResiliencyPolicyResponse,
): DaprComponentResiliencyPolicy["Attributes"] => ({
  policyName: name,
  policyId: observed.id ?? "",
  component,
  environment,
  resourceGroup,
});

const toProperties = (
  props: DaprComponentResiliencyPolicyProps,
): app.DaprComponentResiliencyPolicyProperties => ({
  inboundPolicy: props.inboundPolicy,
  outboundPolicy: props.outboundPolicy,
});

export const DaprComponentResiliencyPolicyProvider = () =>
  Provider.succeed(DaprComponentResiliencyPolicy, {
    stables: [
      "policyName",
      "policyId",
      "component",
      "environment",
      "resourceGroup",
    ],

    // Lives inside an environment; nuke removes it with the environment.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        news.environment !== output.environment ||
        news.component !== output.component ||
        (news.name !== undefined && news.name !== output.policyName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const environment = output?.environment ?? olds?.environment;
      const component = output?.component ?? olds?.component;
      if (
        resourceGroup === undefined ||
        environment === undefined ||
        component === undefined
      ) {
        return undefined;
      }
      const name =
        output?.policyName ?? olds?.name ?? (yield* createPolicyName(id));
      const observed = yield* getPolicy(
        subscriptionId,
        resourceGroup,
        environment,
        component,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        environment,
        component,
        name,
        observed,
      );
      return (yield* isEnvironmentOwnedByStack(
        subscriptionId,
        resourceGroup,
        environment,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.App");
      const { resourceGroup, environment, component } = news;
      const name =
        news.name ?? output?.policyName ?? (yield* createPolicyName(id));
      const properties = toProperties(news);

      // Observe.
      let observed = yield* getPolicy(
        subscriptionId,
        resourceGroup,
        environment,
        component,
        name,
      );

      // Ensure + sync: the PUT is a full replace; skip it when the observed
      // policy already matches (Azure echoes defaults, so removed settings
      // are detected against the previous props).
      if (
        observed === undefined ||
        !matchesDesired(properties, observed.properties) ||
        (olds !== undefined &&
          fingerprint(properties) !== fingerprint(toProperties(olds)))
      ) {
        observed = yield* app.DaprComponentResiliencyPoliciesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          environmentName: environment,
          componentName: component,
          name,
          properties,
        });
      }

      return toAttrs(resourceGroup, environment, component, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        app.DeleteDaprComponentResiliencyPolicy({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          environmentName: output.environment,
          componentName: output.component,
          name: output.policyName,
        }),
      );
      yield* waitUntilGone(
        `dapr resiliency policy ${output.policyName}`,
        getPolicy(
          subscriptionId,
          output.resourceGroup,
          output.environment,
          output.component,
          output.policyName,
        ),
      );
    }),
  });
