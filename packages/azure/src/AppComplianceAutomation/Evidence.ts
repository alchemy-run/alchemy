import * as acat from "@distilled.cloud/azure/appcomplianceautomation";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { generatedName, REPORTS_PREFIX, sameName, userToken } from "./internal.ts";

export interface EvidenceProps {
  /** Name of the report, e.g. `report.reportName`. Changing it replaces the evidence. */
  reportName: string;
  /**
   * Evidence name, unique in the report: letters, digits, `-`, `_` and `.`.
   * If omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the evidence.
   * @default a name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Path of the evidence file in the report's storage account (see the
   * report's `storageInfo`), e.g. `/evidence/encryption-policy.pdf`.
   */
  filePath: string;
  /**
   * Kind of evidence: an uploaded `File`, `AutoCollectedEvidence`, or `Data`.
   * @default "File"
   */
  evidenceType?: "File" | "AutoCollectedEvidence" | "Data";
  /**
   * Extra data submitted as evidence.
   * @default no extra data
   */
  extraData?: string;
  /**
   * Control the evidence answers, e.g. `Operational_Security_10`.
   * @default not set
   */
  controlId?: string;
  /**
   * Customer responsibility of the control the evidence answers.
   * @default not set
   */
  responsibilityId?: string;
}

export interface Evidence extends Resource<
  "Azure.AppComplianceAutomation.Evidence",
  EvidenceProps,
  {
    /** Evidence name. */
    evidenceName: string;
    /** ARM ID of the evidence. */
    evidenceId: string;
    /** Report that holds the evidence. */
    reportName: string;
    /** Path of the evidence file in storage. */
    filePath: string;
    /** Kind of evidence. */
    evidenceType: string | undefined;
    /** Control the evidence answers. */
    controlId: string | undefined;
    /** Customer responsibility the evidence answers. */
    responsibilityId: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A piece of evidence of an App Compliance Automation Tool (ACAT) report
 * (`Microsoft.AppComplianceAutomation/reports/evidences`) — a file in the
 * report's storage account (or extra data) submitted for one control of the
 * Microsoft 365 Certification.
 *
 * Upload the file to the report's storage account first; the evidence only
 * records where it is. Evidence carries no tags: Alchemy recognises its own
 * evidence by the generated name, so an explicit `name` that already exists
 * is only taken over with `--adopt`.
 *
 * :::caution
 * Changing `reportName` or `name` replaces the evidence.
 * :::
 *
 * @see https://learn.microsoft.com/rest/api/appcompliance/evidence
 *
 * ### Creating Evidence
 * **Example:** Evidence file for a control
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("evidence");
 * const report = yield* Azure.AppComplianceAutomation.Report("m365-cert", {
 *   resources: [{ resourceId: account.storageAccountId }],
 * });
 * const evidence = yield* Azure.AppComplianceAutomation.Evidence("tls-policy", {
 *   reportName: report.reportName,
 *   filePath: "/evidence/tls-policy.pdf",
 *   controlId: "Operational_Security_10",
 * });
 * ```
 *
 * @resource
 */
export const Evidence = Resource<Evidence>("Azure.AppComplianceAutomation.Evidence");

interface Where {
  reportName: string;
  evidenceName: string;
}

const getEvidence = (where: Where) =>
  Effect.gen(function* () {
    const token = yield* userToken;
    return yield* orUndefinedIfNotFound(acat.GetEvidence({ ...where, userToken: token }));
  });

const toAttrs = (where: Where, observed: acat.GetEvidenceResponse): Evidence["Attributes"] => ({
  evidenceName: where.evidenceName,
  evidenceId: observed.id ?? `${REPORTS_PREFIX}${where.reportName}/evidences/${where.evidenceName}`,
  reportName: where.reportName,
  filePath: observed.properties.filePath,
  evidenceType: observed.properties.evidenceType,
  controlId: observed.properties.controlId,
  responsibilityId: observed.properties.responsibilityId,
});

export const EvidenceProvider = () =>
  Provider.succeed(Evidence, {
    stables: ["evidenceName", "evidenceId", "reportName"],

    // Evidence lives inside a report; deleting the report removes it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.reportName, output.reportName) ||
        (news.name !== undefined && !sameName(news.name, output.evidenceName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output }) {
      const reportName = output?.reportName ?? olds?.reportName;
      if (reportName === undefined) return undefined;
      const generated = yield* generatedName(id, instanceId, 64);
      const where = { reportName, evidenceName: output?.evidenceName ?? olds?.name ?? generated };
      const observed = yield* getEvidence(where);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(where, observed);
      return output !== undefined || where.evidenceName === generated ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const where = {
        reportName: news.reportName,
        evidenceName:
          news.name ?? output?.evidenceName ?? (yield* generatedName(id, instanceId, 64)),
      };
      const properties: acat.EvidencePropertiesInput = {
        filePath: news.filePath,
        evidenceType: news.evidenceType ?? "File",
        extraData: news.extraData,
        controlId: news.controlId,
        responsibilityId: news.responsibilityId,
      };

      // Observe.
      const observed = yield* getEvidence(where);

      // Ensure + sync: the PUT is an upsert of the whole evidence record, so
      // one write converges both a missing and a drifted record.
      const current = observed?.properties;
      const drifted =
        current === undefined ||
        current.filePath !== properties.filePath ||
        current.evidenceType !== properties.evidenceType ||
        current.extraData !== properties.extraData ||
        current.controlId !== properties.controlId ||
        current.responsibilityId !== properties.responsibilityId;
      if (drifted) {
        const token = yield* userToken;
        yield* acat.EvidenceCreateOrUpdate({ ...where, userToken: token, properties });
      }

      const fresh = yield* waitForProvisioned(
        `app compliance evidence ${where.evidenceName}`,
        getEvidence(where),
        (evidence) => evidence.properties.provisioningState,
        { interval: "3 seconds", times: 20 },
      );
      return toAttrs(where, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const where = { reportName: output.reportName, evidenceName: output.evidenceName };
      const token = yield* userToken;
      yield* ignoreNotFound(acat.DeleteEvidence({ ...where, userToken: token }));
      yield* waitUntilGone(`app compliance evidence ${output.evidenceName}`, getEvidence(where));
    }),

    nuke: { dependsOn: ["Azure.AppComplianceAutomation.Report"] },
  });
