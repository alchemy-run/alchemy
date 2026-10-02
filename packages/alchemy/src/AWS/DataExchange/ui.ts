import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { DataSet } from "./DataSet.ts";
import type { EventAction } from "./EventAction.ts";
import type { Revision } from "./Revision.ts";

/**
 * Dashboard UI providers for AWS DataExchange resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const DataSetUI = UIProvider.succeed<DataSet>(
  "AWS.DataExchange.DataSet",
  {
    displayName: "Data Exchange Data Set",
    icon: "database",
    color: "#8C4FFF",
    category: "other",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "data set", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.dataSetId, mono: true, copy: true },
      { label: "arn", value: ctx.attrs?.dataSetArn, mono: true, copy: true },
      { label: "asset type", value: ctx.attrs?.assetType },
      { label: "origin", value: ctx.attrs?.origin },
    ],
  },
);

export const EventActionUI = UIProvider.succeed<EventAction>(
  "AWS.DataExchange.EventAction",
  {
    displayName: "Data Exchange Event Action",
    icon: "zap",
    color: "#8C4FFF",
    category: "eventing",
    summary: (ctx) => ctx.attrs?.eventActionId,
    facts: (ctx) => [
      {
        label: "action",
        value: ctx.attrs?.eventActionId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.eventActionArn,
        mono: true,
        copy: true,
      },
      { label: "data set", value: ctx.attrs?.dataSetId, mono: true },
      { label: "bucket", value: ctx.props?.exportRevisionToS3?.bucket },
    ],
  },
);

export const RevisionUI = UIProvider.succeed<Revision>(
  "AWS.DataExchange.Revision",
  {
    displayName: "Data Exchange Revision",
    icon: "git-branch",
    color: "#8C4FFF",
    category: "other",
    summary: (ctx) => ctx.attrs?.revisionId,
    facts: (ctx) => [
      {
        label: "revision",
        value: ctx.attrs?.revisionId,
        mono: true,
        copy: true,
      },
      { label: "arn", value: ctx.attrs?.revisionArn, mono: true, copy: true },
      { label: "data set", value: ctx.attrs?.dataSetId, mono: true },
      { label: "finalized", value: ctx.attrs?.finalized },
      { label: "comment", value: ctx.props?.comment },
    ],
  },
);

export const ui = () => Layer.mergeAll(DataSetUI, EventActionUI, RevisionUI);
