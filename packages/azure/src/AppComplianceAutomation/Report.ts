import * as acat from "@distilled.cloud/azure/appcomplianceautomation";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { generatedName, REPORTS_PREFIX, sameInstant, sameName, userToken } from "./internal.ts";

/** One resource the report assesses. */
export interface ReportResourceProps {
  /**
   * ARM resource ID (or, for another cloud, that cloud's resource ID), e.g.
   * `account.storageAccountId`.
   */
  resourceId: string;
  /** Resource type, e.g. `Microsoft.Storage/storageAccounts`. */
  resourceType?: string;
  /** Resource kind, e.g. a storage account's `StorageV2`. */
  resourceKind?: string;
  /**
   * Cloud that hosts the resource: `Azure`, `AWS`, or `GCP`.
   * @default "Azure"
   */
  resourceOrigin?: "Azure" | "AWS" | "GCP";
  /** Account ID of a non-Azure resource, e.g. the AWS account ID. */
  accountId?: string;
}

/** A "bring your own storage" account that holds the report's evidence files. */
export interface ReportStorageInfo {
  /** Subscription of the storage account. */
  subscriptionId: string;
  /** Resource group of the storage account. */
  resourceGroup: string;
  /** Storage account name. */
  accountName: string;
  /** Region of the storage account, e.g. `eastus`. */
  location: string;
}

export interface ReportProps {
  /**
   * Report name, unique in the tenant: 1-50 letters, digits, `-` and `_`.
   * If omitted, a unique name is generated from the app, stage, and logical
   * ID.
   */
  name?: string;
  /** Resources the report assesses daily against the Microsoft 365 Certification controls. */
  resources: ReportResourceProps[];
  /**
   * Windows time zone ID of `triggerTime`, e.g. `Pacific Standard Time`
   * (`Get-TimeZone -ListAvailable` lists them).
   * @default "UTC"
   */
  timeZone?: string;
  /**
   * When the daily collection runs, as an ISO 8601 timestamp; only its time
   * of day matters.
   * @default "2024-01-01T00:00:00Z" (midnight)
   */
  triggerTime?: string;
  /**
   * Comma-separated Partner Center offer GUIDs the report certifies, e.g.
   * `"00000000-0000-0000-0000-000000000001"`.
   */
  offerGuid?: string;
  /** Storage account for the report's evidence files ("bring your own storage"). */
  storageInfo?: ReportStorageInfo;
}

export interface Report extends Resource<
  "Azure.AppComplianceAutomation.Report",
  ReportProps,
  {
    /** Report name. */
    reportName: string;
    /** ARM ID, `/providers/Microsoft.AppComplianceAutomation/reports/{name}`. */
    reportId: string;
    /** Microsoft Entra tenant that holds the report. */
    tenantId: string | undefined;
    /** Report status: `Active`, `Failed`, `Reviewing`, or `Disabled`. */
    status: string | undefined;
    /** Subscriptions of the assessed resources. */
    subscriptions: string[];
    /** Partner Center offer GUIDs mapped to the report. */
    offerGuid: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An App Compliance Automation Tool (ACAT) report
 * (`Microsoft.AppComplianceAutomation/reports`) — a tenant-level compliance
 * report that assesses a Microsoft 365 app's cloud resources every day
 * against the Microsoft 365 Certification controls and collects the
 * evidence for Partner Center.
 *
 * Reports live in the tenant, outside any subscription or resource group.
 * Reconcile registers `Microsoft.AppComplianceAutomation` and onboards the
 * subscriptions of the assessed resources. The deploying identity needs the
 * App Compliance Automation Administrator role on those subscriptions.
 * Reports carry no tags: Alchemy recognises its own report by the generated
 * name, so an explicit `name` that already exists is only taken over with
 * `--adopt`.
 *
 * :::caution
 * Changing `name` replaces the report (its snapshots and evidence go with it).
 * :::
 *
 * :::caution
 * Microsoft.AppComplianceAutomation acts on behalf of the caller. It refuses
 * report writes from an app-only (service principal) token with HTTP 502
 * `BearerFallbackDisabled`, so deploy reports as a signed-in user.
 * :::
 *
 * @see https://learn.microsoft.com/microsoft-365-app-certification/docs/acat-overview
 *
 * ### Creating a Report
 * **Example:** Assess a storage account
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("evidence");
 * const report = yield* Azure.AppComplianceAutomation.Report("m365-cert", {
 *   resources: [
 *     {
 *       resourceId: account.storageAccountId,
 *       resourceType: "Microsoft.Storage/storageAccounts",
 *     },
 *   ],
 *   timeZone: "Pacific Standard Time",
 *   triggerTime: "2024-01-01T09:00:00Z",
 * });
 * ```
 *
 * @resource
 */
export const Report = Resource<Report>("Azure.AppComplianceAutomation.Report");

const DEFAULT_TIME_ZONE = "UTC";
const DEFAULT_TRIGGER_TIME = "2024-01-01T00:00:00Z";

const getReport = (reportName: string) =>
  Effect.gen(function* () {
    const token = yield* userToken;
    return yield* orUndefinedIfNotFound(acat.GetReport({ reportName, userToken: token }));
  });

const toAttrs = (name: string, report: acat.GetReportResponse): Report["Attributes"] => ({
  reportName: name,
  reportId: report.id ?? `${REPORTS_PREFIX}${name}`,
  tenantId: report.properties.tenantId,
  status: report.properties.status,
  subscriptions: report.properties.subscriptions ?? [],
  offerGuid: report.properties.offerGuid,
});

const desiredResources = (resources: ReportResourceProps[]): acat.ResourceMetadata[] =>
  resources.map((resource) => ({
    ...resource,
    resourceOrigin: resource.resourceOrigin ?? "Azure",
  }));

/** Subscriptions of the Azure resources a report assesses. */
const subscriptionsOf = (resources: acat.ResourceMetadata[]) => [
  ...new Set(
    resources
      .filter((resource) => resource.resourceOrigin === "Azure")
      .map((resource) => resource.resourceId.match(/^\/subscriptions\/([^/]+)/i)?.[1])
      .filter((id): id is string => id !== undefined)
      .map((id) => id.toLowerCase()),
  ),
];

/** Whether the observed resource list matches the desired one. */
const resourcesMatch = (
  observed: acat.ResourceMetadata[] | undefined,
  desired: acat.ResourceMetadata[],
) => {
  const current = observed ?? [];
  if (current.length !== desired.length) return false;
  return desired.every((want) => {
    const have = current.find((r) => sameName(r.resourceId, want.resourceId));
    if (have === undefined) return false;
    // The service fills in type, kind and origin; compare only what is set.
    return (["resourceType", "resourceKind", "resourceOrigin", "accountId"] as const).every(
      (key) => want[key] === undefined || sameName(have[key] ?? "", want[key]),
    );
  });
};

const storageMatches = (
  observed: acat.StorageInfo | undefined,
  desired: ReportStorageInfo | undefined,
) =>
  desired === undefined ||
  (observed !== undefined &&
    sameName(observed.subscriptionId ?? "", desired.subscriptionId) &&
    sameName(observed.resourceGroup ?? "", desired.resourceGroup) &&
    sameName(observed.accountName ?? "", desired.accountName) &&
    sameName((observed.location ?? "").replaceAll(" ", ""), desired.location.replaceAll(" ", "")));

export const ReportProvider = () =>
  Provider.succeed(Report, {
    stables: ["reportName", "reportId", "tenantId"],

    // Reports carry no tags or other free-form field for an ownership
    // marker, so there is no Alchemy-owned `list`.

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (news.name !== undefined && !sameName(news.name, output.reportName)) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output }) {
      const generated = yield* generatedName(id, instanceId);
      const name = output?.reportName ?? olds?.name ?? generated;
      const observed = yield* getReport(name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(name, observed);
      // No tags: a report we created is either in state or carries the
      // instance-unique generated name.
      return output !== undefined || name === generated ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.AppComplianceAutomation");
      const name = news.name ?? output?.reportName ?? (yield* generatedName(id, instanceId));
      const resources = desiredResources(news.resources);
      const timeZone = news.timeZone ?? DEFAULT_TIME_ZONE;
      const triggerTime = news.triggerTime ?? DEFAULT_TRIGGER_TIME;
      const token = yield* userToken;
      const wait = waitForProvisioned(
        `app compliance report ${name}`,
        getReport(name),
        (report) => report.properties.provisioningState,
        { interval: "10 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* getReport(name);

      // The service assesses only resources of onboarded subscriptions;
      // onboarding is idempotent.
      const observedSubscriptions = new Set(
        (observed?.properties.subscriptions ?? []).map((s) => s.toLowerCase()),
      );
      const missingSubscriptions = subscriptionsOf(resources).filter(
        (s) => !observedSubscriptions.has(s),
      );
      if (missingSubscriptions.length > 0) {
        yield* acat.ProviderActionsOnboard({
          subscriptionIds: missingSubscriptions,
          userToken: token,
        });
      }

      // Ensure.
      if (observed === undefined) {
        yield* acat.ReportCreateOrUpdate({
          reportName: name,
          userToken: token,
          properties: {
            resources,
            timeZone,
            triggerTime,
            offerGuid: news.offerGuid,
            storageInfo: news.storageInfo,
          },
        });
        observed = yield* wait;
      }

      // Sync each mutable setting against the observed report.
      const current = observed.properties;
      const patch: acat.ReportPatchPropertiesInput = {
        resources: resourcesMatch(current.resources, resources) ? undefined : resources,
        timeZone: current.timeZone === timeZone ? undefined : timeZone,
        triggerTime: sameInstant(current.triggerTime, triggerTime) ? undefined : triggerTime,
        offerGuid:
          news.offerGuid === undefined || current.offerGuid === news.offerGuid
            ? undefined
            : news.offerGuid,
        storageInfo: storageMatches(current.storageInfo, news.storageInfo)
          ? undefined
          : news.storageInfo,
      };
      if (Object.values(patch).some((value) => value !== undefined)) {
        yield* acat.UpdateReport({ reportName: name, userToken: token, properties: patch });
        observed = yield* wait;
      }

      return toAttrs(name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const token = yield* userToken;
      yield* ignoreNotFound(acat.DeleteReport({ reportName: output.reportName, userToken: token }));
      yield* waitUntilGone(
        `app compliance report ${output.reportName}`,
        getReport(output.reportName),
        {
          interval: "5 seconds",
          times: 60,
        },
      );
    }),
  });
