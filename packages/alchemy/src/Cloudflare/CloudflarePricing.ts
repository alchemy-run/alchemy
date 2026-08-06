/**
 * Cloudflare's published rates for the resources that have a real,
 * deterministic, per-unit billing dimension — attached to each resource's
 * `ProviderService.pricing` (see `../Provider.ts`, `../Cost.ts`).
 *
 * Scope, deliberately not exhaustive: alchemy-effect implements 245
 * distinct Cloudflare resource types. The other ~235 either cost nothing,
 * are bundled into an account-level Cloudflare plan tier this framework has
 * no visibility into, or are seat-billed independent of resource count —
 * pricing those would mean printing "$0 / included in your plan" noise for
 * the overwhelming majority of resources. Only the resources below have a
 * rate worth showing.
 *
 * None of these resources has a nonzero cost at zero usage — Cloudflare's
 * serverless products charge nothing until something actually runs
 * (Containers included, under the default scale-to-zero behavior). So
 * every `floorMonthlyUsd` here is `0`; the only real "floor" cost is the
 * flat $5/mo Workers Paid plan subscription fee, tracked once via
 * `requiresPaidPlan` rather than per-resource.
 *
 * Rates verified against Cloudflare's published pricing docs, 2026-07.
 * Re-verify periodically — these are constants, not a live lookup (see the
 * module docstring in `../Cost.ts` for why a live lookup isn't viable at
 * plan time).
 *
 * Plan-time rule (same as a provider `diff`): props may still contain
 * unresolved `Output`s, so every price-determining prop is read through
 * `planProp` and degrades to a labeled default when its value is unknown.
 */
import { planProp, type ResourceCost } from "../Cost.ts";
import type { ContainerApplication } from "./Containers/ContainerApplication.ts";
import type { DatabaseProps } from "./D1/Database.ts";
import type { NamespaceProps } from "./KV/Namespace.ts";
import type { QueueProps } from "./Queues/Queue.ts";
import type { BucketProps } from "./R2/Bucket.ts";
import type { IndexProps } from "./Vectorize/VectorizeIndex.ts";
import type { WorkerProps } from "./Workers/Worker.ts";

const SECONDS_PER_HOUR = 3600;

// ---------------------------------------------------------------------------
// Workers — requests + CPU time
// ---------------------------------------------------------------------------

export const WorkersPricing: ResourceCost<WorkerProps> = {
  floorMonthlyUsd: () => 0,
  requiresPaidPlan: true,
  rates: () => [
    {
      label: "Workers requests",
      perUnit: 0.3,
      unit: "million requests",
      freeIncluded: "10M/mo free",
    },
    {
      label: "Workers CPU time",
      perUnit: 0.02,
      unit: "million ms",
      freeIncluded: "30M ms/mo free",
    },
  ],
};

// ---------------------------------------------------------------------------
// KV — reads, writes, deletes, storage
// ---------------------------------------------------------------------------

export const KvPricing: ResourceCost<NamespaceProps> = {
  floorMonthlyUsd: () => 0,
  requiresPaidPlan: false,
  rates: () => [
    {
      label: "KV reads",
      perUnit: 0.5,
      unit: "million reads",
      freeIncluded: "10M/mo free",
    },
    {
      label: "KV writes",
      perUnit: 5.0,
      unit: "million writes",
      freeIncluded: "1M/mo free",
    },
    {
      label: "KV deletes",
      perUnit: 5.0,
      unit: "million deletes",
      freeIncluded: "1M/mo free",
    },
    {
      label: "KV storage",
      perUnit: 0.5,
      unit: "GB-month",
      freeIncluded: "1 GB free",
    },
  ],
};

// ---------------------------------------------------------------------------
// R2 — storage class picks the rate; egress is free on both classes
// ---------------------------------------------------------------------------

const R2_RATES = {
  Standard: { storage: 0.015, classA: 4.5, classB: 0.36 },
  InfrequentAccess: { storage: 0.01, classA: 9.0, classB: 0.9 },
} as const;

export const R2Pricing: ResourceCost<BucketProps> = {
  floorMonthlyUsd: () => 0,
  requiresPaidPlan: false,
  rates: (props) => {
    const storageClass = planProp(props, "storageClass");
    const cls = storageClass.value ?? "Standard";
    const rate = R2_RATES[cls];
    return [
      {
        label: storageClass.unresolved
          ? `R2 storage (storage class unresolved at plan time — ${cls} rates shown)`
          : `R2 storage (${cls})`,
        perUnit: rate.storage,
        unit: "GB-month",
      },
      {
        label: "R2 Class A operations",
        perUnit: rate.classA,
        unit: "million operations",
      },
      {
        label: "R2 Class B operations",
        perUnit: rate.classB,
        unit: "million operations",
      },
      {
        label: "R2 egress",
        perUnit: 0,
        unit: "GB",
        freeIncluded: "always free",
      },
    ];
  },
};

// ---------------------------------------------------------------------------
// D1 — rows read/written, storage
// ---------------------------------------------------------------------------

export const D1Pricing: ResourceCost<DatabaseProps> = {
  floorMonthlyUsd: () => 0,
  requiresPaidPlan: false,
  rates: () => [
    {
      label: "D1 rows read",
      perUnit: 0.001,
      unit: "million rows",
      freeIncluded: "25B/mo free",
    },
    {
      label: "D1 rows written",
      perUnit: 1.0,
      unit: "million rows",
      freeIncluded: "50M/mo free",
    },
    {
      label: "D1 storage",
      perUnit: 0.75,
      unit: "GB-month",
      freeIncluded: "5 GB free",
    },
  ],
};

// ---------------------------------------------------------------------------
// Queues — operations (each 64 KB message = 1 operation)
// ---------------------------------------------------------------------------

export const QueuesPricing: ResourceCost<QueueProps> = {
  floorMonthlyUsd: () => 0,
  requiresPaidPlan: false,
  rates: () => [
    {
      label: "Queue operations",
      perUnit: 0.4,
      unit: "million operations",
      freeIncluded: "1M/mo free (64 KB = 1 operation)",
    },
  ],
};

// ---------------------------------------------------------------------------
// Vectorize — queried + stored dimensions
// ---------------------------------------------------------------------------

export const VectorizePricing: ResourceCost<IndexProps> = {
  floorMonthlyUsd: () => 0,
  requiresPaidPlan: false,
  rates: (props) => {
    // Unresolved at plan time reads the same as absent — the generic label.
    const dims = planProp(props, "dimensions").value;
    return [
      {
        label: "Vectorize queried dimensions",
        perUnit: 0.01,
        unit: "million dimensions",
        freeIncluded: "50M/mo free",
      },
      {
        label: dims
          ? `Vectorize stored dimensions (${dims}/vector)`
          : "Vectorize stored dimensions",
        perUnit: 0.05,
        unit: "100 million dimensions",
        freeIncluded: "10M free",
      },
    ];
  },
};

// ---------------------------------------------------------------------------
// Containers — provisioned memory/disk rate by instance type; vCPU is a
// flat usage-metered rate regardless of tier.
// ---------------------------------------------------------------------------

const CONTAINER_PROVISIONED: Record<
  Exclude<ContainerApplication.InstanceType, "dev">,
  { memGiB: number; diskGB: number }
> = {
  lite: { memGiB: 0.25, diskGB: 2 },
  basic: { memGiB: 1, diskGB: 4 },
  "standard-1": { memGiB: 4, diskGB: 8 },
  "standard-2": { memGiB: 6, diskGB: 12 },
  "standard-3": { memGiB: 8, diskGB: 16 },
  "standard-4": { memGiB: 12, diskGB: 20 },
};

const CONTAINER_VCPU_USD_PER_SEC = 0.00002;
const CONTAINER_MEM_USD_PER_GIB_SEC = 0.0000025;
const CONTAINER_DISK_USD_PER_GB_SEC = 0.00000007;

/** Active-hour baseline (memory + disk only — vCPU is metered separately, see {@link rates}) for a given instance type. */
export const containerActiveHourlyUsd = (
  instanceType: ContainerApplication.InstanceType | undefined,
): number => {
  const tier = instanceType === "dev" ? "lite" : (instanceType ?? "lite");
  const provisioned = CONTAINER_PROVISIONED[tier];
  if (!provisioned) return 0;
  return (
    (provisioned.memGiB * CONTAINER_MEM_USD_PER_GIB_SEC +
      provisioned.diskGB * CONTAINER_DISK_USD_PER_GB_SEC) *
    SECONDS_PER_HOUR
  );
};

export const ContainerPricing: ResourceCost<{
  instanceType?: ContainerApplication.InstanceType;
}> = {
  // Scale-to-zero by default — no charge while idle. Anything that keeps a
  // container hot is runtime behavior, never serialized into this
  // resource's props, so it isn't visible here — can't be reflected in a
  // deterministic floor.
  floorMonthlyUsd: () => 0,
  requiresPaidPlan: true,
  rates: (props) => {
    const instanceType = planProp(props, "instanceType");
    const tier = instanceType.value ?? "lite";
    return [
      {
        label: instanceType.unresolved
          ? "Container active time (instance type unresolved at plan time — lite rates shown)"
          : `Container active time (${tier})`,
        perUnit: containerActiveHourlyUsd(instanceType.value),
        unit: "active hour (memory + disk baseline)",
        freeIncluded: "25 GiB-hr memory / 200 GB-hr disk /mo free",
      },
      {
        label: "Container vCPU",
        perUnit: CONTAINER_VCPU_USD_PER_SEC * SECONDS_PER_HOUR,
        unit: "vCPU-hour actually used",
        freeIncluded: "375 vCPU-min/mo free",
      },
    ];
  },
};
