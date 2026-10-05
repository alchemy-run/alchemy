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
  waitForProvisioned,
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
import type {
  ComponentConfigurationProperty,
  ComponentServiceBind,
} from "./DotNetComponent.ts";

export interface JavaComponentProps {
  /** Resource group of the environment. Changing it replaces the component. */
  resourceGroup: string;
  /** Name of the Container Apps environment. Changing it replaces the component. */
  environment: string;
  /**
   * Component name: lowercase letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the component.
   */
  name?: string;
  /**
   * Spring component type: `SpringCloudEureka` (service registry),
   * `SpringCloudConfig` (config server), or `SpringBootAdmin`. Changing it
   * replaces the component.
   */
  componentType: "SpringCloudEureka" | "SpringCloudConfig" | "SpringBootAdmin";
  /** Component configuration properties. */
  configurations?: ComponentConfigurationProperty[];
  /** Services bound to the component (e.g. a Eureka server for Admin). */
  serviceBinds?: ComponentServiceBind[];
  /**
   * Replica bounds of the component.
   * @default `{ minReplicas: 1, maxReplicas: 1 }`
   */
  scale?: {
    /** Minimum replicas. */
    minReplicas?: number;
    /** Maximum replicas. */
    maxReplicas?: number;
  };
}

export interface JavaComponent extends Resource<
  "Azure.ContainerApps.JavaComponent",
  JavaComponentProps,
  {
    /** Name of the component. */
    componentName: string;
    /** ARM resource ID of the component. */
    componentId: string;
    /** Name of the environment. */
    environment: string;
    /** Resource group of the environment. */
    resourceGroup: string;
    /** Component type. */
    componentType: string;
  },
  never,
  Providers
> {}

/**
 * A managed Java component of a Container Apps environment
 * (`Microsoft.App/managedEnvironments/javaComponents`) — a platform-run
 * Spring Cloud Eureka server, Spring Cloud Config server, or Spring Boot
 * Admin that the environment's Java apps bind to.
 *
 * Components cannot be tagged; Alchemy treats a component as owned when
 * its environment is owned by the same stack and stage.
 *
 * @see https://learn.microsoft.com/azure/container-apps/java-overview
 *
 * ### Service Registry
 * **Example:** Eureka server
 * ```typescript
 * const eureka = yield* Azure.ContainerApps.JavaComponent("eureka", {
 *   resourceGroup: group.resourceGroupName,
 *   environment: env.environmentName,
 *   componentType: "SpringCloudEureka",
 *   configurations: [
 *     { propertyName: "eureka.server.enable-self-preservation", value: "false" },
 *   ],
 * });
 * ```
 *
 * ### Config Server
 * **Example:** Spring Cloud Config backed by a Git repository
 * ```typescript
 * yield* Azure.ContainerApps.JavaComponent("config", {
 *   resourceGroup: group.resourceGroupName,
 *   environment: env.environmentName,
 *   componentType: "SpringCloudConfig",
 *   configurations: [
 *     {
 *       propertyName: "spring.cloud.config.server.git.uri",
 *       value: "https://github.com/Azure-Samples/azure-spring-cloud-config-java-aca.git",
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const JavaComponent = Resource<JavaComponent>(
  "Azure.ContainerApps.JavaComponent",
);

const createComponentName = (id: string) => createContainerAppsName(id, 32);

const getComponent = (
  subscriptionId: string,
  resourceGroupName: string,
  environmentName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    app.GetJavaComponent({
      subscriptionId,
      resourceGroupName,
      environmentName,
      name,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  environment: string,
  name: string,
  observed: app.GetJavaComponentResponse,
): JavaComponent["Attributes"] => ({
  componentName: name,
  componentId: observed.id ?? "",
  environment,
  resourceGroup,
  componentType: observed.properties?.componentType ?? "",
});

const toProperties = (
  props: JavaComponentProps,
): app.JavaComponentProperties => ({
  componentType: props.componentType,
  configurations: props.configurations ?? [],
  serviceBinds: props.serviceBinds ?? [],
  scale: props.scale,
});

export const JavaComponentProvider = () =>
  Provider.succeed(JavaComponent, {
    stables: ["componentName", "componentId", "environment", "resourceGroup"],

    // Lives inside an environment; nuke removes it with the environment.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        news.environment !== output.environment ||
        (news.name !== undefined && news.name !== output.componentName) ||
        lower(news.componentType) !== lower(output.componentType)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const environment = output?.environment ?? olds?.environment;
      if (resourceGroup === undefined || environment === undefined) {
        return undefined;
      }
      const name =
        output?.componentName ?? olds?.name ?? (yield* createComponentName(id));
      const observed = yield* getComponent(
        subscriptionId,
        resourceGroup,
        environment,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, environment, name, observed);
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
      const { resourceGroup, environment } = news;
      const name =
        news.name ?? output?.componentName ?? (yield* createComponentName(id));
      const properties = toProperties(news);
      const get = getComponent(
        subscriptionId,
        resourceGroup,
        environment,
        name,
      );
      const ready = waitForProvisioned(
        `Java component ${name}`,
        get,
        (component) => component.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;
      if (observed !== undefined) observed = yield* ready;

      // Ensure + sync: one full PUT, skipped when the observed component
      // already matches (removals are detected against the previous props).
      if (
        observed === undefined ||
        !matchesDesired(properties, observed.properties) ||
        (olds !== undefined &&
          fingerprint(properties) !== fingerprint(toProperties(olds)))
      ) {
        yield* app.JavaComponentsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          environmentName: environment,
          name,
          properties,
        });
        observed = yield* ready;
      }

      return toAttrs(resourceGroup, environment, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        app.DeleteJavaComponent({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          environmentName: output.environment,
          name: output.componentName,
        }),
      );
      yield* waitUntilGone(
        `Java component ${output.componentName}`,
        getComponent(
          subscriptionId,
          output.resourceGroup,
          output.environment,
          output.componentName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),
  });
