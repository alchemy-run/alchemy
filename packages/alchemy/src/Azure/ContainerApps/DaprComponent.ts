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
  secretsMatch,
  toSecrets,
  type ContainerAppsSecret,
} from "./common.ts";

/** A Dapr component metadata entry. */
export interface DaprComponentMetadata {
  /** Metadata name, e.g. `schedule` or `accountName`. */
  name: string;
  /** Plain value. */
  value?: string;
  /** Name of a component secret holding the value. */
  secretRef?: string;
}

export interface DaprComponentProps {
  /** Resource group of the environment. Changing it replaces the component. */
  resourceGroup: string;
  /** Name of the Container Apps environment. Changing it replaces the component. */
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

export interface DaprComponent extends Resource<
  "Azure.ContainerApps.DaprComponent",
  DaprComponentProps,
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
 * A Dapr component of a Container Apps environment
 * (`Microsoft.App/managedEnvironments/daprComponents`) — a state store,
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
 * const cron = yield* Azure.ContainerApps.DaprComponent("cron", {
 *   resourceGroup: group.resourceGroupName,
 *   environment: env.environmentName,
 *   componentType: "bindings.cron",
 *   metadata: [{ name: "schedule", value: "@every 10m" }],
 *   scopes: ["worker"],
 * });
 * ```
 *
 * ### Secrets
 * **Example:** Blob storage state store with a secret account key
 * ```typescript
 * const state = yield* Azure.ContainerApps.DaprComponent("state", {
 *   resourceGroup: group.resourceGroupName,
 *   environment: env.environmentName,
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
export const DaprComponent = Resource<DaprComponent>(
  "Azure.ContainerApps.DaprComponent",
);

const createComponentName = (id: string) => createContainerAppsName(id, 60);

const getComponent = (
  subscriptionId: string,
  resourceGroupName: string,
  environmentName: string,
  componentName: string,
) =>
  orUndefinedIfNotFound(
    app.GetDaprComponent({
      subscriptionId,
      resourceGroupName,
      environmentName,
      componentName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  environment: string,
  name: string,
  observed: app.GetDaprComponentResponse,
): DaprComponent["Attributes"] => ({
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
  props: DaprComponentProps,
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

export const DaprComponentProvider = () =>
  Provider.succeed(DaprComponent, {
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
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        environmentName: environment,
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
                app.ListDaprComponentSecrets(where),
              ))?.value
            : [],
        ) &&
        (olds === undefined ||
          fingerprint(properties) === fingerprint(toProperties(olds)));
      if (!inSync) {
        yield* app.DaprComponentsCreateOrUpdate({ ...where, properties });
      }

      const fresh = yield* waitForProvisioned(
        `dapr component ${name}`,
        get,
        (component) => component.properties?.provisioningState,
        { interval: "3 seconds", times: 40 },
      );
      return toAttrs(resourceGroup, environment, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        app.DeleteDaprComponent({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          environmentName: output.environment,
          componentName: output.componentName,
        }),
      );
      yield* waitUntilGone(
        `dapr component ${output.componentName}`,
        getComponent(
          subscriptionId,
          output.resourceGroup,
          output.environment,
          output.componentName,
        ),
      );
    }),
  });
