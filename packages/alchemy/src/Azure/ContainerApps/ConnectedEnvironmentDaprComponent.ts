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
  isConnectedEnvironmentOwnedByStack,
  lower,
  matchesDesired,
  secretsMatch,
  toSecrets,
  type ContainerAppsSecret,
} from "./common.ts";
import type { DaprComponentMetadata } from "./DaprComponent.ts";

export interface ConnectedEnvironmentDaprComponentProps {
  /** Resource group of the connected environment. Changing it replaces the component. */
  resourceGroup: string;
  /** Name of the connected environment. Changing it replaces the component. */
  environment: string;
  /**
   * Component name (the Dapr component name apps refer to): lowercase
   * letters, digits, and hyphens, starting with a letter. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the component.
   */
  name?: string;
  /**
   * Dapr component type, e.g. `state.azure.blobstorage`,
   * `pubsub.azure.servicebus.topics`, or `bindings.cron`. Changing it
   * replaces the component.
   */
  componentType: string;
  /**
   * Component version.
   * @default "v1"
   */
  version?: string;
  /**
   * Keep sidecars running when the component fails to initialize.
   * @default false
   */
  ignoreErrors?: boolean;
  /** Initialization timeout, e.g. `"5s"`. */
  initTimeout?: string;
  /** Secrets referenced by metadata `secretRef`s. */
  secrets?: ContainerAppsSecret[];
  /** Name of a Dapr secret store component to resolve `secretRef`s from. */
  secretStoreComponent?: string;
  /** Component metadata. */
  metadata?: DaprComponentMetadata[];
  /**
   * Dapr app IDs allowed to load the component.
   * @default all apps in the environment
   */
  scopes?: string[];
}

export interface ConnectedEnvironmentDaprComponent extends Resource<
  "Azure.ContainerApps.ConnectedEnvironmentDaprComponent",
  ConnectedEnvironmentDaprComponentProps,
  {
    /** Name of the component. */
    componentName: string;
    /** ARM resource ID of the component. */
    componentId: string;
    /** Name of the environment that holds the component. */
    environment: string;
    /** Resource group of the environment. */
    resourceGroup: string;
    /** Dapr component type. */
    componentType: string;
    /** Component version. */
    version: string | undefined;
    /** Dapr app IDs allowed to load the component. */
    scopes: string[];
  },
  never,
  Providers
> {}

/**
 * A Dapr component of a Container Apps connected (Azure Arc) environment
 * (`Microsoft.App/connectedEnvironments/daprComponents`) — a state store,
 * pub/sub broker, binding, or secret store available to Dapr-enabled apps.
 *
 * Components cannot be tagged; Alchemy treats a component as owned when
 * its environment is owned by the same stack and stage.
 *
 * @see https://learn.microsoft.com/azure/container-apps/dapr-components
 *
 * ### Creating a Component
 * **Example:** Cron input binding
 * ```typescript
 * const cron = yield* Azure.ContainerApps.ConnectedEnvironmentDaprComponent("cron", {
 *   resourceGroup: group.resourceGroupName,
 *   environment: arcEnv.environmentName,
 *   componentType: "bindings.cron",
 *   metadata: [{ name: "schedule", value: "@every 10m" }],
 *   scopes: ["worker"],
 * });
 * ```
 *
 * ### Secrets
 * **Example:** Blob storage state store with a secret account key
 * ```typescript
 * const state = yield* Azure.ContainerApps.ConnectedEnvironmentDaprComponent("state", {
 *   resourceGroup: group.resourceGroupName,
 *   environment: arcEnv.environmentName,
 *   componentType: "state.azure.blobstorage",
 *   secrets: [{ name: "account-key", value: Redacted.make(accountKey) }],
 *   metadata: [
 *     { name: "accountName", value: account.storageAccountName },
 *     { name: "containerName", value: "state" },
 *     { name: "accountKey", secretRef: "account-key" },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const ConnectedEnvironmentDaprComponent =
  Resource<ConnectedEnvironmentDaprComponent>(
    "Azure.ContainerApps.ConnectedEnvironmentDaprComponent",
  );

const createComponentName = (id: string) => createContainerAppsName(id, 60);

const getComponent = (
  subscriptionId: string,
  resourceGroupName: string,
  connectedEnvironmentName: string,
  componentName: string,
) =>
  orUndefinedIfNotFound(
    app.GetConnectedEnvironmentsDaprComponent({
      subscriptionId,
      resourceGroupName,
      connectedEnvironmentName,
      componentName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  environment: string,
  name: string,
  observed: app.GetConnectedEnvironmentsDaprComponentResponse,
): ConnectedEnvironmentDaprComponent["Attributes"] => ({
  componentName: name,
  componentId: observed.id ?? "",
  environment,
  resourceGroup,
  componentType: observed.properties?.componentType ?? "",
  version: observed.properties?.version,
  scopes: [...(observed.properties?.scopes ?? [])],
});

/** The desired `properties` body (secret values revealed). */
const toProperties = (
  props: ConnectedEnvironmentDaprComponentProps,
): app.DaprComponentPropertiesInput => ({
  componentType: props.componentType,
  version: props.version ?? "v1",
  ignoreErrors: props.ignoreErrors ?? false,
  initTimeout: props.initTimeout,
  secrets: toSecrets(props.secrets),
  secretStoreComponent: props.secretStoreComponent,
  metadata: props.metadata ?? [],
  scopes: props.scopes ?? [],
});

export const ConnectedEnvironmentDaprComponentProvider = () =>
  Provider.succeed(ConnectedEnvironmentDaprComponent, {
    stables: ["componentName", "componentId", "environment", "resourceGroup"],

    // Components live inside an environment; nuke removes them with it.
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
      // Components cannot be tagged; ownership follows the environment.
      return (yield* isConnectedEnvironmentOwnedByStack(
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
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        connectedEnvironmentName: environment,
        componentName: name,
      };
      const get = getComponent(
        subscriptionId,
        resourceGroup,
        environment,
        name,
      );

      // Observe.
      const observed = yield* get;

      // Ensure + sync. The PUT is a full replace; skip it when the observed
      // component (secret values via `listSecrets`) already matches.
      const { secrets = [], ...rest } = properties;
      const inSync =
        observed !== undefined &&
        matchesDesired(rest, observed.properties) &&
        secretsMatch(
          secrets,
          secrets.length > 0 || (observed.properties?.secrets ?? []).length > 0
            ? (yield* orUndefinedIfNotFound(
                app.ListConnectedEnvironmentsDaprComponentSecrets(where),
              ))?.value
            : [],
        ) &&
        (olds === undefined ||
          fingerprint(properties) === fingerprint(toProperties(olds)));
      if (!inSync) {
        yield* app.ConnectedEnvironmentsDaprComponentsCreateOrUpdate({
          ...where,
          properties,
        });
      }

      const fresh = yield* waitForProvisioned(
        `connected environment dapr component ${name}`,
        get,
        (component) => component.properties?.provisioningState,
        { interval: "3 seconds", times: 40 },
      );
      return toAttrs(resourceGroup, environment, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        app.DeleteConnectedEnvironmentsDaprComponent({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          connectedEnvironmentName: output.environment,
          componentName: output.componentName,
        }),
      );
      yield* waitUntilGone(
        `connected environment dapr component ${output.componentName}`,
        getComponent(
          subscriptionId,
          output.resourceGroup,
          output.environment,
          output.componentName,
        ),
      );
    }),
  });
