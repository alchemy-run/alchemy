import * as compute from "@distilled.cloud/gcp/compute_v1";
import { waitRegionOperations } from "./operations.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const DEFAULT_REGION = "us-central1";
const DEFAULT_ADVERTISE_MODE = "DEFAULT";
const DEFAULT_KEEPALIVE = 20;
const MAX_NAME_LENGTH = 63;

const OWNERSHIP_KEYS = [
  "alchemy-stack",
  "alchemy-stage",
  "alchemy-id",
] as const;

export type RouterAdvertisedIpRange = {
  /** CIDR to advertise (for example `10.0.0.0/8`). */
  range: string;
  /** Optional description of this advertised range. */
  description?: string;
};

export type RouterBgp = {
  /**
   * Local BGP ASN. Must be an RFC6996 private ASN (16-bit or 32-bit).
   * Shared by every VPN tunnel attached to this router.
   */
  asn: number;
  /**
   * Advertisement mode. `CUSTOM` requires `advertisedGroups` and/or
   * `advertisedIpRanges`.
   * @default "DEFAULT"
   */
  advertiseMode?: compute.RouterBgpAdvertiseModeEnum;
  /**
   * Prefix groups to advertise when `advertiseMode` is `CUSTOM`. The only
   * valid value today is `ALL_SUBNETS`.
   */
  advertisedGroups?: string[];
  /**
   * Individual CIDRs to advertise when `advertiseMode` is `CUSTOM`.
   */
  advertisedIpRanges?: RouterAdvertisedIpRange[];
  /**
   * Seconds between BGP keepalives (20–60). Hold time is 3× this value.
   * @default 20
   */
  keepaliveInterval?: number;
  /**
   * Link-local IPv4 `/30` or larger from `169.254.0.0/16` used as the BGP
   * identifier (router ID).
   */
  identifierRange?: string;
};

export type RouterProps = {
  /**
   * Router name (RFC1035, 1-63 chars). If omitted, a unique name is
   * generated from the stack, stage, and logical id. Immutable — changing
   * it replaces the router.
   */
  routerName?: string;
  /**
   * Region the router lives in. Immutable — changing it replaces the
   * router. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default "us-central1"
   */
  region?: string;
  /**
   * VPC network this router belongs to. Accepts a name (`default`), a
   * partial URL (`global/networks/default`), or a full resource URL.
   * Immutable — changing it replaces the router.
   */
  network: string;
  /**
   * Optional description. Compute Router has no `labels` field, so Alchemy
   * ownership (`alchemy-stack` / `alchemy-stage` / `alchemy-id`) is stored
   * in the description for `list` / nuke.
   */
  description?: string;
  /**
   * BGP configuration. Omit when the router is NAT-only.
   */
  bgp?: RouterBgp;
  /**
   * Dedicated for encrypted VLAN attachments. Immutable — changing it
   * replaces the router.
   * @default false
   */
  encryptedInterconnectRouter?: boolean;
  /**
   * NCC Gateway spoke URI. Immutable — changing it replaces the router.
   * Mutually exclusive with `network` at the API.
   */
  nccGateway?: string;
};

export type Router = Resource<
  "GCP.Compute.Router",
  RouterProps,
  {
    /** RFC1035 router name. */
    routerName: string;
    /** Project id. */
    project: string;
    /** Region short name (`us-central1`). */
    region: string;
    /** Parent VPC network URL. */
    network: string;
    /** User description (Alchemy ownership marker stripped). */
    description: string | undefined;
    /** BGP configuration, if set. */
    bgp: RouterBgp | undefined;
    /** Whether this router is dedicated to encrypted interconnect. */
    encryptedInterconnectRouter: boolean;
    /** NCC Gateway spoke URI, if any. */
    nccGateway: string | undefined;
    /** Server-defined resource URL. */
    selfLink: string | undefined;
    /** Server-assigned numeric id. */
    routerId: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
  },
  never,
  Providers
>;

/**
 * A regional Cloud Router.
 *
 * Cloud Routers advertise VPC routes over BGP to VPN tunnels and
 * interconnects, and they host Cloud NAT. Compute Router has no `labels`
 * field — Alchemy stamps `alchemy-stack` / `alchemy-stage` / `alchemy-id`
 * into the description so `list` and `pnpm nuke:gcp` can find owned
 * routers.
 *
 * Name, region, network, `encryptedInterconnectRouter`, and `nccGateway`
 * are immutable. Description and BGP (ASN, advertise mode, advertised
 * ranges, keepalive) update in place via `routers.patch`.
 *
 * ### Creating a Router
 * **Example:** Generated name on a custom-mode VPC
 * ```typescript
 * const network = yield* GCP.Compute.Network("Vpc", {
 *   autoCreateSubnetworks: false,
 * });
 * const router = yield* GCP.Compute.Router("Edge", {
 *   network: network.networkName,
 * });
 * ```
 *
 * **Example:** Named router with BGP
 * ```typescript
 * const router = yield* GCP.Compute.Router("Edge", {
 *   routerName: "app-router",
 *   region: "us-central1",
 *   network: "app-vpc",
 *   description: "edge bgp",
 *   bgp: { asn: 65001, advertiseMode: "DEFAULT" },
 * });
 * ```
 *
 * ### Custom advertisements
 * **Example:** Advertise all subnets plus a CIDR
 * ```typescript
 * const router = yield* GCP.Compute.Router("Edge", {
 *   network: network.networkName,
 *   bgp: {
 *     asn: 65001,
 *     advertiseMode: "CUSTOM",
 *     advertisedGroups: ["ALL_SUBNETS"],
 *     advertisedIpRanges: [
 *       { range: "10.0.0.0/8", description: "rfc1918" },
 *     ],
 *   },
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Compute
 */
export const Router = Resource<Router>("GCP.Compute.Router");

export class RouterNotResolved extends Data.TaggedError(
  "GCP.Compute.RouterNotResolved",
)<{
  routerName: string;
  region: string;
}> {}

export class RouterOperationFailed extends Data.TaggedError(
  "GCP.Compute.RouterOperationFailed",
)<{
  operation: string;
  errors: ReadonlyArray<{ code?: string; message?: string }>;
}> {}

export class RouterOperationPending extends Data.TaggedError(
  "GCP.Compute.RouterOperationPending",
)<{
  operation: string;
  status: string | undefined;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeRegion = (region: string | undefined) =>
  lastSegment(region ?? DEFAULT_REGION).toLowerCase();

const linkKey = (value: string | undefined) =>
  value === undefined || value === "" ? "" : lastSegment(value).toLowerCase();

const networkRef = (project: string, network: string) => {
  if (network.includes("/")) {
    return network.startsWith("projects/") || network.startsWith("http")
      ? network
      : `projects/${project}/${network.replace(/^\//, "")}`;
  }
  return `projects/${project}/global/networks/${network}`;
};

const encodeDescription = (
  internal: Record<string, string>,
  user?: string,
): string => {
  const marker = OWNERSHIP_KEYS.map(
    (key) => `${key}=${internal[key] ?? ""}`,
  ).join(" ");
  return user && user.length > 0 ? `${marker}\n${user}` : marker;
};

const parseDescription = (description: string | undefined) => {
  if (!description) {
    return { labels: {} as Record<string, string>, description: undefined };
  }
  const newline = description.indexOf("\n");
  const first = newline === -1 ? description : description.slice(0, newline);
  const rest = newline === -1 ? undefined : description.slice(newline + 1);
  if (!first.includes("alchemy-id=") || !first.includes("alchemy-stack=")) {
    return { labels: {} as Record<string, string>, description };
  }
  const labels: Record<string, string> = {};
  for (const part of first.split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  return {
    labels,
    description: rest && rest.length > 0 ? rest : undefined,
  };
};

const hasAlchemyMarker = (description: string | undefined) =>
  Object.keys(parseDescription(description).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const toRouterName = (
  id: string,
  name: string | undefined,
  existing?: string,
) =>
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
      : `r${generated}`.slice(0, MAX_NAME_LENGTH);
  });

const groupsKey = (groups: ReadonlyArray<string> | undefined) =>
  [...(groups ?? [])]
    .map((group) => group.toUpperCase())
    .sort()
    .join("\0");

const rangesKey = (
  ranges: ReadonlyArray<RouterAdvertisedIpRange> | undefined,
) =>
  JSON.stringify(
    [...(ranges ?? [])]
      .map((range) => ({
        range: range.range,
        description: range.description ?? "",
      }))
      .sort((a, b) => a.range.localeCompare(b.range)),
  );

const toAdvertiseMode = (
  value: string | undefined,
): compute.RouterBgpAdvertiseModeEnum | undefined => {
  switch (value) {
    case "CUSTOM":
    case "DEFAULT":
      return value;
    default:
      return undefined;
  }
};

const toBgp = (bgp: compute.RouterBgp | undefined): RouterBgp | undefined => {
  if (bgp === undefined || bgp.asn === undefined) return undefined;
  return {
    asn: bgp.asn,
    advertiseMode: toAdvertiseMode(bgp.advertiseMode),
    advertisedGroups: bgp.advertisedGroups,
    advertisedIpRanges: (bgp.advertisedIpRanges ?? [])
      .filter(
        (range): range is compute.RouterAdvertisedIpRange & { range: string } =>
          typeof range.range === "string" && range.range.length > 0,
      )
      .map((range) => ({
        range: range.range,
        description: range.description,
      })),
    keepaliveInterval: bgp.keepaliveInterval,
    identifierRange: bgp.identifierRange,
  };
};

const desiredBgp = (bgp: RouterBgp): compute.RouterBgp => {
  const advertiseMode = bgp.advertiseMode ?? DEFAULT_ADVERTISE_MODE;
  const body: compute.RouterBgp = {
    asn: bgp.asn,
    advertiseMode,
    keepaliveInterval: bgp.keepaliveInterval ?? DEFAULT_KEEPALIVE,
  };
  if (advertiseMode === "CUSTOM") {
    body.advertisedGroups = bgp.advertisedGroups ?? [];
    body.advertisedIpRanges = (bgp.advertisedIpRanges ?? []).map((range) => ({
      range: range.range,
      description: range.description,
    }));
  }
  if (bgp.identifierRange !== undefined) {
    body.identifierRange = bgp.identifierRange;
  }
  return body;
};

const bgpEqual = (observed: RouterBgp | undefined, desired: RouterBgp) => {
  if (observed === undefined) return false;
  const advertiseMode = desired.advertiseMode ?? DEFAULT_ADVERTISE_MODE;
  if (observed.asn !== desired.asn) return false;
  if ((observed.advertiseMode ?? DEFAULT_ADVERTISE_MODE) !== advertiseMode) {
    return false;
  }
  if (
    (observed.keepaliveInterval ?? DEFAULT_KEEPALIVE) !==
    (desired.keepaliveInterval ?? DEFAULT_KEEPALIVE)
  ) {
    return false;
  }
  if (
    desired.identifierRange !== undefined &&
    observed.identifierRange !== desired.identifierRange
  ) {
    return false;
  }
  if (advertiseMode !== "CUSTOM") return true;
  return (
    groupsKey(observed.advertisedGroups) ===
      groupsKey(desired.advertisedGroups) &&
    rangesKey(observed.advertisedIpRanges) ===
      rangesKey(desired.advertisedIpRanges)
  );
};

const toAttrs = (
  router: compute.Router,
  project: string,
): Router["Attributes"] => {
  const parsed = parseDescription(router.description);
  return {
    routerName: router.name ?? "",
    project,
    region: normalizeRegion(router.region),
    network: router.network ?? "",
    description: parsed.description,
    bgp: toBgp(router.bgp),
    encryptedInterconnectRouter: router.encryptedInterconnectRouter === true,
    nccGateway: router.nccGateway,
    selfLink: router.selfLink,
    routerId: router.id,
    creationTimestamp: router.creationTimestamp,
  };
};

const getByName = (project: string, region: string, router: string) =>
  compute
    .getRouters({ project, region, router })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const operationErrors = (operation: compute.Operation) =>
  (operation.error?.errors ?? []).map((error) => ({
    code: error.code,
    message: error.message,
  }));

const operationText = (
  errors: ReadonlyArray<{ code?: string; message?: string }>,
) =>
  errors
    .map((error) => `${error.code ?? ""} ${error.message ?? ""}`.toLowerCase())
    .join(" ");

const isNotFoundOp = (
  errors: ReadonlyArray<{ code?: string; message?: string }>,
) => {
  const text = operationText(errors);
  return (
    errors.length > 0 &&
    (text.includes("not_found") ||
      text.includes("notfound") ||
      text.includes("was not found") ||
      text.includes("not found"))
  );
};

const isAlreadyExistsOp = (
  errors: ReadonlyArray<{ code?: string; message?: string }>,
) => {
  const text = operationText(errors);
  return text.includes("already_exists") || text.includes("already exists");
};

const isInUseOp = (
  errors: ReadonlyArray<{ code?: string; message?: string }>,
) => {
  const text = operationText(errors);
  return text.includes("resource_in_use") || text.includes("in use");
};

const assertOperationOk = (
  operation: compute.Operation,
  options?: { allowMissing?: boolean; allowExists?: boolean },
) => {
  const errors = operationErrors(operation);
  if (errors.length === 0) return Effect.void;
  if (options?.allowMissing === true && isNotFoundOp(errors)) {
    return Effect.void;
  }
  if (options?.allowExists === true && isAlreadyExistsOp(errors)) {
    return Effect.void;
  }
  return Effect.fail(
    new RouterOperationFailed({
      operation: operation.name ?? "",
      errors,
    }),
  );
};

const operationId = (operation: compute.Operation) => {
  const name = operation.name ?? "";
  return name.split("/").pop() ?? name;
};

const waitForRegionOperation = (
  project: string,
  region: string,
  operation: compute.Operation,
  options?: { allowMissing?: boolean; allowExists?: boolean },
) =>
  Effect.gen(function* () {
    const name = operationId(operation);
    if (!name) {
      if (operation.status === "DONE") {
        yield* assertOperationOk(operation, options);
        return;
      }
      return yield* new RouterOperationFailed({
        operation: "",
        errors: [{ message: "compute operation is missing a name" }],
      });
    }
    if (operation.status === "DONE") {
      yield* assertOperationOk(operation, options);
      return;
    }
    const waited = yield* waitRegionOperations(
      {
        project,
        region,
        operation: name,
      },
      { times: 30 },
    );
    if (waited.status === "DONE") {
      yield* assertOperationOk(waited, options);
      return;
    }
    yield* compute
      .getRegionOperations({ project, region, operation: name })
      .pipe(
        Effect.filterOrFail(
          (current) => current.status === "DONE",
          (current) =>
            new RouterOperationPending({
              operation: name,
              status: current.status,
            }),
        ),
        Effect.flatMap((current) => assertOperationOk(current, options)),
        Effect.retry({
          while: (error) =>
            error._tag === "GCP.Compute.RouterOperationPending" ||
            error._tag === "NotFound",
          schedule: Schedule.spaced("2 seconds"),
          times: 10,
        }),
      );
  });

const requireRouter = (project: string, region: string, routerName: string) =>
  getByName(project, region, routerName).pipe(
    Effect.flatMap((router) =>
      router
        ? Effect.succeed(router)
        : Effect.fail(new RouterNotResolved({ routerName, region })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.RouterNotResolved",
      schedule: Schedule.spaced("1 second"),
      times: 8,
    }),
  );

const waitUntilRouterGone = (
  project: string,
  region: string,
  routerName: string,
) =>
  getByName(project, region, routerName).pipe(
    Effect.flatMap((router) =>
      router === undefined
        ? Effect.void
        : Effect.fail(
            new RouterOperationPending({
              operation: `delete:${routerName}`,
              status: "EXISTS",
            }),
          ),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Compute.RouterOperationPending",
      schedule: Schedule.spaced("2 seconds"),
      times: 20,
    }),
  );

export const RouterProvider = () =>
  Provider.succeed(Router, {
    nuke: {
      dependsOn: ["GCP.Compute.Network"],
    },
    stables: [
      "routerName",
      "project",
      "region",
      "network",
      "encryptedInterconnectRouter",
      "nccGateway",
      "routerId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName = olds?.routerName ?? output?.routerName;
      const nextName = news.routerName ?? previousName;
      const previousRegion = normalizeRegion(olds?.region ?? output?.region);
      const nextRegion = normalizeRegion(news.region ?? output?.region);
      const identityChanged =
        previousRegion !== nextRegion ||
        (previousName !== undefined &&
          nextName !== undefined &&
          previousName !== nextName);
      const previousEncrypted =
        olds?.encryptedInterconnectRouter ??
        output?.encryptedInterconnectRouter ??
        false;
      const nextEncrypted = news.encryptedInterconnectRouter ?? false;
      const previousAsn = olds?.bgp?.asn ?? output?.bgp?.asn;
      const nextAsn = news.bgp?.asn;
      const replace =
        identityChanged ||
        linkKey(news.network) !== linkKey(olds?.network ?? output?.network) ||
        previousEncrypted !== nextEncrypted ||
        (previousAsn !== undefined &&
          nextAsn !== undefined &&
          previousAsn !== nextAsn) ||
        (news.nccGateway !== undefined &&
          linkKey(news.nccGateway) !==
            linkKey(olds?.nccGateway ?? output?.nccGateway));
      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          !identityChanged &&
          nextName !== undefined &&
          previousName !== undefined &&
          nextName === previousName,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const routerName = yield* toRouterName(
        id,
        olds?.routerName,
        output?.routerName,
      );
      const region = normalizeRegion(olds?.region ?? output?.region);
      const existing = yield* getByName(env.project, region, routerName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const parsed = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, parsed.labels))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const found: Router["Attributes"][] = [];
        let pageToken: string | undefined;
        for (let page = 0; page < 10; page++) {
          const response = yield* compute.aggregatedListRouters({
            project: env.project,
            returnPartialSuccess: true,
            maxResults: 500,
            pageToken,
          });
          for (const scoped of Object.values(response.items ?? {})) {
            for (const item of scoped?.routers ?? []) {
              if (!hasAlchemyMarker(item.description)) continue;
              found.push(toAttrs(item, env.project));
            }
          }
          pageToken = response.nextPageToken;
          if (pageToken === undefined || pageToken === "") break;
        }
        return found;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const routerName = yield* toRouterName(
        id,
        news.routerName,
        output?.routerName,
      );
      const region = normalizeRegion(news.region ?? output?.region);
      const network = networkRef(env.project, news.network);
      const internal = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(internal, news.description);
      const encrypted = news.encryptedInterconnectRouter === true;

      let current = yield* getByName(env.project, region, routerName);

      if (current === undefined) {
        const body: compute.Router = {
          name: routerName,
          network,
          description: desiredDescription,
        };
        if (news.bgp !== undefined) {
          body.bgp = desiredBgp(news.bgp);
        }
        if (encrypted) {
          body.encryptedInterconnectRouter = true;
        }
        if (news.nccGateway !== undefined) {
          body.nccGateway = news.nccGateway;
        }
        yield* compute
          .insertRouters({
            project: env.project,
            region,
            body,
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitForRegionOperation(env.project, region, operation, {
                allowExists: true,
              }),
            ),
            Effect.catchTag("Conflict", () => Effect.void),
          );
        current = yield* requireRouter(env.project, region, routerName);
      }

      const patchBody: compute.Router = {};
      if ((current.description ?? "") !== desiredDescription) {
        patchBody.description = desiredDescription;
      }
      if (news.bgp !== undefined && !bgpEqual(toBgp(current.bgp), news.bgp)) {
        patchBody.bgp = desiredBgp(news.bgp);
      }
      if (Object.keys(patchBody).length > 0) {
        const patched = yield* compute.patchRouters({
          project: env.project,
          region,
          router: routerName,
          body: patchBody,
        });
        yield* waitForRegionOperation(env.project, region, patched);
        current = yield* requireRouter(env.project, region, routerName);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const project = output.project || env.project;
      const region = normalizeRegion(output.region);
      const routerName = output.routerName;
      if (!routerName) return;
      yield* compute
        .deleteRouters({
          project,
          region,
          router: routerName,
        })
        .pipe(
          Effect.retry({
            while: (error) =>
              error._tag === "Conflict" || error._tag === "BadRequest",
            times: 15,
            schedule: Schedule.spaced("3 seconds"),
          }),
          Effect.flatMap((operation) =>
            waitForRegionOperation(project, region, operation, {
              allowMissing: true,
            }),
          ),
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.retry({
            while: (error) =>
              error._tag === "GCP.Compute.OperationPending" ||
              error._tag === "GCP.Compute.RouterOperationPending" ||
              (error._tag === "GCP.Compute.RouterOperationFailed" &&
                isInUseOp(error.errors)),
            times: 10,
            schedule: Schedule.spaced("3 seconds"),
          }),
        );
      yield* waitUntilRouterGone(project, region, routerName);
    }),
  });
