import * as securityinsights from "@distilled.cloud/azure/securityinsights";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
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
  compact,
  deterministicGuid,
  hasOwnMarker,
  isWorkspaceOwnedByStack,
  ownershipMarker,
  SENTINEL_NAMESPACE,
  sameText,
  subsetEqual,
  withMarker,
} from "./Common.ts";

export interface SecurityMLAnalyticsSettingProps {
  /** Resource group of the Sentinel workspace. Changing it replaces the setting. */
  resourceGroup: string;
  /**
   * Sentinel-enabled Log Analytics workspace. Pass `OnboardingState.workspace`
   * so the setting is created after onboarding. Changing it replaces it.
   */
  workspace: string;
  /**
   * Settings resource name (a GUID). If omitted, a deterministic GUID is
   * derived from the app, stage, and logical ID. Changing it replaces the
   * setting.
   */
  settingsResourceName?: string;
  /**
   * Kind of setting. Changing it replaces the setting.
   * @default "Anomaly"
   */
  kind?: "Anomaly" | (string & {});
  /** Display name of the anomaly rule. */
  displayName: string;
  /** Description of the anomaly rule. An Alchemy ownership marker is appended. */
  description?: string;
  /** Whether the anomaly rule is enabled. */
  enabled: boolean;
  /** Version of the anomaly model, e.g. `1.0.5`. */
  anomalyVersion: string;
  /** How often the model runs (ISO-8601 duration, e.g. `PT1H`). */
  frequency: string;
  /** Status of the settings: `Production` or `Flighting`. */
  settingsStatus: "Production" | "Flighting" | (string & {});
  /** Whether these are the built-in default settings. */
  isDefaultSettings: boolean;
  /** Version of the anomaly settings. */
  anomalySettingsVersion?: number;
  /**
   * ID of the built-in anomaly definition the settings customize. Changing
   * it replaces the setting.
   */
  settingsDefinitionId?: string;
  /** Customizable observations (thresholds, exclusions) of the model. */
  customizableObservations?: Record<string, unknown>;
  /** Data connectors the model requires, e.g. `[{ connectorId: "AzureActiveDirectory", dataTypes: ["SigninLogs"] }]`. */
  requiredDataConnectors?: Record<string, unknown>[];
  /** MITRE ATT&CK tactics. */
  tactics?: string[];
  /** MITRE ATT&CK techniques. */
  techniques?: string[];
}

export interface SecurityMLAnalyticsSetting extends Resource<
  "Azure.SecurityInsights.SecurityMLAnalyticsSetting",
  SecurityMLAnalyticsSettingProps,
  {
    /** Settings resource name (GUID). */
    settingsResourceName: string;
    /** ARM resource ID of the setting. */
    settingResourceId: string;
    /** Kind of the setting. */
    kind: string;
    /** Sentinel workspace of the setting. */
    workspace: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** Last modification time (UTC). */
    lastModifiedUtc: string | undefined;
    /** ETag of the setting. */
    etag: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Microsoft Sentinel ML analytics (anomaly rule) settings: customizes a
 * built-in anomaly detection model — thresholds, enabled state, and
 * whether it runs in production or flighting mode.
 *
 * The built-in definitions (`settingsDefinitionId`) are seeded into a
 * workspace by Microsoft some time after onboarding; list them with
 * `ListSecurityMLAnalyticsSettings`.
 *
 * @see https://learn.microsoft.com/azure/sentinel/work-with-anomaly-rules
 *
 * ### Tuning Anomaly Rules
 * **Example:** Run a customized anomaly model in flighting mode
 * ```typescript
 * yield* Azure.SecurityInsights.SecurityMLAnalyticsSetting("rare-logons", {
 *   resourceGroup: sentinel.resourceGroup,
 *   workspace: sentinel.workspace,
 *   displayName: "Unusual logons (tuned)",
 *   enabled: true,
 *   anomalyVersion: "1.0.5",
 *   frequency: "PT1H",
 *   settingsStatus: "Flighting",
 *   isDefaultSettings: false,
 *   settingsDefinitionId: "f209df4c-a1a8-4b2b-9b21-7b4f1a6ad7b6",
 *   customizableObservations: { thresholdObservation: [] },
 * });
 * ```
 *
 * @resource
 */
export const SecurityMLAnalyticsSetting = Resource<SecurityMLAnalyticsSetting>(
  "Azure.SecurityInsights.SecurityMLAnalyticsSetting",
);

type SettingProperties = Record<string, unknown> & {
  description?: string;
  lastModifiedUtc?: string;
};

const settingProperties = (
  setting: securityinsights.GetSecurityMLAnalyticsSettingsResponse | undefined,
): SettingProperties => (setting?.properties ?? {}) as SettingProperties;

const getSetting = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  settingsResourceName: string,
) =>
  orUndefinedIfNotFound(
    securityinsights.GetSecurityMLAnalyticsSettings({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      settingsResourceName,
    }),
  ).pipe(
    // Sentinel answers GET of a missing setting with 200 and an empty `{}`.
    Effect.map((setting) => (setting?.id === undefined ? undefined : setting)),
  );

const toAttrs = (
  resourceGroup: string,
  workspace: string,
  name: string,
  setting: securityinsights.GetSecurityMLAnalyticsSettingsResponse,
): SecurityMLAnalyticsSetting["Attributes"] => ({
  settingsResourceName: name,
  settingResourceId: setting.id ?? "",
  kind: setting.kind,
  workspace,
  resourceGroup,
  lastModifiedUtc: settingProperties(setting).lastModifiedUtc,
  etag: setting.etag,
});

export const SecurityMLAnalyticsSettingProvider = () =>
  Provider.succeed(SecurityMLAnalyticsSetting, {
    stables: [
      "settingsResourceName",
      "settingResourceId",
      "kind",
      "workspace",
      "resourceGroup",
    ],

    // Settings live inside the workspace; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        !sameText(news.workspace, output.workspace) ||
        !sameText(news.kind ?? "Anomaly", output.kind) ||
        (news.settingsResourceName !== undefined &&
          !sameText(news.settingsResourceName, output.settingsResourceName)) ||
        (olds !== undefined &&
          !sameText(news.settingsDefinitionId, olds.settingsDefinitionId))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const workspace = output?.workspace ?? olds?.workspace;
      if (resourceGroup === undefined || workspace === undefined) {
        return undefined;
      }
      const name =
        output?.settingsResourceName ??
        olds?.settingsResourceName ??
        (yield* deterministicGuid(id, instanceId));
      const observed = yield* getSetting(
        subscriptionId,
        resourceGroup,
        workspace,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, name, observed);
      const owned =
        (yield* isWorkspaceOwnedByStack(
          subscriptionId,
          resourceGroup,
          workspace,
        )) &&
        (yield* hasOwnMarker(id, settingProperties(observed).description));
      return owned ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, SENTINEL_NAMESPACE);
      const { resourceGroup, workspace } = news;
      const name =
        news.settingsResourceName ??
        output?.settingsResourceName ??
        (yield* deterministicGuid(id, instanceId));
      const marker = yield* ownershipMarker(id);
      const desired = compact({
        displayName: news.displayName,
        description: withMarker(news.description, marker),
        enabled: news.enabled,
        anomalyVersion: news.anomalyVersion,
        frequency: news.frequency,
        settingsStatus: news.settingsStatus,
        isDefaultSettings: news.isDefaultSettings,
        anomalySettingsVersion: news.anomalySettingsVersion,
        settingsDefinitionId: news.settingsDefinitionId,
        customizableObservations: news.customizableObservations,
        requiredDataConnectors: news.requiredDataConnectors,
        tactics: news.tactics,
        techniques: news.techniques,
      });

      let observed = yield* getSetting(
        subscriptionId,
        resourceGroup,
        workspace,
        name,
      );
      if (
        observed === undefined ||
        !subsetEqual(desired, settingProperties(observed))
      ) {
        observed =
          yield* securityinsights.SecurityMLAnalyticsSettingsCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            workspaceName: workspace,
            settingsResourceName: name,
            kind: (news.kind ??
              "Anomaly") as securityinsights.SecurityMLAnalyticsSettingsKind,
            etag: observed?.etag,
            properties: desired,
          }).pipe(
            // Sentinel provisions the anomalies backend a few seconds after
            // onboarding; until then PUT is rejected as "not supported".
            Effect.retry({
              while: (e) => e._tag === "SentinelAnomaliesNotSupported",
              schedule: Schedule.spaced("10 seconds"),
              times: 18,
            }),
          );
      }
      return toAttrs(resourceGroup, workspace, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        securityinsights.DeleteSecurityMLAnalyticsSettings({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspace,
          settingsResourceName: output.settingsResourceName,
        }),
      );
      yield* waitUntilGone(
        `ML analytics setting ${output.settingsResourceName}`,
        getSetting(
          subscriptionId,
          output.resourceGroup,
          output.workspace,
          output.settingsResourceName,
        ),
      );
    }),
  });
