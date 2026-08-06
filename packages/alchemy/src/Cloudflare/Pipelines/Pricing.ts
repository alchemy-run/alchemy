/**
 * Cloudflare's published rates for the Pipelines resources that have a
 * real, deterministic price — attached to each resource's
 * `ProviderService.pricing` (see `../../Provider.ts`, `../../Cost.ts`).
 *
 * Pipelines bills the two ends of the pipeline it can attribute volume to:
 * the SQL transform ({@link Pipeline}, per GB processed) and the delivery
 * to the destination ({@link Sink}, per GB of uncompressed data written).
 * Ingress into a {@link Stream} is free regardless of volume, so a Stream
 * carries no `pricing` field at all — absence is the representation for
 * free, not a $0 line. {@link LegacyPipeline} predates this rate table (the
 * published table covers Streams / SQL transforms / Sinks only) and is
 * likewise left unpriced.
 *
 * R2 storage and operations for the data a sink writes are billed
 * separately, on the R2 bucket resource itself (see `../R2/`).
 *
 * Rates verified against Cloudflare's published pricing docs, 2026-08:
 * - https://developers.cloudflare.com/pipelines/platform/pricing/
 *   (Streams ingress: unlimited, included; SQL transforms: 50 GB/month
 *   included, then $0.04/GB; Sinks egress: 50 GB/month included, then
 *   $0.03/GB for JSON and $0.06/GB for Parquet / Iceberg — all on the
 *   Workers Paid plan)
 *
 * Plan-time rule (same as a provider `diff`): props may still contain
 * unresolved `Output`s, so every price-determining prop is read through
 * `planProp` and degrades to a labeled default when its value is unknown.
 */
import { planProp, type ResourceCost } from "../../Cost.ts";
import type { PipelineProps } from "./Pipeline.ts";
import type { SinkProps } from "./Sink.ts";

/** SQL transform processing, per GB beyond the monthly allotment. */
const SQL_TRANSFORM_USD_PER_GB = 0.04;

/** Sink delivery, per GB of uncompressed data written as newline-delimited JSON. */
const SINK_JSON_USD_PER_GB = 0.03;

/** Sink delivery, per GB of uncompressed data written as Parquet or Iceberg. */
const SINK_PARQUET_USD_PER_GB = 0.06;

// ---------------------------------------------------------------------------
// Pipeline — SQL transforms, per GB processed
// ---------------------------------------------------------------------------

export const PipelinePricing: ResourceCost<PipelineProps> = {
  // Nothing is owed until events flow through the transform.
  floorMonthlyUsd: () => 0,
  requiresPaidPlan: true,
  rates: () => [
    {
      label: "Pipelines SQL transforms",
      perUnit: SQL_TRANSFORM_USD_PER_GB,
      unit: "GB processed",
      freeIncluded: "50 GB/mo free",
    },
  ],
};

// ---------------------------------------------------------------------------
// Sink — delivery, per GB written; the output format picks the rate
// ---------------------------------------------------------------------------

export const SinkPricing: ResourceCost<SinkProps> = {
  floorMonthlyUsd: () => 0,
  requiresPaidPlan: true,
  rates: (props) => {
    const type = planProp(props, "type");
    const format = planProp(props, "format");
    // An Iceberg sink always writes Parquet, whatever `format` says; an r2
    // sink writes whatever `format.type` selects (default `json`).
    const iceberg = type.value === "r2_data_catalog";
    const parquet = format.value?.type === "parquet";
    if (iceberg || parquet) {
      return [
        {
          label: iceberg
            ? "Pipelines sink delivery (Iceberg)"
            : "Pipelines sink delivery (Parquet)",
          perUnit: SINK_PARQUET_USD_PER_GB,
          unit: "GB delivered (uncompressed)",
          freeIncluded: "50 GB/mo free",
        },
      ];
    }
    // Neither known-Parquet nor known-Iceberg: the JSON rate is the
    // default, but say so when the deciding props are still unknown.
    const unresolved = type.unresolved || format.unresolved;
    return [
      {
        label: unresolved
          ? "Pipelines sink delivery (output format unresolved at plan time — JSON rates shown)"
          : "Pipelines sink delivery (JSON)",
        perUnit: SINK_JSON_USD_PER_GB,
        unit: "GB delivered (uncompressed)",
        freeIncluded: "50 GB/mo free",
      },
    ];
  },
};
