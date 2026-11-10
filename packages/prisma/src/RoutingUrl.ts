import type { Conflict, UnprocessableEntity } from "@distilled.cloud/prisma";
import {
  type GetUrlResponseData,
  createServiceUrl,
  deleteUrl,
  getProject,
  getProjectBranchUrls,
  getService,
  getUrl,
  getWorkspaceDomainOwnerships,
  getWorkspaceDomainOwnershipsVerification,
  updateUrl,
} from "@distilled.cloud/prisma/management";
import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { App } from "./App.ts";
import type { Compute } from "./Compute.ts";
import { AuthoritativeRecordCheck } from "./internal/AuthoritativeDns.ts";
import { attrOrString, devId, devProvider } from "./internal/DevStub.ts";
import { concreteIdOf, isPrismaDevId } from "./internal/Refs.ts";
import { switchboardTarget } from "./internal/Switchboard.ts";
import type { Providers } from "./Providers.ts";

/** The service already serves as many hostnames as Prisma allows. */
export class RoutingUrlQuotaExceeded extends Data.TaggedError("RoutingUrlQuotaExceeded")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Another RoutingUrl on the Branch has the same `logicalId`. */
export class RoutingUrlLogicalIdTaken extends Data.TaggedError("RoutingUrlLogicalIdTaken")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Another RoutingUrl on the Branch has the hostname. */
export class RoutingUrlHostnameTaken extends Data.TaggedError("RoutingUrlHostnameTaken")<{
  readonly message: string;
  /** The RoutingUrl that has the hostname. */
  readonly routingUrlId: string;
}> {}

/** Prisma refused the hostname, e.g. a wildcard or an IP address. */
export class RoutingUrlInvalidHostname extends Data.TaggedError("RoutingUrlInvalidHostname")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** The service is not on the RoutingUrl's Branch, or on no Branch. */
export class RoutingUrlServiceOnAnotherBranch extends Data.TaggedError(
  "RoutingUrlServiceOnAnotherBranch",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * A serving RoutingUrl's hostname change was refused before anything changed,
 * because the new hostname could not serve yet. Publish `records`, then
 * redeploy.
 */
export class RoutingUrlHostnameChangeRefused extends Data.TaggedError(
  "RoutingUrlHostnameChangeRefused",
)<{
  readonly message: string;
  readonly from: string;
  readonly to: string;
  readonly records: ReadonlyArray<{
    readonly type: "TXT" | "CNAME";
    readonly name: string;
    readonly value: string;
  }>;
}> {}

export class RoutingUrlOperationFailed extends Data.TaggedError("RoutingUrlOperationFailed")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

type AppReference = string | App | Compute;

type ApiRoutingUrl = GetUrlResponseData;

export interface RoutingUrlProps {
  /**
   * App ID or Compute output whose service the hostname serves.
   */
  app: AppReference;
  /**
   * Hostname to serve, such as `api.example.com`. Case and a trailing dot are
   * ignored.
   */
  hostname: string;
  /**
   * Identity of the RoutingUrl on its Branch. A RoutingUrl found on the
   * Branch with this `logicalId` is this resource's.
   * @default the resource's fully qualified name
   */
  logicalId?: string;
}

export interface RoutingUrl extends Resource<
  "Prisma.RoutingUrl",
  RoutingUrlProps,
  {
    /** Prisma RoutingUrl ID. */
    routingUrlId: string;
    /** Branch the RoutingUrl belongs to. */
    branchId: string;
    /** Service the hostname serves; null once the service is deleted. */
    serviceId: string | null;
    /** Hostname the RoutingUrl serves. */
    hostname: string;
    /** Identity of the RoutingUrl on its Branch. */
    logicalId: string | null;
    /** `pending` until every condition is met, then `active`. As last read. */
    status: ApiRoutingUrl["status"];
    /** What the hostname needs to serve, each `met`, `unmet` or `unknown`. As last read. */
    conditions: ApiRoutingUrl["conditions"];
    /** The first condition not met, or null when all are. */
    firstUnmetCondition: ApiRoutingUrl["firstUnmetCondition"];
    /** The DNS records still to publish: a TXT for ownership, a CNAME to the switchboard. */
    records: ApiRoutingUrl["records"];
    /** Set while only an `expiring` domain ownership keeps the hostname serving. */
    ownershipExpiry: ApiRoutingUrl["ownershipExpiry"];
    /** Set when a RoutingUrl elsewhere holds the hostname. */
    heldBy: ApiRoutingUrl["heldBy"];
    /** The error from Prisma's last sync with its custom domain, if any. */
    customDomainSyncError: string | null;
    /** The Console page that shows what to do next, while pending. */
    setupUrl: string | null;
  },
  never,
  Providers
> {}

/**
 * A hostname that serves a Prisma app, saved before its DNS exists.
 *
 * Creating it needs no DNS: the deploy succeeds at once and reports, in
 * `records`, the `TXT` record that proves the workspace owns the hostname and
 * the `CNAME` to the regional switchboard. Prisma makes it `active` once both
 * are published. Prisma creates the `unverified` domain ownership the `TXT`
 * proves; destroying the RoutingUrl leaves that domain ownership in place.
 *
 * Changing the hostname of an `active` RoutingUrl is refused, before anything
 * changes, until the new hostname has a verified domain ownership and its
 * `CNAME` at every authoritative nameserver. Prisma needs a direct `CNAME`,
 * which an apex domain such as `example.com` cannot have, so a change to an
 * apex hostname is refused. The check does not see a RoutingUrl in another
 * workspace that holds the new hostname; the change then goes through and
 * the new hostname stays `pending` behind `heldBy`.
 *
 * To replace a `Prisma.CustomDomain` with a `Prisma.RoutingUrl` for the same
 * hostname, keep the CustomDomain with `RemovalPolicy.retain()`, or remove it
 * in an earlier deploy. The RoutingUrl takes over the row the CustomDomain
 * made, and the CustomDomain's delete would remove that row.
 *
 * Don't also declare a `Prisma.DomainOwnership` for the same exact hostname:
 * it takes over the domain ownership Prisma created for the RoutingUrl and
 * deletes it on destroy.
 *
 * ### Serving a Hostname
 * **Example:** Serve an app on a hostname
 * ```typescript
 * const url = yield* Prisma.RoutingUrl("api", {
 *   app: api,
 *   hostname: "api.example.com",
 * });
 * // url.status: "pending"; url.records: the TXT and CNAME to publish
 * ```
 *
 * @resource
 * @product Compute
 */
export const RoutingUrl = Resource<RoutingUrl>("Prisma.RoutingUrl");

const attrsFrom = (url: ApiRoutingUrl): RoutingUrl["Attributes"] => ({
  routingUrlId: url.id,
  branchId: url.branchId,
  serviceId: url.serviceId,
  hostname: url.hostname,
  logicalId: url.logicalId,
  status: url.status,
  conditions: url.conditions,
  firstUnmetCondition: url.firstUnmetCondition,
  records: url.records,
  ownershipExpiry: url.ownershipExpiry,
  heldBy: url.heldBy,
  customDomainSyncError: url.customDomainSyncError,
  setupUrl: url.setupUrl,
});

const normalizeHostname = (hostname: string) => hostname.trim().replace(/\.$/, "").toLowerCase();

const appIdValue = (app: AppReference | undefined) => (typeof app === "string" ? app : app?.appId);

const resolveServiceId = (app: AppReference) => {
  const value = appIdValue(app);
  return typeof value === "string"
    ? Effect.succeed(value)
    : Effect.fail(
        new RoutingUrlOperationFailed({ message: "Unable to resolve the Prisma app id." }),
      );
};

const serviceOf = (serviceId: string) =>
  Effect.gen(function* () {
    const service = (yield* getService({ serviceId })).data;
    if (service.branchId === null) {
      return yield* new RoutingUrlServiceOnAnotherBranch({
        message: `Prisma service '${serviceId}' is not on a Branch, so it cannot serve a RoutingUrl.`,
      });
    }
    return { ...service, branchId: service.branchId };
  });

type Service = Effect.Success<ReturnType<typeof serviceOf>>;

const branchUrls = (service: Service) =>
  getProjectBranchUrls({ projectId: service.projectId, branchId: service.branchId }).pipe(
    Effect.map((response) => response.data),
  );

const getRoutingUrl = (id: string) =>
  getUrl({ id }).pipe(
    Effect.map((response) => response.data),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

/** The row with `logicalId`, else one Prisma's backfill made: same service and hostname, no `logicalId`. */
const ownRow = (
  urls: ReadonlyArray<ApiRoutingUrl>,
  serviceId: string,
  hostname: string,
  logicalId: string,
) =>
  urls.find((url) => url.logicalId === logicalId) ??
  urls.find(
    (url) =>
      url.logicalId === null &&
      url.serviceId === serviceId &&
      normalizeHostname(url.hostname) === hostname,
  );

/**
 * Prisma's 409 and 422 share the generic `Conflict` and
 * `UnprocessableEntity`, whose only field is the message.
 */
const refusals = (hostname: string, logicalId: string, serviceId: string) => ({
  Conflict: (error: Conflict) =>
    Effect.fail(
      error.message.startsWith("Quota exceeded")
        ? new RoutingUrlQuotaExceeded({
            message: `Prisma service '${serviceId}' already serves as many hostnames as its plan allows; '${hostname}' was not added.`,
            cause: error,
          })
        : error.message.includes("logicalId")
          ? new RoutingUrlLogicalIdTaken({
              message: `Another Prisma RoutingUrl on the Branch has logicalId '${logicalId}'. Choose another logicalId.`,
              cause: error,
            })
          : new RoutingUrlOperationFailed({ message: error.message, cause: error }),
    ),
  UnprocessableEntity: (error: UnprocessableEntity) =>
    Effect.fail(
      error.message.includes("is not a hostname")
        ? new RoutingUrlInvalidHostname({ message: error.message, cause: error })
        : error.message.includes("Branch")
          ? new RoutingUrlServiceOnAnotherBranch({ message: error.message, cause: error })
          : new RoutingUrlOperationFailed({ message: error.message, cause: error }),
    ),
});

/** `*.example.com` for `api.example.com`; a wildcard's base needs two labels. */
const wildcardOf = (hostname: string) => {
  const labels = hostname.split(".");
  return labels.length >= 3 ? `*.${labels.slice(1).join(".")}` : undefined;
};

const ProviderLive = () =>
  Provider.effect(
    RoutingUrl,
    Effect.gen(function* () {
      const checkRecord = yield* AuthoritativeRecordCheck;

      /** Refuse a hostname change the new hostname cannot serve yet. */
      const ensureCanServe = (service: Service, from: string, to: string) =>
        Effect.gen(function* () {
          const workspaceId = (yield* getProject({ id: service.projectId })).data.workspace.id;
          const covering = [to, wildcardOf(to)].filter((domain) => domain !== undefined);
          const ownerships = yield* Effect.forEach(covering, (domain) =>
            getWorkspaceDomainOwnerships({ workspaceId, domain }).pipe(
              Effect.map((response) => response.data),
            ),
          );
          const owned = ownerships.flat().some((ownership) => ownership.status === "verified");
          const target = switchboardTarget(service.appEndpointDomain);
          const cname = yield* checkRecord(
            { type: "CNAME", name: to, value: target },
            { margin: "if-unseen" },
          );
          const routed = cname === "seen";
          if (owned && routed) return;
          const verification = owned
            ? undefined
            : (yield* getWorkspaceDomainOwnershipsVerification({ workspaceId, domain: to })).data;
          const records = [
            ...(verification
              ? [{ type: "TXT" as const, name: verification.name, value: verification.value }]
              : []),
            ...(cname === "absent" ? [{ type: "CNAME" as const, name: to, value: target }] : []),
          ];
          const publish =
            records.length === 0
              ? ""
              : ` Publish ${records.map((record) => `${record.type} ${record.name} = ${record.value}`).join(" and ")}, then redeploy.`;
          const unchecked =
            cname === "unknown"
              ? ` The CNAME of '${to}' to ${target} could not be checked from this machine: no authoritative nameserver for it could be found or reached. Redeploy from a machine that can reach them.`
              : "";
          return yield* new RoutingUrlHostnameChangeRefused({
            from,
            to,
            records,
            message: `Prisma RoutingUrl '${from}' is serving, and '${to}' cannot be shown to serve yet.${publish}${unchecked}`,
          });
        });

      return {
        stables: ["routingUrlId", "branchId"],
        read: Effect.fn(function* ({ fqn, output, olds }) {
          const routingUrlId = concreteIdOf(output?.routingUrlId);
          const stored =
            routingUrlId === undefined ? undefined : yield* getRoutingUrl(routingUrlId);
          if (stored) return attrsFrom(stored);
          const serviceId = concreteIdOf(appIdValue(olds?.app));
          if (serviceId === undefined || typeof olds?.hostname !== "string") return undefined;
          const service = yield* serviceOf(serviceId);
          const found = ownRow(
            yield* branchUrls(service),
            serviceId,
            normalizeHostname(olds.hostname),
            olds.logicalId ?? fqn,
          );
          return found ? attrsFrom(found) : undefined;
        }),
        reconcile: Effect.fn(function* ({ fqn, news, output }) {
          const serviceId = yield* resolveServiceId(news.app);
          const hostname = normalizeHostname(news.hostname);
          const logicalId = news.logicalId ?? fqn;
          const service = yield* serviceOf(serviceId);
          const urls = yield* branchUrls(service);
          const routingUrlId = concreteIdOf(output?.routingUrlId);
          const stored =
            routingUrlId === undefined ? undefined : yield* getRoutingUrl(routingUrlId);
          const observed = stored ?? ownRow(urls, serviceId, hostname, logicalId);
          const holder = urls.find(
            (url) => url.id !== observed?.id && normalizeHostname(url.hostname) === hostname,
          );
          if (holder) {
            return yield* new RoutingUrlHostnameTaken({
              routingUrlId: holder.id,
              message: `Prisma RoutingUrl '${holder.id}' (logicalId '${holder.logicalId ?? "none"}', service '${holder.serviceId ?? "deleted"}') already has '${hostname}' on this Branch.`,
            });
          }
          if (!observed) {
            const created = yield* createServiceUrl({ serviceId, hostname, logicalId }).pipe(
              Effect.catchTags(refusals(hostname, logicalId, serviceId)),
            );
            return attrsFrom(created.data);
          }
          const change = {
            ...(normalizeHostname(observed.hostname) === hostname ? {} : { hostname }),
            ...(observed.serviceId === serviceId ? {} : { serviceId }),
            ...(observed.logicalId === logicalId ? {} : { logicalId }),
          };
          if (Object.keys(change).length === 0) return attrsFrom(observed);
          if (change.hostname !== undefined && observed.status === "active") {
            yield* ensureCanServe(service, observed.hostname, hostname);
          }
          const updated = yield* updateUrl({ id: observed.id, ...change }).pipe(
            Effect.catchTags(refusals(hostname, logicalId, serviceId)),
          );
          return attrsFrom(updated.data);
        }),
        delete: Effect.fn(function* ({ output }) {
          if (isPrismaDevId(output.routingUrlId)) return;
          yield* deleteUrl({ id: output.routingUrlId }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
      };
    }),
  );

const ProviderLocal = () =>
  devProvider(RoutingUrl, ["routingUrlId", "branchId"], ({ id, news }) => ({
    routingUrlId: devId("routing-url", id),
    branchId: "dev:branch:local",
    serviceId: attrOrString(news.app, "appId"),
    hostname: normalizeHostname(String(news.hostname)),
    logicalId: news.logicalId ?? id,
    status: "active" as const,
    conditions: {
      ownershipVerified: "met" as const,
      servicePresent: "met" as const,
      liveDeployment: "met" as const,
      dnsPointsAtSwitchboard: "met" as const,
      customDomainBound: "met" as const,
      certificateActive: "met" as const,
    },
    firstUnmetCondition: null,
    records: [],
    ownershipExpiry: null,
    heldBy: null,
    customDomainSyncError: null,
    setupUrl: null,
  }));

export const RoutingUrlProvider = () =>
  ProviderLayer.dual(RoutingUrl, {
    local: () => ProviderLocal(),
    live: () => ProviderLive(),
  });
