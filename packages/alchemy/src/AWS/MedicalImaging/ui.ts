import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Datastore } from "./Datastore.ts";

/**
 * Dashboard UI providers for AWS HealthImaging (Medical Imaging) resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const DatastoreUI = UIProvider.succeed<Datastore>(
  "AWS.MedicalImaging.Datastore",
  {
    displayName: "HealthImaging Data Store",
    icon: "scan",
    color: "#01A88D",
    category: "storage",
    summary: (ctx) => ctx.attrs?.datastoreName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.datastoreName, copy: true },
      { label: "id", value: ctx.attrs?.datastoreId, mono: true, copy: true },
      { label: "arn", value: ctx.attrs?.datastoreArn, mono: true, copy: true },
      { label: "status", value: ctx.attrs?.datastoreStatus },
      { label: "kms key", value: ctx.attrs?.kmsKeyArn, mono: true },
    ],
  },
);

export const ui = () => Layer.mergeAll(DatastoreUI);
