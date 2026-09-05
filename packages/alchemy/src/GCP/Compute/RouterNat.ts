import * as compute from "@distilled.cloud/gcp/compute_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { waitRegionOperations } from "./operations.ts";

const DEFAULT_REGION = "us-central1";
const DEFAULT_NAT_TYPE = "PUBLIC";
const DEFAULT_ALLOCATE_OPTION = "AUTO_ONLY";
const DEFAULT_SOURCE_RANGES = "ALL_SUBNETWORKS_ALL_IP_RANGES";
const MAX_NAME_LENGTH = 63;

export type RouterNatSubnetwork = {
  /** Subnetwork name or URL whose ranges may use this NAT gateway. */
  name: string;
  /**
   * Ranges in the subnetwork to translate.
   * @default ["ALL_IP_RANGES"]
   */
  sourceIpRangesToNat?: ReadonlyArray<compute.RouterNatSubnetworkToNatSourceIpRangesToNatItemEnum>;
  /**
   * Secondary range names to translate. Used when
   * `sourceIpRangesToNat` includes `LIST_OF_SECONDARY_IP_RANGES`.
   */
  secondaryIpRangeNames?: ReadonlyArray<string>;
};

export type RouterNatLogConfig = {
  /** Whether Cloud NAT logging is enabled. */
  enable: boolean;
  /** Log filter applied when logging is enabled. */
  filter?: compute.RouterNatLogConfigFilterEnum;
};

export type RouterNatProps = {
  /**
   * NAT gateway name (RFC1035, 1-63 chars). If omitted, Alchemy generates
   * a stable physical name. Changing it replaces the NAT gateway.
   */
  natName?: string;
  /** Parent Cloud Router name. Changing it replaces the NAT gateway. */
  router: string;
  /**
   * Region shared by the router and NAT gateway. Changing it replaces the
   * NAT gateway.
   * @default "us-central1"
   */
  region?: string;
  /**
   * NAT translation type. This resource currently supports public NAT.
   * @default "PUBLIC"
   */
  type?: "PUBLIC";
  /**
   * How external NAT IPs are allocated. `AUTO_ONLY` lets Google allocate
   * ephemeral addresses; `MANUAL_ONLY` uses `natIps`.
   * @default "AUTO_ONLY"
   */
  natIpAllocateOption?: compute.RouterNatNatIpAllocateOptionEnum;
  /** Static regional Address names or URLs used with `MANUAL_ONLY`. */
  natIps?: ReadonlyArray<string>;
  /**
   * Which subnetworks may use NAT. Select `LIST_OF_SUBNETWORKS` together
   * with `subnetworks` to scope NAT to specific ranges.
   * @default "ALL_SUBNETWORKS_ALL_IP_RANGES"
   */
  sourceSubnetworkIpRangesToNat?: compute.RouterNatSourceSubnetworkIpRangesToNatEnum;
  /** Explicit subnetworks used with `LIST_OF_SUBNETWORKS`. */
  subnetworks?: ReadonlyArray<RouterNatSubnetwork>;
  /** Cloud NAT logging configuration. Logging is disabled when omitted. */
  logConfig?: RouterNatLogConfig;
  /** ICMP idle timeout in seconds. @default 30 */
  icmpIdleTimeoutSec?: number;
  /** UDP idle timeout in seconds. @default 30 */
  udpIdleTimeoutSec?: number;
  /** Established TCP idle timeout in seconds. @default 1200 */
  tcpEstablishedIdleTimeoutSec?: number;
  /** Transitory TCP idle timeout in seconds. @default 30 */
  tcpTransitoryIdleTimeoutSec?: number;
  /** TCP TIME_WAIT timeout in seconds. @default 120 */
  tcpTimeWaitTimeoutSec?: number;
  /** Whether endpoint-independent mapping is enabled. @default false */
  enableEndpointIndependentMapping?: boolean;
  /** Whether dynamic port allocation is enabled. @default false */
  enableDynamicPortAllocation?: boolean;
  /** Minimum ports allocated per VM. */
  minPortsPerVm?: number;
  /** Maximum ports per VM when dynamic allocation is enabled. */
  maxPortsPerVm?: number;
  /** Network tier for automatically allocated NAT addresses. */
  autoNetworkTier?: compute.RouterNatAutoNetworkTierEnum;
  /** Endpoint types whose traffic is translated. */
  endpointTypes?: ReadonlyArray<compute.RouterNatEndpointTypesItemEnum>;
};

type RouterNatAttributes = {
  /** NAT gateway name. */
  natName: string;
  /** Project id. */
  project: string;
  /** Parent Cloud Router name. */
  router: string;
  /** Region short name. */
  region: string;
  /** Observed NAT translation type. */
  type: compute.RouterNatTypeEnum;
  /** NAT address allocation mode. */
  natIpAllocateOption: compute.RouterNatNatIpAllocateOptionEnum;
  /** Static NAT address URLs, if configured. */
  natIps: ReadonlyArray<string>;
  /** Subnetwork selection mode. */
  sourceSubnetworkIpRangesToNat: compute.RouterNatSourceSubnetworkIpRangesToNatEnum;
  /** Explicit subnetworks and ranges, if configured. */
  subnetworks: ReadonlyArray<RouterNatSubnetwork>;
  /** Logging configuration. */
  logConfig: RouterNatLogConfig | undefined;
  /** ICMP idle timeout in seconds. */
  icmpIdleTimeoutSec: number;
  /** UDP idle timeout in seconds. */
  udpIdleTimeoutSec: number;
  /** Established TCP idle timeout in seconds. */
  tcpEstablishedIdleTimeoutSec: number;
  /** Transitory TCP idle timeout in seconds. */
  tcpTransitoryIdleTimeoutSec: number;
  /** TCP TIME_WAIT timeout in seconds. */
  tcpTimeWaitTimeoutSec: number;
  /** Whether endpoint-independent mapping is enabled. */
  enableEndpointIndependentMapping: boolean;
  /** Whether dynamic port allocation is enabled. */
  enableDynamicPortAllocation: boolean;
  /** Minimum ports allocated per VM, if explicitly configured. */
  minPortsPerVm: number | undefined;
  /** Maximum ports allocated per VM, if explicitly configured. */
  maxPortsPerVm: number | undefined;
  /** Network tier for automatically allocated addresses. */
  autoNetworkTier: compute.RouterNatAutoNetworkTierEnum | undefined;
  /** Endpoint types whose traffic is translated. */
  endpointTypes: ReadonlyArray<compute.RouterNatEndpointTypesItemEnum>;
};

export type RouterNat = Resource<
  "GCP.Compute.RouterNat",
  RouterNatProps,
  RouterNatAttributes,
  never,
  Providers
>;

/**
 * A Cloud NAT gateway hosted by a regional Cloud Router.
 *
 * Google represents NAT gateways as entries in a router's `nats` collection.
 * Alchemy exposes each entry as an independent resource and serializes
 * mutations per router so sibling NAT resources are preserved.
 *
 * NAT entries have no labels or description field to carry an ownership
 * marker, so an entry with the same name is adopted and converged in place.
 *
 * ### Creating Public NAT
 * **Example:** Automatically allocated addresses for every subnet
 * ```typescript
 * const router = yield* GCP.Compute.Router("Router", {
 *   network: network.networkName,
 * });
 * const nat = yield* GCP.Compute.RouterNat("Nat", {
 *   router: router.routerName,
 *   region: router.region,
 * });
 * ```
 *
 * ### Selecting Subnetworks
 * **Example:** NAT all ranges in one private subnet
 * ```typescript
 * const nat = yield* GCP.Compute.RouterNat("Nat", {
 *   router: router.routerName,
 *   region: router.region,
 *   natIpAllocateOption: "AUTO_ONLY",
 *   sourceSubnetworkIpRangesToNat: "LIST_OF_SUBNETWORKS",
 *   subnetworks: [{
 *     name: subnet.selfLink,
 *     sourceIpRangesToNat: ["ALL_IP_RANGES"],
 *   }],
 *   logConfig: { enable: false, filter: "ERRORS_ONLY" },
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Compute
 */
export const RouterNat = Resource<RouterNat>("GCP.Compute.RouterNat");

export class RouterNatOperationFailed extends Data.TaggedError(
  "GCP.Compute.RouterNatOperationFailed",
)<{
  operation: string;
  errors: ReadonlyArray<{ code?: string; message?: string }>;
}> {}

export class RouterNatNotResolved extends Data.TaggedError(
  "GCP.Compute.RouterNatNotResolved",
)<{
  natName: string;
  router: string;
  region: string;
}> {}

const routerLocks = new Map<string, Semaphore.Semaphore>();

const lockFor = (project: string, region: string, router: string) => {
  const key = `${project}/${region}/${router}`;
  let lock = routerLocks.get(key);
  if (lock === undefined) {
    lock = Semaphore.makeUnsafe(1);
    routerLocks.set(key, lock);
  }
  return lock;
};

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeRegion = (region: string | undefined) =>
  lastSegment(region ?? DEFAULT_REGION).toLowerCase();

const sameRef = (left: string, right: string) =>
  lastSegment(left).toLowerCase() === lastSegment(right).toLowerCase();

const toNatName = (id: string, name?: string, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_NAME_LENGTH,
      lowercase: true,
    });
    return /^[a-z]/.test(generated)
      ? generated
      : `n${generated}`.slice(0, MAX_NAME_LENGTH);
  });

const subnetworkRef = (project: string, region: string, value: string) => {
  const normalized = value.replace(/^\//, "");
  if (normalized.startsWith("http") || normalized.startsWith("projects/")) {
    return normalized;
  }
  if (normalized.includes("/")) {
    return `projects/${project}/${normalized}`;
  }
  return `projects/${project}/regions/${region}/subnetworks/${normalized}`;
};

const addressRef = (project: string, region: string, value: string) => {
  const normalized = value.replace(/^\//, "");
  if (normalized.startsWith("http") || normalized.startsWith("projects/")) {
    return normalized;
  }
  if (normalized.includes("/")) {
    return `projects/${project}/${normalized}`;
  }
  return `projects/${project}/regions/${region}/addresses/${normalized}`;
};

const desiredNat = (
  project: string,
  region: string,
  natName: string,
  props: RouterNatProps,
): compute.RouterNat => ({
  name: natName,
  type: props.type ?? DEFAULT_NAT_TYPE,
  natIpAllocateOption: props.natIpAllocateOption ?? DEFAULT_ALLOCATE_OPTION,
  natIps: (props.natIps ?? []).map((ip) => addressRef(project, region, ip)),
  sourceSubnetworkIpRangesToNat:
    props.sourceSubnetworkIpRangesToNat ?? DEFAULT_SOURCE_RANGES,
  subnetworks: (props.subnetworks ?? []).map((subnet) => ({
    name: subnetworkRef(project, region, subnet.name),
    sourceIpRangesToNat: [...(subnet.sourceIpRangesToNat ?? ["ALL_IP_RANGES"])],
    secondaryIpRangeNames: [...(subnet.secondaryIpRangeNames ?? [])],
  })),
  logConfig: props.logConfig && {
    enable: props.logConfig.enable,
    filter: props.logConfig.filter,
  },
  icmpIdleTimeoutSec: props.icmpIdleTimeoutSec ?? 30,
  udpIdleTimeoutSec: props.udpIdleTimeoutSec ?? 30,
  tcpEstablishedIdleTimeoutSec: props.tcpEstablishedIdleTimeoutSec ?? 1200,
  tcpTransitoryIdleTimeoutSec: props.tcpTransitoryIdleTimeoutSec ?? 30,
  tcpTimeWaitTimeoutSec: props.tcpTimeWaitTimeoutSec ?? 120,
  enableEndpointIndependentMapping:
    props.enableEndpointIndependentMapping ?? false,
  enableDynamicPortAllocation: props.enableDynamicPortAllocation ?? false,
  minPortsPerVm:
    props.minPortsPerVm ??
    (props.enableDynamicPortAllocation === true ? 32 : 64),
  maxPortsPerVm:
    props.maxPortsPerVm ??
    (props.enableDynamicPortAllocation === true ? 65536 : undefined),
  autoNetworkTier: props.autoNetworkTier,
  endpointTypes: [...(props.endpointTypes ?? ["ENDPOINT_TYPE_VM"])],
});

const stringListKey = (values: ReadonlyArray<string> | undefined) =>
  [...(values ?? [])].map(lastSegment).sort().join("\0");

const enumListKey = (values: ReadonlyArray<string> | undefined) =>
  [...(values ?? [])].sort().join("\0");

const subnetworksKey = (
  subnetworks: ReadonlyArray<compute.RouterNatSubnetworkToNat> | undefined,
) =>
  JSON.stringify(
    [...(subnetworks ?? [])]
      .map((subnet) => ({
        name: lastSegment(subnet.name ?? ""),
        sourceIpRangesToNat: enumListKey(
          subnet.sourceIpRangesToNat ?? ["ALL_IP_RANGES"],
        ),
        secondaryIpRangeNames: enumListKey(subnet.secondaryIpRangeNames),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  );

const natMatches = (observed: compute.RouterNat, desired: compute.RouterNat) =>
  observed.name === desired.name &&
  (observed.type ?? DEFAULT_NAT_TYPE) === desired.type &&
  (observed.natIpAllocateOption ?? DEFAULT_ALLOCATE_OPTION) ===
    desired.natIpAllocateOption &&
  stringListKey(observed.natIps) === stringListKey(desired.natIps) &&
  (observed.sourceSubnetworkIpRangesToNat ?? DEFAULT_SOURCE_RANGES) ===
    desired.sourceSubnetworkIpRangesToNat &&
  subnetworksKey(observed.subnetworks) ===
    subnetworksKey(desired.subnetworks) &&
  (observed.logConfig?.enable === true) ===
    (desired.logConfig?.enable === true) &&
  (observed.logConfig?.filter ?? "ALL") ===
    (desired.logConfig?.filter ?? "ALL") &&
  (observed.icmpIdleTimeoutSec ?? 30) === desired.icmpIdleTimeoutSec &&
  (observed.udpIdleTimeoutSec ?? 30) === desired.udpIdleTimeoutSec &&
  (observed.tcpEstablishedIdleTimeoutSec ?? 1200) ===
    desired.tcpEstablishedIdleTimeoutSec &&
  (observed.tcpTransitoryIdleTimeoutSec ?? 30) ===
    desired.tcpTransitoryIdleTimeoutSec &&
  (observed.tcpTimeWaitTimeoutSec ?? 120) === desired.tcpTimeWaitTimeoutSec &&
  (observed.enableEndpointIndependentMapping === true) ===
    (desired.enableEndpointIndependentMapping === true) &&
  (observed.enableDynamicPortAllocation === true) ===
    (desired.enableDynamicPortAllocation === true) &&
  (observed.minPortsPerVm ??
    (desired.enableDynamicPortAllocation === true ? 32 : 64)) ===
    desired.minPortsPerVm &&
  (observed.maxPortsPerVm ??
    (desired.enableDynamicPortAllocation === true ? 65536 : undefined)) ===
    desired.maxPortsPerVm &&
  observed.autoNetworkTier === desired.autoNetworkTier &&
  enumListKey(observed.endpointTypes ?? ["ENDPOINT_TYPE_VM"]) ===
    enumListKey(desired.endpointTypes);

const findNat = (router: compute.Router, natName: string) =>
  (router.nats ?? []).find((nat) => nat.name === natName);

const getRouter = (project: string, region: string, router: string) =>
  compute
    .getRouters({ project, region, router })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const getNat = (
  project: string,
  region: string,
  router: string,
  natName: string,
) =>
  getRouter(project, region, router).pipe(
    Effect.map((current) =>
      current === undefined ? undefined : findNat(current, natName),
    ),
  );

const operationErrors = (operation: compute.Operation) =>
  (operation.error?.errors ?? []).map((error) => ({
    code: error.code,
    message: error.message,
  }));

const waitForOperation = (
  project: string,
  region: string,
  operation: compute.Operation,
) =>
  Effect.gen(function* () {
    const name = lastSegment(operation.name ?? "");
    if (name === "" && operation.status !== "DONE") {
      return yield* new RouterNatOperationFailed({
        operation: "",
        errors: [{ message: "compute operation is missing a name" }],
      });
    }
    const completed =
      operation.status === "DONE"
        ? operation
        : yield* waitRegionOperations(
            { project, region, operation: name },
            { times: 10 },
          );
    const errors = operationErrors(completed);
    if (errors.length > 0) {
      return yield* new RouterNatOperationFailed({ operation: name, errors });
    }
  });

const mutateNats = <A>(
  project: string,
  region: string,
  router: string,
  mutate: (
    nats: ReadonlyArray<compute.RouterNat>,
  ) => { nats: ReadonlyArray<compute.RouterNat>; value: A } | undefined,
) =>
  lockFor(project, region, router).withPermit(
    Effect.gen(function* () {
      const current = yield* getRouter(project, region, router);
      if (current === undefined) return undefined;
      const mutation = mutate(current.nats ?? []);
      if (mutation === undefined) return undefined;
      const operation = yield* compute.patchRouters({
        project,
        region,
        router,
        body: { nats: [...mutation.nats] },
      });
      yield* waitForOperation(project, region, operation);
      return mutation.value;
    }).pipe(
      Effect.retry({
        while: (error) => error._tag === "Conflict",
        times: 5,
        schedule: Schedule.spaced("1 second"),
      }),
    ),
  );

const toAttrs = (
  nat: compute.RouterNat,
  project: string,
  region: string,
  router: string,
): RouterNatAttributes => ({
  natName: nat.name ?? "",
  project,
  router,
  region,
  type: (nat.type ?? DEFAULT_NAT_TYPE) as compute.RouterNatTypeEnum,
  natIpAllocateOption: (nat.natIpAllocateOption ??
    DEFAULT_ALLOCATE_OPTION) as compute.RouterNatNatIpAllocateOptionEnum,
  natIps: nat.natIps ?? [],
  sourceSubnetworkIpRangesToNat: (nat.sourceSubnetworkIpRangesToNat ??
    DEFAULT_SOURCE_RANGES) as compute.RouterNatSourceSubnetworkIpRangesToNatEnum,
  subnetworks: (nat.subnetworks ?? []).map((subnet) => ({
    name: subnet.name ?? "",
    sourceIpRangesToNat: subnet.sourceIpRangesToNat as
      | ReadonlyArray<compute.RouterNatSubnetworkToNatSourceIpRangesToNatItemEnum>
      | undefined,
    secondaryIpRangeNames: subnet.secondaryIpRangeNames,
  })),
  logConfig: nat.logConfig
    ? {
        enable: nat.logConfig.enable === true,
        filter: nat.logConfig.filter as
          | compute.RouterNatLogConfigFilterEnum
          | undefined,
      }
    : undefined,
  icmpIdleTimeoutSec: nat.icmpIdleTimeoutSec ?? 30,
  udpIdleTimeoutSec: nat.udpIdleTimeoutSec ?? 30,
  tcpEstablishedIdleTimeoutSec: nat.tcpEstablishedIdleTimeoutSec ?? 1200,
  tcpTransitoryIdleTimeoutSec: nat.tcpTransitoryIdleTimeoutSec ?? 30,
  tcpTimeWaitTimeoutSec: nat.tcpTimeWaitTimeoutSec ?? 120,
  enableEndpointIndependentMapping:
    nat.enableEndpointIndependentMapping === true,
  enableDynamicPortAllocation: nat.enableDynamicPortAllocation === true,
  minPortsPerVm:
    nat.minPortsPerVm ?? (nat.enableDynamicPortAllocation === true ? 32 : 64),
  maxPortsPerVm: nat.maxPortsPerVm,
  autoNetworkTier: nat.autoNetworkTier as
    | compute.RouterNatAutoNetworkTierEnum
    | undefined,
  endpointTypes: (nat.endpointTypes ??
    []) as ReadonlyArray<compute.RouterNatEndpointTypesItemEnum>,
});

export const RouterNatProvider = () =>
  Provider.succeed(RouterNat, {
    stables: ["natName", "project", "router", "region"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName = olds?.natName ?? output?.natName;
      const nextName = news.natName ?? previousName;
      const replace =
        (previousName !== undefined && nextName !== previousName) ||
        !sameRef(news.router, olds?.router ?? output?.router ?? news.router) ||
        normalizeRegion(news.region) !==
          normalizeRegion(olds?.region ?? output?.region);
      return replace
        ? { action: "replace" as const, deleteFirst: true }
        : undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const natName = yield* toNatName(id, olds?.natName, output?.natName);
      const routerRef = olds?.router ?? output?.router ?? "";
      const router = lastSegment(routerRef);
      if (router === "") return undefined;
      const region = normalizeRegion(olds?.region ?? output?.region);
      const existing = yield* getNat(env.project, region, router, natName);
      if (existing === undefined) return undefined;
      return toAttrs(existing, env.project, region, router);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const natName = yield* toNatName(id, news.natName, output?.natName);
      const router = lastSegment(news.router);
      const region = normalizeRegion(news.region ?? output?.region);
      const desired = desiredNat(env.project, region, natName, news);

      let matched: compute.RouterNat | undefined;
      const patched = yield* mutateNats(env.project, region, router, (nats) => {
        const existing = nats.find((nat) => nat.name === natName);
        if (existing !== undefined && natMatches(existing, desired)) {
          matched = existing;
          return undefined;
        }
        return {
          nats: [...nats.filter((nat) => nat.name !== natName), desired],
          value: true,
        };
      });

      const resolved = patched
        ? yield* getNat(env.project, region, router, natName)
        : matched;

      if (resolved === undefined) {
        return yield* new RouterNatNotResolved({ natName, router, region });
      }
      return toAttrs(resolved, env.project, region, router);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const project = output.project ?? env.project;
      yield* mutateNats(project, output.region, output.router, (nats) => {
        if (!nats.some((nat) => nat.name === output.natName)) return undefined;
        return {
          nats: nats.filter((nat) => nat.name !== output.natName),
          value: true,
        };
      });
    }),
  });
