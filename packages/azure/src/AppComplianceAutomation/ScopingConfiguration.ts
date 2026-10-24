import * as acat from "@distilled.cloud/azure/appcomplianceautomation";
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
import { REPORTS_PREFIX, sameName, userToken } from "./internal.ts";

/** The answer to one scoping question. */
export interface ScopingAnswer {
  /** Question ID, from the report's scoping questions. */
  questionId: string;
  /** Answer values (option IDs or free text, depending on the question). */
  answers: string[];
}

export interface ScopingConfigurationProps {
  /** Name of the report, e.g. `report.reportName`. Changing it replaces the configuration. */
  reportName: string;
  /** Answers to the report's scoping questions. */
  answers: ScopingAnswer[];
}

export interface ScopingConfiguration extends Resource<
  "Azure.AppComplianceAutomation.ScopingConfiguration",
  ScopingConfigurationProps,
  {
    /** Report the configuration scopes. */
    reportName: string;
    /** ARM ID of the configuration. */
    scopingConfigurationId: string;
    /** Answers to the scoping questions. */
    answers: ScopingAnswer[];
  },
  never,
  Providers
> {}

/**
 * The scoping configuration of an App Compliance Automation Tool (ACAT)
 * report (`Microsoft.AppComplianceAutomation/reports/scopingConfigurations`)
 * — the answers to the report's scoping questions, which decide which
 * Microsoft 365 Certification controls apply to the app.
 *
 * Each report has one scoping configuration, named `default`.
 *
 * :::caution
 * Changing `reportName` replaces the configuration.
 * :::
 *
 * @see https://learn.microsoft.com/rest/api/appcompliance/scoping-configuration
 *
 * ### Answering the Scoping Questions
 * **Example:** Scoping answers for a report
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("evidence");
 * const report = yield* Azure.AppComplianceAutomation.Report("m365-cert", {
 *   resources: [{ resourceId: account.storageAccountId }],
 * });
 * const scoping = yield* Azure.AppComplianceAutomation.ScopingConfiguration("scoping", {
 *   reportName: report.reportName,
 *   answers: [{ questionId: "GDPR_global", answers: ["Yes"] }],
 * });
 * ```
 *
 * @resource
 */
export const ScopingConfiguration = Resource<ScopingConfiguration>(
  "Azure.AppComplianceAutomation.ScopingConfiguration",
);

/** The service accepts only this name: the configuration is a singleton. */
const NAME = "default";

const getConfiguration = (reportName: string) =>
  Effect.gen(function* () {
    const token = yield* userToken;
    return yield* orUndefinedIfNotFound(
      acat.GetScopingConfiguration({
        reportName,
        scopingConfigurationName: NAME,
        userToken: token,
      }),
    );
  });

const toAttrs = (
  reportName: string,
  observed: acat.GetScopingConfigurationResponse,
): ScopingConfiguration["Attributes"] => ({
  reportName,
  scopingConfigurationId:
    observed.id ?? `${REPORTS_PREFIX}${reportName}/scopingConfigurations/${NAME}`,
  answers: (observed.properties.answers ?? []).map((a) => ({
    questionId: a.questionId,
    answers: [...a.answers],
  })),
});

const answersMatch = (observed: acat.ScopingAnswer[] | undefined, desired: ScopingAnswer[]) => {
  const current = observed ?? [];
  return (
    current.length === desired.length &&
    desired.every((want) => {
      const have = current.find((a) => a.questionId === want.questionId);
      return (
        have !== undefined &&
        have.answers.length === want.answers.length &&
        want.answers.every((value) => have.answers.includes(value))
      );
    })
  );
};

export const ScopingConfigurationProvider = () =>
  Provider.succeed(ScopingConfiguration, {
    stables: ["reportName", "scopingConfigurationId"],

    // The configuration lives inside a report; deleting the report removes it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (!sameName(news.reportName, output.reportName)) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    // A singleton of the report the user names: no ownership check.
    read: Effect.fn(function* ({ olds, output }) {
      const reportName = output?.reportName ?? olds?.reportName;
      if (reportName === undefined) return undefined;
      const observed = yield* getConfiguration(reportName);
      return observed === undefined ? undefined : toAttrs(reportName, observed);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      // Observe.
      const observed = yield* getConfiguration(news.reportName);

      // Ensure + sync: the PUT replaces the whole answer list.
      if (observed === undefined || !answersMatch(observed.properties.answers, news.answers)) {
        const token = yield* userToken;
        yield* acat.ScopingConfigurationCreateOrUpdate({
          reportName: news.reportName,
          scopingConfigurationName: NAME,
          userToken: token,
          properties: { answers: news.answers },
        });
      }

      const fresh = yield* waitForProvisioned(
        `app compliance scoping configuration of ${news.reportName}`,
        getConfiguration(news.reportName),
        (configuration) => configuration.properties.provisioningState,
        { interval: "3 seconds", times: 20 },
      );
      return toAttrs(news.reportName, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const token = yield* userToken;
      yield* ignoreNotFound(
        acat.DeleteScopingConfiguration({
          reportName: output.reportName,
          scopingConfigurationName: NAME,
          userToken: token,
        }),
      );
      yield* waitUntilGone(
        `app compliance scoping configuration of ${output.reportName}`,
        getConfiguration(output.reportName),
      );
    }),

    nuke: { dependsOn: ["Azure.AppComplianceAutomation.Report"] },
  });
