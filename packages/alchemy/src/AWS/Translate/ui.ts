import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { ParallelData } from "./ParallelData.ts";
import type { Terminology } from "./Terminology.ts";

/**
 * Dashboard UI providers for AWS Translate resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Machine Learning & AI (Translate) brand teal. */
const COLOR = "#01A88D";

export const ParallelDataUI = UIProvider.succeed<ParallelData>(
  "AWS.Translate.ParallelData",
  {
    displayName: "Translate Parallel Data",
    icon: "languages",
    color: COLOR,
    category: "ai",
    summary: (ctx) => ctx.attrs?.parallelDataName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.parallelDataName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.parallelDataArn,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
      { label: "source language", value: ctx.attrs?.sourceLanguageCode },
      {
        label: "target languages",
        value: ctx.attrs?.targetLanguageCodes?.join(", "),
      },
      { label: "imported records", value: ctx.attrs?.importedRecordCount },
    ],
  },
);

export const TerminologyUI = UIProvider.succeed<Terminology>(
  "AWS.Translate.Terminology",
  {
    displayName: "Translate Terminology",
    icon: "book-open",
    color: COLOR,
    category: "ai",
    summary: (ctx) => ctx.attrs?.terminologyName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.terminologyName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.terminologyArn,
        mono: true,
        copy: true,
      },
      { label: "source language", value: ctx.attrs?.sourceLanguageCode },
      {
        label: "target languages",
        value: ctx.attrs?.targetLanguageCodes?.join(", "),
      },
      { label: "term count", value: ctx.attrs?.termCount },
      { label: "directionality", value: ctx.attrs?.directionality },
    ],
  },
);

export const ui = () => Layer.mergeAll(ParallelDataUI, TerminologyUI);
