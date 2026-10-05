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

/** A configuration property of a managed component. */
export interface ComponentConfigurationProperty {
  /** Property name. */
  propertyName: string;
  /** Property value. */
  value: string;
}

/** A binding from a managed component to another service. */
export interface ComponentServiceBind {
  /** Name of the bind. */
  name: string;
  /** ARM resource ID of the target service. */
  serviceId: string;
}

export interface DotNetComponentProps {
  /** Resource group of the environment. Changing it replaces the component. */
  resourceGroup: string;
  /** Name of the Container Apps environment. Changing it replaces the component. */
  environment: string;
  /**
   * Component name: lowercase letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the component; an environment holds one Aspire dashboard,
   * so the old dashboard is deleted before the new one is created.
   */
  name?: string;
  /**
   * Component type. Changing it replaces the component.
   * @default "AspireDashboard"
   */
  componentType?: "AspireDashboard";
  /** Component configuration properties. */
  configurations?: ComponentConfigurationProperty[];
  /** Services bound to the component. */
  serviceBinds?: ComponentServiceBind[];
}

export interface DotNetComponent extends Resource<
  "Azure.ContainerApps.DotNetComponent",
  DotNetComponentProps,
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
 * A managed .NET component of a Container Apps environment
 * (`Microsoft.App/managedEnvironments/dotNetComponents`) — currently the
 * .NET Aspire dashboard, which collects OpenTelemetry from the
 * environment's apps.
 *
 * Components cannot be tagged; Alchemy treats a component as owned when
 * its environment is owned by the same stack and stage.
 *
 * @see https://learn.microsoft.com/azure/container-apps/aspire-dashboard
 *
 * ### Aspire Dashboard
 * **Example:** Enable the Aspire dashboard
 * ```typescript
 * const dashboard = yield* Azure.ContainerApps.DotNetComponent("aspire", {
 *   resourceGroup: group.resourceGroupName,
 *   environment: env.environmentName,
 *   componentType: "AspireDashboard",
 * });
 * ```
 *
 * @resource
 */
export const DotNetComponent = Resource<DotNetComponent>(
  "Azure.ContainerApps.DotNetComponent",
);

const createComponentName = (id: string) => createContainerAppsName(id, 32);

const getComponent = (
  subscriptionId: string,
  resourceGroupName: string,
  environmentName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    app.GetDotNetComponent({
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
  observed: app.GetDotNetComponentResponse,
): DotNetComponent["Attributes"] => ({
  componentName: name,
  componentId: observed.id ?? "",
  environment,
  resourceGroup,
  componentType: observed.properties?.componentType ?? "",
});

const toProperties = (
  props: DotNetComponentProps,
): app.DotNetComponentProperties => ({
  componentType: props.componentType ?? "AspireDashboard",
  configurations: props.configurations ?? [],
  serviceBinds: props.serviceBinds ?? [],
});

export const DotNetComponentProvider = () =>
  Provider.succeed(DotNetComponent, {
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
        lower(news.componentType ?? "AspireDashboard") !==
          lower(output.componentType)
      ) {
        // An environment holds at most one Aspire dashboard ("Aspire
        // dashboard with name 'x' already exists in this environment"), so
        // the old one must go before its replacement is created.
        return {
          action: "replace",
          deleteFirst:
            lower(news.componentType ?? "AspireDashboard") ===
            "aspiredashboard",
        } as const;
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
        `.NET component ${name}`,
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
        yield* app.DotNetComponentsCreateOrUpdate({
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
        app.DeleteDotNetComponent({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          environmentName: output.environment,
          name: output.componentName,
        }),
      );
      yield* waitUntilGone(
        `.NET component ${output.componentName}`,
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
