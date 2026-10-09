import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { LocationEfs } from "./LocationEfs.ts";
import type { LocationS3 } from "./LocationS3.ts";
import type { Task } from "./Task.ts";

/**
 * Dashboard UI providers for AWS DataSync resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Storage (DataSync) brand green. */
const COLOR = "#7AA116";

export const LocationEfsUI = UIProvider.succeed<LocationEfs>(
  "AWS.DataSync.LocationEfs",
  {
    displayName: "DataSync EFS Location",
    icon: "hard-drive",
    color: COLOR,
    category: "storage",
    summary: (ctx) => ctx.attrs?.locationUri,
    facts: (ctx) => [
      {
        label: "uri",
        value: ctx.attrs?.locationUri,
        mono: true,
        copy: true,
      },
      { label: "arn", value: ctx.attrs?.locationArn, mono: true, copy: true },
    ],
  },
);

export const LocationS3UI = UIProvider.succeed<LocationS3>(
  "AWS.DataSync.LocationS3",
  {
    displayName: "DataSync S3 Location",
    icon: "cylinder",
    color: COLOR,
    category: "storage",
    summary: (ctx) => ctx.attrs?.locationUri,
    facts: (ctx) => [
      {
        label: "uri",
        value: ctx.attrs?.locationUri,
        mono: true,
        copy: true,
      },
      { label: "arn", value: ctx.attrs?.locationArn, mono: true, copy: true },
    ],
  },
);

export const TaskUI = UIProvider.succeed<Task>("AWS.DataSync.Task", {
  displayName: "DataSync Task",
  icon: "repeat",
  color: COLOR,
  category: "storage",
  summary: (ctx) => ctx.attrs?.taskArn,
  facts: (ctx) => [
    { label: "arn", value: ctx.attrs?.taskArn, mono: true, copy: true },
    { label: "status", value: ctx.attrs?.taskStatus },
    {
      label: "source",
      value: ctx.attrs?.sourceLocationArn,
      mono: true,
      copy: true,
    },
    {
      label: "destination",
      value: ctx.attrs?.destinationLocationArn,
      mono: true,
      copy: true,
    },
  ],
});

export const ui = () => Layer.mergeAll(LocationEfsUI, LocationS3UI, TaskUI);
