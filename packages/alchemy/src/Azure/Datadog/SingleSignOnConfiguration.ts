import * as datadog from "@distilled.cloud/azure/datadog";
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
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_CONFIGURATION,
  isMonitorOwnedByStack,
  type MonitorChildProps,
  sameName,
} from "./common.ts";

export interface SingleSignOnConfigurationProps extends MonitorChildProps {
  /**
   * Single sign-on state: `Enable` turns on SAML SSO through the enterprise
   * app, `Disable` turns it off, `Existing` keeps an SSO configuration
   * already set up in Datadog.
   * @default "Enable"
   */
  singleSignOnState?: "Initial" | "Enable" | "Disable" | "Existing";
  /**
   * ID of the Microsoft Entra ID enterprise application (the Datadog SAML
   * gallery app) used for single sign-on.
   */
  enterpriseAppId?: string;
}

export interface SingleSignOnConfiguration extends Resource<
  "Azure.Datadog.SingleSignOnConfiguration",
  SingleSignOnConfigurationProps,
  {
    /** Name of the Datadog monitor. */
    monitor: string;
    /** Resource group of the monitor. */
    resourceGroup: string;
    /** Name of the configuration (always `default`). */
    configurationName: string;
    /** ARM resource ID of the configuration. */
    configurationId: string;
    /** Observed single sign-on state. */
    singleSignOnState: string | undefined;
    /** ID of the enterprise application used for single sign-on. */
    enterpriseAppId: string | undefined;
    /** Login URL of the Datadog organization. */
    singleSignOnUrl: string | undefined;
  },
  never,
  Providers
> {}

/**
 * SAML single sign-on from Microsoft Entra ID into the Datadog organization
 * of a monitor (`Microsoft.Datadog/monitors/singleSignOnConfigurations`,
 * singleton `default`).
 *
 * Requires an Entra ID enterprise application created from the Datadog
 * gallery app. There is no DELETE API; deleting the resource sets the state
 * to `Disable`.
 *
 * ### Enabling Single Sign-On
 * **Example:** Enable SAML SSO through an enterprise app
 * ```typescript
 * const sso = yield* Azure.Datadog.SingleSignOnConfiguration("sso", {
 *   resourceGroup: group.resourceGroupName,
 *   monitor: monitor.monitorName,
 *   singleSignOnState: "Enable",
 *   enterpriseAppId: "00000000-0000-0000-0000-000000000000",
 * });
 * ```
 *
 * @resource
 */
export const SingleSignOnConfiguration = Resource<SingleSignOnConfiguration>(
  "Azure.Datadog.SingleSignOnConfiguration",
);

const getConfiguration = (
  subscriptionId: string,
  resourceGroupName: string,
  monitorName: string,
) =>
  orUndefinedIfNotFound(
    datadog.GetSingleSignOnConfiguration({
      subscriptionId,
      resourceGroupName,
      monitorName,
      configurationName: DEFAULT_CONFIGURATION,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  monitor: string,
  observed: datadog.GetSingleSignOnConfigurationResponse,
): SingleSignOnConfiguration["Attributes"] => ({
  monitor,
  resourceGroup,
  configurationName: DEFAULT_CONFIGURATION,
  configurationId: observed.id ?? "",
  singleSignOnState: observed.properties?.singleSignOnState,
  enterpriseAppId: observed.properties?.enterpriseAppId,
  singleSignOnUrl: observed.properties?.singleSignOnUrl,
});

export const SingleSignOnConfigurationProvider = () =>
  Provider.succeed(SingleSignOnConfiguration, {
    stables: [
      "monitor",
      "resourceGroup",
      "configurationName",
      "configurationId",
    ],

    // The configuration lives and dies with its monitor, which `list` covers.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.monitor, output.monitor)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const monitor = output?.monitor ?? olds?.monitor;
      if (resourceGroup === undefined || monitor === undefined) {
        return undefined;
      }
      const observed = yield* getConfiguration(
        subscriptionId,
        resourceGroup,
        monitor,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, monitor, observed);
      return (yield* isMonitorOwnedByStack(
        subscriptionId,
        resourceGroup,
        monitor,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Datadog");
      const { resourceGroup, monitor } = news;
      const state = news.singleSignOnState ?? "Enable";

      // Observe.
      let observed = yield* getConfiguration(
        subscriptionId,
        resourceGroup,
        monitor,
      );

      // Ensure + sync: one PUT when the state or enterprise app drifts.
      if (
        observed === undefined ||
        observed.properties?.singleSignOnState !== state ||
        (news.enterpriseAppId !== undefined &&
          !sameName(observed.properties?.enterpriseAppId, news.enterpriseAppId))
      ) {
        yield* datadog.SingleSignOnConfigurationsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          monitorName: monitor,
          configurationName: DEFAULT_CONFIGURATION,
          properties: {
            singleSignOnState: state,
            enterpriseAppId: news.enterpriseAppId,
          },
        });
        observed = yield* waitForProvisioned(
          `Datadog single sign-on of ${monitor}`,
          getConfiguration(subscriptionId, resourceGroup, monitor),
          (config) => config.properties?.provisioningState,
          { interval: "5 seconds", times: 36 },
        );
      }

      return toAttrs(resourceGroup, monitor, observed);
    }),

    // There is no DELETE: disable single sign-on. A missing monitor means
    // the configuration is already gone.
    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        datadog.SingleSignOnConfigurationsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          monitorName: output.monitor,
          configurationName: DEFAULT_CONFIGURATION,
          properties: { singleSignOnState: "Disable" },
        }),
      );
    }),

    nuke: { dependsOn: ["Azure.Datadog.Monitor"] },
  });
