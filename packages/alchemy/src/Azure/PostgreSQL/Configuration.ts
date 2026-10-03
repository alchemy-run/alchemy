import * as postgresql from "@distilled.cloud/azure/postgresql";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  NOT_FOUND_TAGS,
  orUndefinedIfNotFound,
  waitForProvisioned,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  getServer,
  POSTGRES_NAMESPACE,
  serverOnly,
  type ServerRef,
  waitServerSettled,
  whileServerBusy,
} from "./common.ts";

export interface ConfigurationProps {
  /** Resource group of the server. Changing it replaces the configuration. */
  resourceGroup: string;
  /** Name of the flexible server. Changing it replaces the configuration. */
  server: string;
  /**
   * Server parameter name, e.g. `log_min_duration_statement`. Changing it
   * replaces the configuration.
   */
  name: string;
  /** Value to assign to the parameter. */
  value: string;
  /**
   * Restart the server after changing a static parameter so the new value
   * takes effect. Without it, a static change stays pending
   * (`isConfigPendingRestart`) until the next restart.
   * @default false
   */
  restartOnChange?: boolean;
}

export interface Configuration extends Resource<
  "Azure.PostgreSQL.Configuration",
  ConfigurationProps,
  {
    /** Parameter name. */
    configurationName: string;
    /** ARM resource ID of the parameter. */
    configurationId: string;
    /** Name of the flexible server. */
    server: string;
    /** Resource group of the server. */
    resourceGroup: string;
    /** Current value. */
    value: string | undefined;
    /** Azure's default value, written back when the resource is deleted. */
    defaultValue: string | undefined;
    /** Data type (`Boolean`, `Integer`, `Enumeration`, …). */
    dataType: string | undefined;
    /** Whether the parameter applies without a restart. */
    isDynamicConfig: boolean;
    /** Whether a restart is needed for the current value to take effect. */
    isConfigPendingRestart: boolean;
    /** Source of the value (`user-override`, `system-default`). */
    source: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A server parameter of an Azure Database for PostgreSQL flexible server.
 *
 * Every parameter always exists on the server; this resource overrides its
 * value and restores Azure's default when deleted.
 *
 * @see https://learn.microsoft.com/azure/postgresql/flexible-server/concepts-server-parameters
 *
 * ### Setting Parameters
 * **Example:** Log slow statements
 * ```typescript
 * const slowLog = yield* Azure.PostgreSQL.Configuration("slow-log", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   name: "log_min_duration_statement",
 *   value: "500",
 * });
 * ```
 *
 * **Example:** Static parameter applied with a restart
 * ```typescript
 * const extensions = yield* Azure.PostgreSQL.Configuration("preload", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   name: "shared_preload_libraries",
 *   value: "pg_stat_statements",
 *   restartOnChange: true,
 * });
 * ```
 *
 * @resource
 */
export const Configuration = Resource<Configuration>(
  "Azure.PostgreSQL.Configuration",
);

interface ConfigurationRef extends ServerRef {
  readonly configurationName: string;
}

const getConfiguration = (ref: ConfigurationRef) =>
  orUndefinedIfNotFound(postgresql.GetConfiguration(ref));

const toAttrs = (
  ref: ConfigurationRef,
  config: postgresql.GetConfigurationResponse,
): Configuration["Attributes"] => ({
  configurationName: ref.configurationName,
  configurationId: config.id ?? "",
  server: ref.serverName,
  resourceGroup: ref.resourceGroupName,
  value: config.properties?.value,
  defaultValue: config.properties?.defaultValue,
  dataType: config.properties?.dataType,
  isDynamicConfig: config.properties?.isDynamicConfig ?? true,
  isConfigPendingRestart: config.properties?.isConfigPendingRestart ?? false,
  source: config.properties?.source,
});

const sameText = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();

/** Put a parameter value and wait until the server reports it. */
const putValue = (ref: ConfigurationRef, value: string, source: string) =>
  Effect.gen(function* () {
    yield* postgresql
      .PutConfiguration({ ...ref, properties: { value, source } })
      .pipe(Effect.retry(whileServerBusy));
    return yield* waitForProvisioned(
      `PostgreSQL configuration ${ref.configurationName}`,
      getConfiguration(ref),
      (config) =>
        sameText(config.properties?.value, value) ? undefined : "Updating",
      { interval: "5 seconds", times: 60 },
    );
  });

export const ConfigurationProvider = () =>
  Provider.succeed(Configuration, {
    stables: [
      "configurationName",
      "configurationId",
      "server",
      "resourceGroup",
    ],

    // Parameters are server singletons; nothing to enumerate for nuke.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        !sameText(news.server, output.server) ||
        news.name !== output.configurationName
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    // Every parameter always exists, so it is adopted implicitly.
    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroupName = output?.resourceGroup ?? olds?.resourceGroup;
      const serverName = output?.server ?? olds?.server;
      const configurationName = output?.configurationName ?? olds?.name;
      if (
        resourceGroupName === undefined ||
        serverName === undefined ||
        configurationName === undefined
      ) {
        return undefined;
      }
      const ref = {
        subscriptionId,
        resourceGroupName,
        serverName,
        configurationName,
      };
      const observed = yield* getConfiguration(ref);
      return observed === undefined ? undefined : toAttrs(ref, observed);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, POSTGRES_NAMESPACE);
      const ref: ConfigurationRef = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        serverName: news.server,
        configurationName: news.name,
      };

      // Observe.
      let observed = yield* postgresql.GetConfiguration(ref);

      // Sync the value against the observed one.
      if (!sameText(observed.properties?.value, news.value)) {
        observed = yield* putValue(ref, news.value, "user-override");
      }

      // Apply a pending static change when asked to.
      if (news.restartOnChange && observed.properties?.isConfigPendingRestart) {
        yield* waitServerSettled(ref);
        yield* postgresql
          .RestartServer(serverOnly(ref))
          .pipe(Effect.retry(whileServerBusy));
        yield* waitForProvisioned(
          `PostgreSQL flexible server ${ref.serverName}`,
          getServer(ref),
          (server) =>
            server.properties?.state === "Ready" ? undefined : "Restarting",
          { interval: "10 seconds", times: 60 },
        );
        observed = yield* postgresql.GetConfiguration(ref);
      }
      return toAttrs(ref, observed);
    }),

    // Restore Azure's default; a missing server means nothing to reset.
    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const ref: ConfigurationRef = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        serverName: output.server,
        configurationName: output.configurationName,
      };
      const observed = yield* getConfiguration(ref);
      const defaultValue = observed?.properties?.defaultValue;
      if (
        observed === undefined ||
        defaultValue === undefined ||
        sameText(observed.properties?.value, defaultValue)
      ) {
        return;
      }
      // The API rejects `source: "system-default"`; writing the default
      // value as an override restores the default behaviour.
      yield* putValue(ref, defaultValue, "user-override").pipe(
        Effect.catchTag([...NOT_FOUND_TAGS], () => Effect.void),
      );
    }),

    nuke: { singleton: true },
  });
