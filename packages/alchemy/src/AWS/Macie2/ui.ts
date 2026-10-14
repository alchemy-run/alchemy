import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { AllowList } from "./AllowList.ts";
import type { ClassificationJob } from "./ClassificationJob.ts";
import type { CustomDataIdentifier } from "./CustomDataIdentifier.ts";
import type { FindingsFilter } from "./FindingsFilter.ts";
import type { Session } from "./Session.ts";

/**
 * Dashboard UI providers for AWS Macie2 resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Security, Identity & Compliance (Macie) brand red. */
const COLOR = "#DD344C";

export const AllowListUI = UIProvider.succeed<AllowList>(
  "AWS.Macie2.AllowList",
  {
    displayName: "Macie Allow List",
    icon: "list-ordered",
    color: COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.id, mono: true, copy: true },
      { label: "arn", value: ctx.attrs?.arn, mono: true, copy: true },
      { label: "status", value: ctx.attrs?.status },
    ],
  },
);

export const ClassificationJobUI = UIProvider.succeed<ClassificationJob>(
  "AWS.Macie2.ClassificationJob",
  {
    displayName: "Macie Classification Job",
    icon: "search",
    color: COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "job id", value: ctx.attrs?.jobId, mono: true, copy: true },
      { label: "arn", value: ctx.attrs?.jobArn, mono: true, copy: true },
      { label: "status", value: ctx.attrs?.jobStatus },
    ],
  },
);

export const CustomDataIdentifierUI = UIProvider.succeed<CustomDataIdentifier>(
  "AWS.Macie2.CustomDataIdentifier",
  {
    displayName: "Macie Custom Data Identifier",
    icon: "fingerprint",
    color: COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.id, mono: true, copy: true },
      { label: "arn", value: ctx.attrs?.arn, mono: true, copy: true },
    ],
  },
);

export const FindingsFilterUI = UIProvider.succeed<FindingsFilter>(
  "AWS.Macie2.FindingsFilter",
  {
    displayName: "Macie Findings Filter",
    icon: "filter",
    color: COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.id, mono: true, copy: true },
      { label: "arn", value: ctx.attrs?.arn, mono: true, copy: true },
      { label: "action", value: ctx.attrs?.action },
    ],
  },
);

export const SessionUI = UIProvider.succeed<Session>("AWS.Macie2.Session", {
  displayName: "Macie Session",
  icon: "shield",
  color: COLOR,
  category: "security",
  summary: (ctx) => ctx.attrs?.accountId,
  facts: (ctx) => [
    { label: "account", value: ctx.attrs?.accountId, mono: true, copy: true },
    { label: "status", value: ctx.attrs?.status },
    {
      label: "finding frequency",
      value: ctx.attrs?.findingPublishingFrequency,
    },
    { label: "service role", value: ctx.attrs?.serviceRole, mono: true },
    { label: "created", value: ctx.attrs?.createdAt },
  ],
});

export const ui = () =>
  Layer.mergeAll(
    AllowListUI,
    ClassificationJobUI,
    CustomDataIdentifierUI,
    FindingsFilterUI,
    SessionUI,
  );
