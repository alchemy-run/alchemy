import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Application } from "./Application.ts";
import type { DataSource } from "./DataSource.ts";
import type { Retriever } from "./Retriever.ts";
import type { Index } from "./SearchIndex.ts";
import type { WebExperience } from "./WebExperience.ts";

/**
 * Dashboard UI providers for AWS QBusiness resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const COLOR = "#01A88D";

export const ApplicationUI = UIProvider.succeed<Application>(
  "AWS.QBusiness.Application",
  {
    displayName: "Q Business Application",
    icon: "bot",
    color: COLOR,
    category: "ai",
    summary: (ctx) => ctx.attrs?.displayName,
    facts: (ctx) => [
      { label: "application", value: ctx.attrs?.displayName, copy: true },
      {
        label: "id",
        value: ctx.attrs?.applicationId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.applicationArn,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
      { label: "identity type", value: ctx.attrs?.identityType },
      { label: "role", value: ctx.attrs?.roleArn, mono: true },
    ],
  },
);

export const IndexUI = UIProvider.succeed<Index>("AWS.QBusiness.Index", {
  displayName: "Q Business Index",
  icon: "search",
  color: COLOR,
  category: "ai",
  summary: (ctx) => ctx.attrs?.displayName,
  facts: (ctx) => [
    { label: "index", value: ctx.attrs?.displayName, copy: true },
    { label: "id", value: ctx.attrs?.indexId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.indexArn, mono: true, copy: true },
    { label: "application", value: ctx.attrs?.applicationId, mono: true },
    { label: "type", value: ctx.attrs?.type },
    { label: "status", value: ctx.attrs?.status },
  ],
});

export const DataSourceUI = UIProvider.succeed<DataSource>(
  "AWS.QBusiness.DataSource",
  {
    displayName: "Q Business Data Source",
    icon: "database",
    color: COLOR,
    category: "ai",
    summary: (ctx) => ctx.attrs?.displayName,
    facts: (ctx) => [
      { label: "data source", value: ctx.attrs?.displayName, copy: true },
      {
        label: "id",
        value: ctx.attrs?.dataSourceId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.dataSourceArn,
        mono: true,
        copy: true,
      },
      { label: "index", value: ctx.attrs?.indexId, mono: true },
      { label: "type", value: ctx.attrs?.type },
      { label: "status", value: ctx.attrs?.status },
    ],
  },
);

export const RetrieverUI = UIProvider.succeed<Retriever>(
  "AWS.QBusiness.Retriever",
  {
    displayName: "Q Business Retriever",
    icon: "search",
    color: COLOR,
    category: "ai",
    summary: (ctx) => ctx.attrs?.displayName,
    facts: (ctx) => [
      { label: "retriever", value: ctx.attrs?.displayName, copy: true },
      {
        label: "id",
        value: ctx.attrs?.retrieverId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.retrieverArn,
        mono: true,
        copy: true,
      },
      { label: "application", value: ctx.attrs?.applicationId, mono: true },
      { label: "type", value: ctx.attrs?.type },
      { label: "status", value: ctx.attrs?.status },
    ],
  },
);

export const WebExperienceUI = UIProvider.succeed<WebExperience>(
  "AWS.QBusiness.WebExperience",
  {
    displayName: "Q Business Web Experience",
    icon: "message-square",
    color: COLOR,
    category: "ai",
    summary: (ctx) => ctx.attrs?.webExperienceId,
    link: (ctx) => ctx.attrs?.defaultEndpoint,
    facts: (ctx) => [
      {
        label: "id",
        value: ctx.attrs?.webExperienceId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.webExperienceArn,
        mono: true,
        copy: true,
      },
      { label: "application", value: ctx.attrs?.applicationId, mono: true },
      {
        label: "endpoint",
        value: ctx.attrs?.defaultEndpoint,
        href: ctx.attrs?.defaultEndpoint,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    ApplicationUI,
    IndexUI,
    DataSourceUI,
    RetrieverUI,
    WebExperienceUI,
  );
