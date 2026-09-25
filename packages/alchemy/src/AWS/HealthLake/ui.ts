import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { FHIRDatastore } from "./FHIRDatastore.ts";

/**
 * Dashboard UI providers for AWS HealthLake resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const FHIRDatastoreUI = UIProvider.succeed<FHIRDatastore>(
  "AWS.HealthLake.FHIRDatastore",
  {
    displayName: "HealthLake FHIR Datastore",
    icon: "heart-pulse",
    color: "#01A88D",
    category: "ai",
    summary: (ctx) => ctx.attrs?.datastoreName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.datastoreName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.datastoreArn,
        mono: true,
        copy: true,
      },
      { label: "id", value: ctx.attrs?.datastoreId, mono: true },
      { label: "status", value: ctx.attrs?.datastoreStatus },
      {
        label: "endpoint",
        value: ctx.attrs?.datastoreEndpoint,
        mono: true,
        copy: true,
      },
      { label: "fhir version", value: ctx.attrs?.datastoreTypeVersion },
    ],
  },
);

export const ui = () => Layer.mergeAll(FHIRDatastoreUI);
