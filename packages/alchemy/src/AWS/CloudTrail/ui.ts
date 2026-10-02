import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { EventDataStore } from "./EventDataStore.ts";
import type { Trail } from "./Trail.ts";

/**
 * Dashboard UI providers for AWS CloudTrail resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Management & Governance / Observability (CloudTrail) brand pink. */
const COLOR = "#E7157B";

export const EventDataStoreUI = UIProvider.succeed<EventDataStore>(
  "AWS.CloudTrail.EventDataStore",
  {
    displayName: "CloudTrail Event Data Store",
    icon: "database",
    color: COLOR,
    category: "observability",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.eventDataStoreArn,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
      { label: "multi-region", value: ctx.props?.multiRegionEnabled },
      { label: "organization", value: ctx.props?.organizationEnabled },
    ],
  },
);

export const TrailUI = UIProvider.succeed<Trail>("AWS.CloudTrail.Trail", {
  displayName: "CloudTrail Trail",
  icon: "scroll-text",
  color: COLOR,
  category: "observability",
  summary: (ctx) => ctx.attrs?.trailName,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.trailName, copy: true },
    { label: "arn", value: ctx.attrs?.trailArn, mono: true, copy: true },
    { label: "region", value: ctx.attrs?.homeRegion },
    { label: "bucket", value: ctx.attrs?.s3BucketName, mono: true, copy: true },
    { label: "logging", value: ctx.attrs?.isLogging },
    { label: "multi-region", value: ctx.props?.isMultiRegionTrail },
  ],
});

export const ui = () => Layer.mergeAll(EventDataStoreUI, TrailUI);
