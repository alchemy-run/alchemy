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
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as DNS from "alchemy/DNS/Adapter";
import type { InputProps } from "alchemy/Input";
import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import { ProviderModePolicy } from "alchemy/ProviderMode";
import { Resource, type ResourceLike } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { App } from "./App.ts";
import type { Compute } from "./Compute.ts";
import { AuthoritativeRecordCheck, SwitchboardDnsCheck } from "./internal/AuthoritativeDns.ts";
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
 * because the new hostname could not be shown to serve yet. Publish `records`,
 * then redeploy. When `switchboardDns` or `ownershipDns` is `unknown`, this
 * machine could not check the new hostname's DNS, and publishing `records`
 * may not be enough.
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
  /**
   * How the workspace was shown to own the new hostname: `verified` by a
   * domain ownership, or the `TXT` record `seen` at every authoritative
   * nameserver; otherwise `absent`, or `unknown` when it could not be checked
   * from this machine.
   */
  readonly ownershipDns: "verified" | "seen" | "absent" | "unknown";
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
   * [DNS Adapters](/infrastructure-as-code/dns-adapters)). Needs `hostname`
   * as a plain string. Omitted: publish `records` yourself; removing `dns`
   * from a deployed RoutingUrl removes the records it published.
   */
  dns?: DNS.DnsConfig;
}

/** Props the `Prisma.RoutingUrl` resource receives from {@link RoutingUrl}. */
export interface RoutingUrlRowProps extends Omit<RoutingUrlProps, "dns"> {
  /** This deploy publishes the hostname's records, so the hostname-change check waits for them. */
  recordsPublished?: boolean;
}

export interface RoutingUrl extends Resource<
  "Prisma.RoutingUrl",
  RoutingUrlRowProps,
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
 * changes, until the workspace is shown to own the new hostname and every
 * authoritative nameserver for it answers with either a `CNAME` to the
 * regional switchboard or, with no `CNAME`, A or AAAA records that include a
 * switchboard address. Ownership is shown by a verified domain ownership that
 * covers the hostname, or by its `TXT` record at every authoritative
 * nameserver, which Prisma verifies when it saves the change. Any hostname
 * passes the switchboard check with either form; the address form is what an
 * ALIAS, ANAME or flattened `CNAME` gives a zone apex such as `example.com`.
 * A refused change names the records to publish, so publishing them and
 * redeploying lets it through. The check does not see a RoutingUrl in another
 * workspace that holds the new hostname; the change then goes through and the
 * new hostname stays `pending` behind `heldBy`.
 *
 * Prisma records a custom domain as a RoutingUrl, and has done so for every
 * custom domain since its backfill ran on 2026-11-17. A RoutingUrl declared
 * for the same app and hostname as a `Prisma.CustomDomain` takes over the row
 * Prisma recorded, so the CustomDomain can be removed in the same deploy: its
 * delete leaves a row a RoutingUrl has taken over in place.
 *
 * Don't also declare a `Prisma.DomainOwnership` for the same exact hostname:
 * it takes over the domain ownership Prisma created for the RoutingUrl and
 * deletes it on destroy.
 *
 * With `dns`, the deploy publishes the `TXT` and the `CNAME` through that DNS
 * host before it saves the RoutingUrl, and destroy removes them. They are
 * published DNS-only, even when the adapter proxies aliases, so Prisma sees
 * the `CNAME`. A hostname change publishes the new hostname's records first
 * and removes the old ones only once the change is saved; removing `dns`
 * removes them. The deploy does not wait for the hostname to become
 * `active`, so a hostname that serves from another host today stops serving
 * there as soon as its `CNAME` is replaced; publish the records yourself to
 * move it. A create Prisma refuses leaves both records published until the
 * next deploy or destroy. Nothing is published under `alchemy dev`. A zone
 * apex such as `example.com` needs a DNS host that flattens a `CNAME` at the
 * apex; at any other host, omit `dns` and publish an ALIAS or ANAME yourself.
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
export const RoutingUrl = (id: string, props: RoutingUrlInput) =>
  Effect.gen(function* () {
    const { dns, ...rowProps } = props;
    if (dns === undefined || !(yield* publishesDns)) return yield* RoutingUrlRow(id, rowProps);
    const hostname = normalizeHostname(props.hostname);
    if (hostname.startsWith("*.")) {
      return yield* new RoutingUrlInvalidHostname({
        message: `'${props.hostname}' is a wildcard, which a RoutingUrl cannot serve; nothing was published.`,
      });
    }
    const key = hostname.replaceAll(/[^a-z0-9-]/g, "-");
    const published = yield* Effect.gen(function* () {
      const adapter = yield* DNS.resolve(dns);
      const required = yield* RoutingUrlDnsRecords(`RequiredRecords-${key}`, {
        app: props.app,
        hostname,
      });
      return yield* adapter.records(`Records-${key}`, { records: required.records });
    }).pipe(Namespace.push(id));
    return yield* RoutingUrlRow(id, {
      ...rowProps,
      hostname: Output.map(Output.of(published as ResourceLike), () => props.hostname),
      recordsPublished: true,
    });
  });

/** Props of {@link RoutingUrl}; `dns` needs `hostname` as a plain string. */
export type RoutingUrlInput = InputProps<Omit<RoutingUrlProps, "dns">> &
  ({ dns?: undefined } | { dns: DNS.DnsConfig; hostname: string });

/** `alchemy dev` publishes no DNS, unless the RoutingUrl is `Alchemy.remote()`. */
const publishesDns = Effect.gen(function* () {
  const context = yield* Effect.serviceOption(AlchemyContext);
  const dev = Option.isSome(context) && context.value.dev;
  return !dev || (yield* ProviderModePolicy) === true;
});

const RoutingUrlRow = Resource<RoutingUrl>("Prisma.RoutingUrl");

export interface RoutingUrlDnsRecordsProps {
  /** App ID or Compute output whose service the hostname serves. */
  app: AppReference;
  /** Hostname, normalized. */
  hostname: string;
}

/**
 * The `TXT` and `CNAME` a RoutingUrl's hostname needs, read from Prisma: the
 * workspace's verification value and the app's regional switchboard. They do
 * not depend on what Prisma still lists as unmet, so they are the same on
 * every deploy. Nothing exists in Prisma for it; deleting it is a no-op.
 */
export interface RoutingUrlDnsRecords extends Resource<
  "Prisma.RoutingUrlDnsRecords",
  RoutingUrlDnsRecordsProps,
  {
    serviceId: string;
    workspaceId: string;
    hostname: string;
    records: DNS.DnsRecord[];
  },
  never,
  Providers
> {}

const RoutingUrlDnsRecords = Resource<RoutingUrlDnsRecords>("Prisma.RoutingUrlDnsRecords");

/**
 * The resources {@link RoutingUrl} declares, for a provider collection built
 * by hand; {@link RoutingUrlProvider} provides them.
 */
export const RoutingUrlResources = [RoutingUrlRow, RoutingUrlDnsRecords] as const;

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
    RoutingUrlRow,
    Effect.gen(function* () {
      const checkSwitchboardDns = yield* SwitchboardDnsCheck;
      const checkRecord = yield* AuthoritativeRecordCheck;

      /** Refuse a hostname change the new hostname cannot serve yet. */
      const ensureCanServe = (
        service: Service,
        from: string,
        to: string,
        recordsPublished: boolean,
      ) =>
        Effect.gen(function* () {
          const workspaceId = (yield* getProject({ id: service.projectId })).data.workspace.id;
          const covering = [to, wildcardOf(to)].filter((domain) => domain !== undefined);
          const ownerships = yield* Effect.forEach(covering, (domain) =>
            getWorkspaceDomainOwnerships({ workspaceId, domain }).pipe(
              Effect.map((response) => response.data),
            ),
          );
          const verification = ownerships.flat().some((row) => row.status === "verified")
            ? undefined
            : (yield* getWorkspaceDomainOwnershipsVerification({ workspaceId, domain: to })).data;
          const ownershipDns =
            verification === undefined
              ? ("verified" as const)
              : yield* checkRecord(
                  { type: "TXT", name: verification.name, value: verification.value },
                  {
                    margin: "if-unseen",
                    nameservers: "parent",
                    attempts: recordsPublished ? "until-seen" : "once",
                  },
                );
          const owned = ownershipDns === "verified" || ownershipDns === "seen";
          const target = switchboardTarget(service.appEndpointDomain);
          const dns = yield* checkSwitchboardDns(
            { name: to, switchboard: target },
            { margin: "if-unseen", nameservers: "name", attempts: owned ? "until-seen" : "once" },
          );
          if (owned && dns.visibility === "seen") return;
          const cnameMissing = dns.visibility !== "seen" && dns.cname === "absent";
          const records = [
            ...(verification && !owned
              ? [{ type: "TXT" as const, name: verification.name, value: verification.value }]
              : []),
            ...(cnameMissing ? [{ type: "CNAME" as const, name: to, value: target }] : []),
          ];
          const ownership =
            owned || verification === undefined
              ? ""
              : ownershipDns === "unknown"
                ? ` No verified domain ownership covers '${to}', and whether every authoritative nameserver answers TXT ${verification.name} with the workspace's value could not be checked from this machine.`
                : ` No verified domain ownership covers '${to}', and not every authoritative nameserver answers TXT ${verification.name} with the workspace's value.`;
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
            ownershipDns,
            message: `Prisma RoutingUrl '${from}' is serving, and '${to}' cannot be shown to serve yet.${ownership}${unchecked}${publish}`,
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
            yield* ensureCanServe(
              service,
              observed.hostname,
              hostname,
              news.recordsPublished === true,
            );
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
  devProvider(RoutingUrlRow, ["routingUrlId", "branchId"], ({ id, news }) => ({
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

const DnsRecordsProvider = () =>
  Provider.effect(
    RoutingUrlDnsRecords,
    Effect.gen(function* () {
      return {
        read: Effect.fn(function* ({ output }) {
          return output;
        }),
        reconcile: Effect.fn(function* ({ news }) {
          const serviceId = yield* resolveServiceId(news.app);
          const service = (yield* getService({ serviceId })).data;
          if (!service.appEndpointDomain) {
            return yield* new RoutingUrlOperationFailed({
              message: `Prisma app '${serviceId}' has no endpoint domain, so '${news.hostname}' has no switchboard to point at; nothing was published.`,
            });
          }
          const workspaceId = (yield* getProject({ id: service.projectId })).data.workspace.id;
          const hostname = normalizeHostname(news.hostname);
          const verification = (yield* getWorkspaceDomainOwnershipsVerification({
            workspaceId,
            domain: hostname,
          })).data;
          return {
            serviceId,
            workspaceId,
            hostname,
            records: [
              { name: verification.name, type: "TXT" as const, value: verification.value },
              {
                name: hostname,
                type: "CNAME" as const,
                value: switchboardTarget(service.appEndpointDomain),
              },
            ],
          };
        }),
        delete: Effect.fn(function* () {}),
      };
    }),
  );

export const RoutingUrlProvider = () =>
  Layer.mergeAll(
    ProviderLayer.dual(RoutingUrlRow, {
      local: () => ProviderLocal(),
      live: () => ProviderLive(),
    }),
    DnsRecordsProvider(),
  );
