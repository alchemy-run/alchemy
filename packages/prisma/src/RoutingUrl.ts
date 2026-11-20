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
import * as DNS from "alchemy/DNS/Adapter";
import type { InputProps } from "alchemy/Input";
import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import type { Resource, ResourceLike } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { App } from "./App.ts";
import type { Compute } from "./Compute.ts";
import { SwitchboardDnsCheck } from "./internal/AuthoritativeDns.ts";
import { attrOrString, devId, devProvider } from "./internal/DevStub.ts";
import { DomainVerification } from "./internal/DomainVerification.ts";
import { concreteIdOf, isPrismaDevId } from "./internal/Refs.ts";
import { RoutingUrlResource } from "./internal/RoutingUrlResource.ts";
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
 * because the new hostname could not be shown to serve yet. Publish `records`,
 * then redeploy. When `switchboardDns` is `unknown`, this machine could not
 * check the new hostname's DNS, and publishing `records` may not be enough.
 */
export class RoutingUrlHostnameChangeRefused extends Data.TaggedError(
  "RoutingUrlHostnameChangeRefused",
)<{
  readonly message: string;
  readonly from: string;
  readonly to: string;
  /**
   * Records still to publish. A hostname that cannot have a CNAME, such as a
   * zone apex, can publish its `CNAME` as an ALIAS, ANAME or flattened CNAME.
   */
  readonly records: ReadonlyArray<{
    readonly type: "TXT" | "CNAME";
    readonly name: string;
    readonly value: string;
  }>;
  /**
   * Whether every authoritative nameserver for the new hostname shows it
   * pointing at the regional switchboard: `seen`, `absent`, or `unknown` when
   * it could not be checked from this machine.
   */
  readonly switchboardDns: "seen" | "absent" | "unknown";
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
  /**
   * DNS host that publishes the hostname's `TXT` and `CNAME` records, e.g.
   * `Cloudflare.DNS.Adapter()` (see
   * [DNS Adapters](/infrastructure-as-code/dns-adapters)). Omitted: publish
   * `records` yourself.
   */
  dns?: DNS.DnsConfig;
}

export interface RoutingUrl extends Resource<
  "Prisma.RoutingUrl",
  Omit<RoutingUrlProps, "dns">,
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
 * changes, until the new hostname has a verified domain ownership and every
 * authoritative nameserver for it answers with either a `CNAME` to the
 * regional switchboard or, with no `CNAME`, A or AAAA records that include a
 * switchboard address. Any hostname passes with either; the address form is
 * what an ALIAS, ANAME or flattened `CNAME` gives a zone apex such as
 * `example.com`. A refused change asks only once whether the DNS is in place
 * when the domain ownership is not verified yet, so it fails without waiting.
 * The check does not see a RoutingUrl in another workspace that holds the new
 * hostname; the change then goes through and the new hostname stays `pending`
 * behind `heldBy`.
 *
 * Prisma records a custom domain as a RoutingUrl, and has done so for every
 * custom domain since its backfill ran on 2026-11-17. Once it has, to replace
 * a `Prisma.CustomDomain` with a `Prisma.RoutingUrl` for the same hostname,
 * keep the CustomDomain with `RemovalPolicy.retain()`, or remove it in an
 * earlier deploy. The RoutingUrl takes over the row the CustomDomain made, and
 * the CustomDomain's delete would remove that row.
 *
 * Don't also declare a `Prisma.DomainOwnership` for the same exact hostname:
 * it takes over the domain ownership Prisma created for the RoutingUrl and
 * deletes it on destroy.
 *
 * With `dns`, the deploy publishes the `TXT` and the `CNAME` through that DNS
 * host before it saves the RoutingUrl, and destroy removes them. The deploy
 * does not wait for the hostname to become `active`. A zone apex such as
 * `example.com` needs a DNS host that flattens a `CNAME` at the apex; at any
 * other host, omit `dns` and publish an ALIAS or ANAME yourself.
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
 * **Example:** Publish the records with a DNS host
 * ```typescript
 * const url = yield* Prisma.RoutingUrl("api", {
 *   app: api,
 *   hostname: "api.example.com",
 *   dns: Cloudflare.DNS.Adapter(),
 * });
 * ```
 *
 * @resource
 * @product Compute
 */
export const RoutingUrl = (id: string, props: InputProps<RoutingUrlProps, "dns">) =>
  Effect.gen(function* () {
    const { dns, ...urlProps } = props;
    if (dns === undefined) return yield* RoutingUrlResource(id, urlProps);
    const published = yield* publishRecords(props.app, props.hostname, dns).pipe(
      Namespace.push(id),
    );
    return yield* RoutingUrlResource(id, {
      ...urlProps,
      hostname: Output.map(
        Output.all(Output.of(published.records as ResourceLike), published.hostname),
        ([, hostname]) => hostname,
      ),
    });
  });

/**
 * The hostname's `TXT` and `CNAME`, derived from the workspace's verification
 * value and the app's endpoint so they are the same on every deploy.
 */
const publishRecords = (
  app: InputProps<RoutingUrlProps>["app"],
  hostname: InputProps<RoutingUrlProps>["hostname"],
  dnsConfig: DNS.DnsConfig,
) =>
  Effect.gen(function* () {
    const dns = yield* DNS.resolve(dnsConfig);
    const service = Predicate.hasProperty(app, "Type")
      ? (app as App | Compute)
      : App.lookup({ appId: app as InputProps<RoutingUrlProps>["hostname"] });
    const verification = yield* DomainVerification("Verification", {
      project: { projectId: service.projectId },
      domain: hostname,
    });
    const records = yield* dns.records("Records", {
      records: Output.map(
        Output.all(
          verification.recordName,
          verification.recordValue,
          verification.domain,
          service.appEndpointDomain,
        ),
        ([txtName, txtValue, name, endpoint]): DNS.DnsRecord[] => [
          { name: txtName, type: "TXT", value: txtValue },
          { name, type: "CNAME", value: switchboardTarget(endpoint) },
        ],
      ),
    });
    return { records, hostname: verification.domain };
  });

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
    RoutingUrlResource,
    Effect.gen(function* () {
      const checkSwitchboardDns = yield* SwitchboardDnsCheck;

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
          const dns = yield* checkSwitchboardDns(
            { name: to, switchboard: target },
            { margin: "if-unseen", nameservers: "name", attempts: owned ? "until-seen" : "once" },
          );
          if (owned && dns.visibility === "seen") return;
          const verification = owned
            ? undefined
            : (yield* getWorkspaceDomainOwnershipsVerification({ workspaceId, domain: to })).data;
          const cnameMissing = dns.visibility !== "seen" && dns.cname === "absent";
          const records = [
            ...(verification
              ? [{ type: "TXT" as const, name: verification.name, value: verification.value }]
              : []),
            ...(cnameMissing ? [{ type: "CNAME" as const, name: to, value: target }] : []),
          ];
          const unchecked =
            dns.visibility !== "unknown"
              ? ""
              : cnameMissing
                ? ` '${to}' has no CNAME to ${target}, and whether its A or AAAA records include a switchboard address could not be checked from this machine.`
                : ` Whether '${to}' points at ${target} could not be checked from this machine.`;
          const publish =
            records.length === 0
              ? " Redeploy once it can be checked."
              : ` Publish ${records.map((record) => `${record.type} ${record.name} = ${record.value}`).join(" and ")}, then redeploy.${cnameMissing ? ` A hostname that cannot have a CNAME, such as a zone apex, can use an ALIAS, ANAME or flattened CNAME instead.` : ""}`;
          return yield* new RoutingUrlHostnameChangeRefused({
            from,
            to,
            records,
            switchboardDns: dns.visibility,
            message: `Prisma RoutingUrl '${from}' is serving, and '${to}' cannot be shown to serve yet.${unchecked}${publish}`,
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
  devProvider(RoutingUrlResource, ["routingUrlId", "branchId"], ({ id, news }) => ({
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
  ProviderLayer.dual(RoutingUrlResource, {
    local: () => ProviderLocal(),
    live: () => ProviderLive(),
  });
