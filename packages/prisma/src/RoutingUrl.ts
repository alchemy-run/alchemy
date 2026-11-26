import type { Conflict, UnprocessableEntity } from "@distilled.cloud/prisma";
import type {
  RoutingUrlInvalidHostname as PrismaInvalidHostname,
  RoutingUrlLogicalIdTaken as PrismaLogicalIdTaken,
  RoutingUrlQuotaExceeded as PrismaQuotaExceeded,
  RoutingUrlServiceNotOnABranch as PrismaServiceNotOnABranch,
  RoutingUrlServiceOnAnotherBranch as PrismaServiceOnAnotherBranch,
} from "@distilled.cloud/prisma/management";
import {
  type GetUrlResponseData,
  createServiceUrl,
  createUrlCheck,
  deleteUrl,
  getProject,
  getProjectBranchUrls,
  getService,
  getUrl,
  getWorkspaceDomainOwnerships,
  getWorkspaceDomainOwnershipsVerification,
  updateUrl,
} from "@distilled.cloud/prisma/management";
import * as Retry from "@distilled.cloud/prisma/Retry";
import { Unowned } from "alchemy/AdoptPolicy";
import * as DNS from "alchemy/DNS/Adapter";
import type { Input } from "alchemy/Input";
import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import { Resource, type ResourceLike } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { AuthoritativeRecordCheck, SwitchboardDnsCheck } from "./internal/AuthoritativeDns.ts";
import { attrOrString, devId, devProvider } from "./internal/DevStub.ts";
import { coveringDomainsOf } from "./internal/DomainOwnership.ts";
import { isPlainHostname, normalizeHostname } from "./internal/Hostname.ts";
import { publishesDns } from "./internal/PublishesDns.ts";
import { concreteIdOf, isPrismaDevId } from "./internal/Refs.ts";
import {
  type AppReference,
  appIdValue,
  hasLogicalId,
  notOnABranch,
  resolveServiceId,
  RoutingUrlOperationFailed,
} from "./internal/RoutingUrl.ts";
import {
  publishedRecordsId,
  requiredRecords,
  RoutingUrlRequiredRecords,
  RoutingUrlRequiredRecordsProvider,
} from "./internal/RoutingUrlRequiredRecords.ts";

export { RoutingUrlOperationFailed, RoutingUrlServiceNotOnABranch } from "./internal/RoutingUrl.ts";
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

/** The props cannot be used as given, e.g. `dns` with a hostname that is not a plain string. */
export class RoutingUrlInvalidProps extends Data.TaggedError("RoutingUrlInvalidProps")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * The hostname cannot be served by a RoutingUrl: Prisma refused it, or `dns`
 * is set and it is a wildcard or not dot-separated labels of letters, digits
 * and hyphens.
 */
export class RoutingUrlInvalidHostname extends Data.TaggedError("RoutingUrlInvalidHostname")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** The new service is on a different Branch from the RoutingUrl. */
export class RoutingUrlServiceOnAnotherBranch extends Data.TaggedError(
  "RoutingUrlServiceOnAnotherBranch",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * A serving RoutingUrl's hostname change was refused before anything changed,
 * because the new hostname could not be shown to serve yet. Publish `records`,
 * then redeploy. When `ownership` is `noDomainOwnership`, no domain ownership
 * covers the new hostname: declare a `Prisma.DomainOwnership` for it and
 * redeploy once it exists, or set `createDomainOwnership: true`. When
 * `switchboardDns` or `ownership` is `unknown`, this machine could not check
 * the new hostname's DNS, and publishing `records` may not be enough.
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
   * Whether the workspace was shown to own the new hostname: `verified` when
   * a verified domain ownership covers it; `seen` when every authoritative
   * nameserver answers the `TXT` record of a domain ownership that covers it;
   * `absent` when one answers without it; `unknown` when this machine could
   * not check; `noDomainOwnership` when no domain ownership covers it and
   * `createDomainOwnership` is not set, so Prisma would look up no record.
   */
  readonly ownership: "verified" | "seen" | "absent" | "unknown" | "noDomainOwnership";
}> {}

/**
 * With `dns`, the `CNAME` this deploy published was still missing at an
 * authoritative nameserver after about 3 minutes, so Prisma was not asked to
 * look at it and no certificate was ordered. A nameserver this machine cannot
 * query does not raise this error. Redeploy once the record appears; if it
 * never does, the DNS host may not be the one the domain is delegated to.
 */
export class RoutingUrlRecordsNotSeen extends Data.TaggedError("RoutingUrlRecordsNotSeen")<{
  readonly message: string;
  readonly hostname: string;
  /** The published records an authoritative nameserver answered without. */
  readonly records: ReadonlyArray<{
    readonly type: "CNAME";
    readonly name: string;
    readonly value: string;
  }>;
}> {}

type ApiRoutingUrl = GetUrlResponseData;

export interface RoutingUrlProps {
  /** App ID or Compute output whose service the hostname serves. */
  app: Input<AppReference>;
  /**
   * Hostname to serve, such as `api.example.com`. Case and a trailing dot are
   * ignored. With `dns`, a plain string.
   */
  hostname: Input<string>;
  /**
   * Identity of the RoutingUrl on its Branch. Without state, a row on this
   * app with this `logicalId` is this resource's; one on another app needs
   * `--adopt`, since another stage or stack on the Branch can use the same.
   * @default the resource's fully qualified name with `.` for `/`:
   * `Site.Url` for `Prisma.RoutingUrl("Url", …)` inside a `Prisma.Website`
   * named `Site`
   */
  logicalId?: Input<string>;
  /**
   * DNS host that publishes the hostname's `CNAME` to the regional
   * switchboard, e.g. `Cloudflare.DNS.Adapter()` (see
   * [DNS Adapters](/infrastructure-as-code/dns-adapters)). It publishes only
   * the `CNAME`: also declare a `Prisma.DomainOwnership` with `dns` that
   * covers the hostname, which publishes the `TXT`. Omitted: publish the
   * `CNAME` in `records` yourself. Removing `dns` from a deployed RoutingUrl
   * removes the `CNAME` it published; to publish it with another tool
   * instead, publish it there first.
   */
  dns?: DNS.DnsConfig;
  /**
   * Ask Prisma to create a domain ownership for this exact hostname, for a
   * stack that should not manage a workspace-level resource, such as one
   * deployed with a token limited to one project. Otherwise declare a
   * `Prisma.DomainOwnership`. Prisma creates an `unverified` one only when no
   * verified domain ownership covers the hostname and the exact one does not
   * exist; under a verified wildcard it creates nothing. It appears on the
   * workspace's Domains page, only an Admin can delete it, and it stays when
   * the RoutingUrl is destroyed. `dns` does not publish its `TXT`: publish
   * the `TXT` in `records` yourself. Don't combine it with a
   * `Prisma.DomainOwnership` for the same exact hostname: when the RoutingUrl
   * is saved first, that resource then needs `--adopt`. Prisma does not store
   * this option, so a domain ownership deleted later is created again only by
   * the next deploy that changes this resource's props.
   * @default false
   */
  createDomainOwnership?: boolean;
}

export interface RoutingUrl extends Resource<
  "Prisma.RoutingUrl",
  {
    /** App ID or Compute output whose service the hostname serves. */
    app: AppReference;
    /** Hostname to serve. */
    hostname: string;
    /** Identity of the RoutingUrl on its Branch. */
    logicalId?: string;
    /**
     * This deploy publishes the hostname's `CNAME` through `dns`. The
     * provider then waits for it to appear before Prisma first looks at a
     * new hostname.
     */
    publishesRecords?: boolean;
    /** Ask Prisma to create a domain ownership for the exact hostname. */
    createDomainOwnership?: boolean;
  },
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
    /**
     * `active` once the hostname has gone live. It goes back to `pending` only
     * when the hostname changes, the service is deleted, or the workspace's
     * ownership lapses, so it does not say whether the hostname serves now;
     * `state` does. As of the deploy's last write or check: an unchanged
     * redeploy does not read it again, so see `setupUrl` for the live value.
     */
    status: ApiRoutingUrl["status"];
    /**
     * What the hostname is doing now, as of the deploy's last write or check.
     * At the end of a deploy:
     * `no_domain_ownership`: no domain ownership covered the hostname, so
     * Prisma looked up no `TXT`; if the stack declares a
     * `Prisma.DomainOwnership`, the hostname continues once that domain
     * ownership is verified, otherwise declare one or set
     * `createDomainOwnership: true`.
     * `not_verified`: a domain ownership covers it but is not verified yet;
     * Prisma continues on its own once it is.
     * `waiting_for_dns`: the `CNAME` does not point at the switchboard yet.
     * `in_use_elsewhere`: another RoutingUrl holds the hostname (`heldBy`).
     * `certificate_failed`: see `certificateFailureReason`.
     * `active`: it serves.
     */
    state: ApiRoutingUrl["state"];
    /** What the hostname needs to serve, each `met`, `unmet` or `unknown`. As last read. */
    conditions: ApiRoutingUrl["conditions"];
    /** The first condition not met, or null when all are. */
    firstUnmetCondition: ApiRoutingUrl["firstUnmetCondition"];
    /**
     * The records Prisma has not yet confirmed, including records `dns` has
     * just published: the `TXT` for ownership and the `CNAME` to the
     * switchboard. In `no_domain_ownership` its `TXT` is the one a domain
     * ownership for this exact hostname would use, and publishing it does
     * nothing until one exists.
     */
    records: ApiRoutingUrl["records"];
    /** Set while only an `expiring` domain ownership keeps the hostname serving. */
    ownershipExpiry: ApiRoutingUrl["ownershipExpiry"];
    /** Set when a RoutingUrl elsewhere holds the hostname. */
    heldBy: ApiRoutingUrl["heldBy"];
    /**
     * The error from Prisma's last sync with its custom domain, if any, such
     * as the hourly certificate limit and when it resets.
     */
    customDomainSyncError: string | null;
    /**
     * Prisma's reason for a failed certificate. A deploy does not retry it:
     * retry it at `setupUrl` or with one `POST /v1/urls/{id}/check`, which
     * orders a new certificate.
     */
    certificateFailureReason: string | null;
    /**
     * The Console page that shows the live state and what to do next, while
     * pending. Its Check button makes Prisma look at the DNS now.
     */
    setupUrl: string | null;
  },
  never,
  Providers
> {}

/**
 * A hostname that serves a Prisma app, saved before its DNS exists.
 *
 * A hostname serves once a verified domain ownership covers it and its
 * `CNAME` points at the regional switchboard. Declare the domain ownership
 * with `Prisma.DomainOwnership`, which belongs to the workspace and can cover
 * many hostnames, next to the RoutingUrl. With `dns` on both, the deploy
 * publishes the `TXT` and the `CNAME`; the two are saved in either order.
 * Without `dns`, publish the domain ownership's record and the `CNAME` in
 * `records` yourself. A stack that should not manage a workspace-level
 * resource can set `createDomainOwnership: true` instead.
 *
 * The deploy ends once the RoutingUrl is saved, before the hostname serves,
 * so the hostname may not answer yet. Prisma makes it `active` on its own
 * once the domain ownership is verified, the `CNAME` resolves and the
 * certificate is issued, normally a few minutes later. After a first deploy
 * that declares the domain ownership, `state` can be `no_domain_ownership`,
 * `not_verified`, `waiting_for_dns` or a certificate state, and none needs
 * action. The deploy logs a warning when the RoutingUrl is saved with no
 * domain ownership covering it. `status` and `state` are as of the deploy's
 * last write or check; the Console page at `setupUrl`, or
 * `GET /v1/urls/{id}`, shows them live, and its Check button, or
 * `POST /v1/urls/{id}/check`, makes Prisma look at the DNS now.
 *
 * Changing the hostname of an `active` RoutingUrl is refused, before anything
 * changes, until the workspace is shown to own the new hostname and every
 * authoritative nameserver for it answers with either a `CNAME` to the
 * regional switchboard or, with no `CNAME`, A or AAAA records that include a
 * switchboard address. Ownership is shown by a verified domain ownership that
 * covers the hostname, or by the `TXT` record of a covering domain ownership
 * of any status at every authoritative nameserver, which Prisma verifies when
 * it saves the change. With no covering domain ownership, the exact
 * hostname's `TXT` counts only with `createDomainOwnership: true`. The check
 * looks once and does not wait, so a hostname change made together with a
 * new `Prisma.DomainOwnership` for the new hostname can be refused on the
 * first deploy and pass on the next, once the domain ownership exists. Any
 * hostname passes the switchboard check with either form; the address form is
 * what an ALIAS, ANAME or flattened `CNAME` gives a zone apex such as
 * `example.com`. A refused change names the records to publish. The check
 * does not see a RoutingUrl in another workspace that holds the new hostname;
 * the change then goes through and the new hostname stays `pending` with
 * `state: "in_use_elsewhere"` and `heldBy`.
 *
 * Prisma records a custom domain as a RoutingUrl, and has done so for every
 * custom domain since its backfill ran on 2026-11-17. A RoutingUrl declared
 * for the same app and hostname as a `Prisma.CustomDomain` takes over the row
 * Prisma recorded, so the CustomDomain can be removed in the same deploy: its
 * delete leaves a row a RoutingUrl has taken over in place. A domain
 * ownership Prisma, the Console or the CLI created for the hostname is not
 * the stack's: a `Prisma.DomainOwnership` declared for it needs `--adopt`, or
 * `adopt(true)` on that resource, once.
 *
 * With `dns`, the deploy publishes the `CNAME` through that DNS host before
 * it saves the RoutingUrl, and destroy removes it. It is published DNS-only,
 * even when the adapter proxies aliases, so Prisma sees it. A hostname change
 * publishes the new hostname's `CNAME` first and removes the old one only
 * once the change is saved. A hostname that serves from another host today
 * stops serving there as soon as its `CNAME` is replaced; publish the record
 * yourself to move it. A record already published with the same value is
 * treated as this RoutingUrl's, and destroy removes it. Nothing is published
 * under `alchemy dev`. A zone apex such as `example.com` needs a DNS host
 * that flattens a `CNAME` at the apex; at any other host, omit `dns` and
 * publish an ALIAS or ANAME yourself.
 *
 * Before Prisma first looks at a new hostname, the deploy waits up to 3
 * minutes for the `CNAME` to appear at its authoritative nameservers, and
 * fails with `RoutingUrlRecordsNotSeen` while it is still absent. This
 * applies to a create and to a hostname change of a RoutingUrl that is not
 * yet `active`, and fails before anything is written to Prisma. When that
 * save leaves the row in `waiting_for_dns` with no custom domain, the deploy
 * asks Prisma to check once. Adding `dns` to a deployed RoutingUrl in `waiting_for_dns`
 * waits the same way before that check, and fails after the row is saved:
 * Prisma was not asked to look at its DNS.
 *
 * A failed certificate shows as `state: "certificate_failed"` with
 * `certificateFailureReason`; a deploy does not retry it. Retry it from
 * `setupUrl` or with one `POST /v1/urls/{id}/check`, which orders a new
 * certificate. A RoutingUrl that holds a custom domain is never checked by a
 * deploy; check it from the Console. Prisma orders a certificate for each new
 * hostname once its records are published, for each hostname change, and
 * again when an order fails or is stuck. A workspace may order 10 an hour. A
 * RoutingUrl created again after it was deleted counts again, so count CI
 * reruns and parallel jobs that deploy to the same workspace. When the limit
 * is reached, the hostname stays `pending`, `customDomainSyncError` says when
 * the limit resets, and Prisma continues on its own then.
 *
 * ### Serving a Hostname
 * **Example:** Serve an app on a hostname, with its DNS published for you
 * ```typescript
 * yield* Prisma.DomainOwnership("api-domain", {
 *   project,
 *   domain: "api.example.com",
 *   dns: Cloudflare.DNS.Adapter(),
 * });
 * const url = yield* Prisma.RoutingUrl("api", {
 *   app: api,
 *   hostname: "api.example.com",
 *   dns: Cloudflare.DNS.Adapter(),
 * });
 * // url.status: "pending"; Prisma makes it "active" on its own
 * ```
 *
 * **Example:** Publish the records yourself
 * ```typescript
 * const ownership = yield* Prisma.DomainOwnership("api-domain", {
 *   project,
 *   domain: "api.example.com",
 * });
 * const url = yield* Prisma.RoutingUrl("api", {
 *   app: api,
 *   hostname: "api.example.com",
 * });
 * // publish TXT ownership.recordName = ownership.recordValue,
 * // and the CNAME in url.records
 * ```
 *
 * **Example:** Let Prisma create the domain ownership
 * ```typescript
 * const url = yield* Prisma.RoutingUrl("api", {
 *   app: api,
 *   hostname: "api.example.com",
 *   createDomainOwnership: true,
 * });
 * // url.records: the TXT and CNAME to publish
 * ```
 *
 * @resource
 * @product Compute
 */
export const RoutingUrl = (id: string, props: RoutingUrlProps) =>
  Effect.gen(function* () {
    const { dns, ...rowProps } = props;
    if (dns === undefined || !(yield* publishesDns)) return yield* RoutingUrlRow(id, rowProps);
    const requested = props.hostname;
    if (typeof requested !== "string") {
      return yield* new RoutingUrlInvalidProps({
        message: `With dns, the hostname of RoutingUrl '${id}' must be a plain string: its DNS records are kept per hostname.`,
      });
    }
    const hostname = normalizeHostname(requested);
    if (hostname.startsWith("*.")) {
      return yield* new RoutingUrlInvalidHostname({
        message: `'${requested}' is a wildcard, which a RoutingUrl cannot serve; nothing was published.`,
      });
    }
    if (!isPlainHostname(hostname)) {
      return yield* new RoutingUrlInvalidHostname({
        message: `'${requested}' is not a hostname such as api.example.com: use dot-separated labels of letters, digits and hyphens. Nothing was published.`,
      });
    }
    const required = yield* requiredRecords(id, props.app, hostname);
    const adapter = yield* DNS.resolve(dns);
    const published = yield* adapter
      .records(publishedRecordsId(hostname), {
        records: Output.map(required.records, (records) =>
          records.filter((record) => record.type === "CNAME"),
        ),
      })
      .pipe(Namespace.push(id));
    return yield* RoutingUrlRow(id, {
      ...rowProps,
      hostname: Output.map(Output.of(published as ResourceLike), () => requested),
      publishesRecords: true,
    });
  });

const RoutingUrlRow = Resource<RoutingUrl>("Prisma.RoutingUrl");

/**
 * The resource types {@link RoutingUrl} declares, for a provider collection
 * built by hand, e.g. `Provider.collection([...Prisma.RoutingUrlResources])`
 * with `Prisma.RoutingUrlProvider()`.
 */
export const RoutingUrlResources = [RoutingUrlRow, RoutingUrlRequiredRecords] as const;

const attrsFrom = (url: ApiRoutingUrl): RoutingUrl["Attributes"] => ({
  routingUrlId: url.id,
  branchId: url.branchId,
  serviceId: url.serviceId,
  hostname: url.hostname,
  logicalId: url.logicalId,
  status: url.status,
  state: url.state,
  conditions: url.conditions,
  firstUnmetCondition: url.firstUnmetCondition,
  records: url.records,
  ownershipExpiry: url.ownershipExpiry,
  heldBy: url.heldBy,
  customDomainSyncError: url.customDomainSyncError,
  certificateFailureReason: url.customDomain?.failureReason ?? null,
  setupUrl: url.setupUrl,
});

const serviceOf = (serviceId: string) =>
  Effect.gen(function* () {
    const service = (yield* getService({ serviceId })).data;
    if (service.branchId === null) return yield* notOnABranch(serviceId);
    return { ...service, branchId: service.branchId };
  });

type Service = Effect.Success<ReturnType<typeof serviceOf>>;

// A RoutingUrl's logicalId allows letters, digits, `.`, `-` and `_`, so a
// namespaced FQN (`Site/Url`) uses `.` between its segments.
const defaultLogicalId = (fqn: string) => fqn.replaceAll("/", ".");

const branchUrls = (service: Service, logicalId?: string) =>
  getProjectBranchUrls({
    projectId: service.projectId,
    branchId: service.branchId,
    ...(logicalId === undefined ? {} : { logicalId }),
  }).pipe(Effect.map((response) => response.data));

const getRoutingUrl = (id: string) =>
  getUrl({ id }).pipe(
    Effect.map((response) => response.data),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

/**
 * The row this RoutingUrl may take without `--adopt`: on its own service,
 * with its `logicalId`, or with no `logicalId` and its hostname (a row
 * Prisma's backfill, the Console or a custom domain made). A `logicalId` alone
 * proves nothing, because another stage or stack on the Branch can declare
 * the same one.
 */
const ownRow = (
  urls: ReadonlyArray<ApiRoutingUrl>,
  serviceId: string,
  hostname: string,
  logicalId: string,
) =>
  urls.find((url) => url.serviceId === serviceId && url.logicalId === logicalId) ??
  urls.find(
    (url) =>
      !hasLogicalId(url) &&
      url.serviceId === serviceId &&
      normalizeHostname(url.hostname) === hostname,
  );

/** Prisma's refusals of a RoutingUrl create or update, told apart by their error code. */
const refusals = (hostname: string, logicalId: string, serviceId: string) => ({
  RoutingUrlQuotaExceeded: (error: PrismaQuotaExceeded) =>
    Effect.fail(
      new RoutingUrlQuotaExceeded({
        message: `Prisma service '${serviceId}' already serves as many hostnames as its plan allows; '${hostname}' was not added.`,
        cause: error,
      }),
    ),
  RoutingUrlLogicalIdTaken: (error: PrismaLogicalIdTaken) =>
    Effect.fail(
      new RoutingUrlLogicalIdTaken({
        message: `Another Prisma RoutingUrl on the Branch has logicalId '${logicalId}'. Choose another logicalId.`,
        cause: error,
      }),
    ),
  RoutingUrlInvalidHostname: (error: PrismaInvalidHostname) =>
    Effect.fail(new RoutingUrlInvalidHostname({ message: error.message, cause: error })),
  Conflict: (error: Conflict) =>
    Effect.fail(new RoutingUrlOperationFailed({ message: error.message, cause: error })),
  UnprocessableEntity: (error: UnprocessableEntity) =>
    Effect.fail(new RoutingUrlOperationFailed({ message: error.message, cause: error })),
});

const createRefusals = (hostname: string, logicalId: string, serviceId: string) => ({
  ...refusals(hostname, logicalId, serviceId),
  RoutingUrlServiceNotOnABranch: (error: PrismaServiceNotOnABranch) =>
    Effect.fail(notOnABranch(serviceId, error)),
});

const updateRefusals = (hostname: string, logicalId: string, serviceId: string) => ({
  ...refusals(hostname, logicalId, serviceId),
  RoutingUrlServiceOnAnotherBranch: (error: PrismaServiceOnAnotherBranch) =>
    Effect.fail(new RoutingUrlServiceOnAnotherBranch({ message: error.message, cause: error })),
});

/** How long a deploy with `dns` waits for its published `CNAME` to reach every authoritative nameserver. */
const RECORDS_WAIT = Duration.minutes(3);

/**
 * Prisma looks the hostname's DNS up only when the row is written or checked.
 * A check orders a certificate only by retrying a failed one, or by
 * registering the first one, which the write would have made anyway. With no
 * custom domain there is nothing to retry, so one check per deploy is safe.
 */
const needsCheck = (url: ApiRoutingUrl) =>
  url.customDomain === null && url.state === "waiting_for_dns";

/**
 * One `/check`, never resent: a resend after a lost reply or a 429 can find
 * the certificate the first one ordered failed, and retry it. When the check
 * fails, the row is read instead.
 */
const checkOnce = (url: ApiRoutingUrl) =>
  createUrlCheck({ id: url.id }).pipe(
    Retry.none,
    Effect.map((response): ApiRoutingUrl => response.data),
    Effect.option,
    Effect.flatMap((checked) =>
      Option.isSome(checked)
        ? Effect.succeed(checked.value)
        : getUrl({ id: url.id }).pipe(Effect.map((response) => response.data)),
    ),
  );

/** A deploy that fails waiting for the `CNAME` commits no props, so the next deploy checks again. */
const checksAfterSave = (
  news: RoutingUrl["Props"],
  olds: RoutingUrl["Props"] | undefined,
  hostnameWritten: boolean,
) =>
  news.publishesRecords === true &&
  (hostnameWritten ||
    olds?.publishesRecords !== true ||
    normalizeHostname(olds.hostname) !== normalizeHostname(news.hostname));

const noDomainOwnershipWarning = (hostname: string) =>
  `No domain ownership covered '${hostname}' when it was saved. If this stack declares one, the hostname continues once that domain ownership is verified; otherwise declare Prisma.DomainOwnership or set createDomainOwnership: true.`;

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
        createsDomainOwnership: boolean,
      ) =>
        Effect.gen(function* () {
          const workspaceId = (yield* getProject({ id: service.projectId })).data.workspace.id;
          const covering = coveringDomainsOf(to);
          const rows = (yield* Effect.forEach(covering, (domain) =>
            getWorkspaceDomainOwnerships({ workspaceId, domain }).pipe(
              Effect.map((response) => response.data),
            ),
          )).flat();
          const verified = rows.some((row) => row.status === "verified");
          const createsExact =
            createsDomainOwnership && !rows.some((row) => normalizeHostname(row.domain) === to);
          const proofs = verified
            ? []
            : [
                ...rows.map((row) => row.verification),
                ...(createsExact
                  ? [
                      (yield* getWorkspaceDomainOwnershipsVerification({ workspaceId, domain: to }))
                        .data,
                    ]
                  : []),
              ];
          const visibilities = yield* Effect.forEach(proofs, (proof) =>
            checkRecord(
              { type: "TXT", name: proof.name, value: proof.value },
              { margin: "if-unseen", nameservers: "name", serversOf: to, attempts: "once" },
            ),
          );
          const ownership: RoutingUrlHostnameChangeRefused["ownership"] = verified
            ? "verified"
            : proofs.length === 0
              ? "noDomainOwnership"
              : visibilities.includes("seen")
                ? "seen"
                : visibilities.includes("unknown")
                  ? "unknown"
                  : "absent";
          const owned = ownership === "verified" || ownership === "seen";
          const target = switchboardTarget(service.appEndpointDomain);
          const dns = yield* checkSwitchboardDns(
            { name: to, switchboard: target },
            { margin: "if-unseen", nameservers: "name", attempts: owned ? "until-seen" : "once" },
          );
          if (owned && dns.visibility === "seen") return;
          const cnameMissing = dns.visibility !== "seen" && dns.cname === "absent";
          const records = [
            ...(owned
              ? []
              : proofs.map((proof) => ({
                  type: "TXT" as const,
                  name: proof.name,
                  value: proof.value,
                }))),
            ...(cnameMissing ? [{ type: "CNAME" as const, name: to, value: target }] : []),
          ];
          const txtNames = proofs.map((proof) => `TXT ${proof.name}`).join(" or ");
          const unowned = {
            verified: "",
            seen: "",
            noDomainOwnership: ` No domain ownership covers '${to}', so Prisma would look up no TXT record for it. Declare a Prisma.DomainOwnership that covers it and redeploy once it exists, or set createDomainOwnership: true.`,
            unknown: ` No verified domain ownership covers '${to}', and whether every authoritative nameserver answers ${txtNames} with the workspace's value could not be checked from this machine.`,
            absent: ` No verified domain ownership covers '${to}', and not every authoritative nameserver answers ${txtNames} with the workspace's value.`,
          }[ownership];
          const unchecked =
            dns.visibility !== "unknown"
              ? ""
              : cnameMissing
                ? ` '${to}' has no CNAME to ${target}, and whether its A or AAAA records include a switchboard address could not be checked from this machine.`
                : ` Whether '${to}' points at ${target} could not be checked from this machine.`;
          const publish =
            records.length > 0
              ? ` Publish ${records.map((record) => `${record.type} ${record.name} = ${record.value}`).join(" and ")}, then redeploy.${cnameMissing ? ` A hostname that cannot have a CNAME, such as a zone apex, can use an ALIAS, ANAME or flattened CNAME instead.` : ""}`
              : ownership === "noDomainOwnership"
                ? ""
                : " Redeploy once it can be checked.";
          return yield* new RoutingUrlHostnameChangeRefused({
            from,
            to,
            records,
            switchboardDns: dns.visibility,
            ownership,
            message: `Prisma RoutingUrl '${from}' is serving, and '${to}' cannot be shown to serve yet.${unowned}${unchecked}${publish}`,
          });
        });

      /**
       * Before Prisma looks at a hostname whose `CNAME` this deploy published,
       * wait for it to appear at its authoritative nameservers, and refuse
       * while it is still absent.
       */
      const awaitPublishedRecords = (
        service: Service,
        hostname: string,
        before: "create" | "hostnameChange" | "check",
      ) =>
        Effect.gen(function* () {
          const cname = {
            type: "CNAME" as const,
            name: hostname,
            value: switchboardTarget(service.appEndpointDomain),
          };
          const dns = yield* checkSwitchboardDns(
            { name: hostname, switchboard: cname.value },
            {
              margin: "if-unseen",
              nameservers: "name",
              attempts: "until-seen",
              waitFor: RECORDS_WAIT,
            },
          );
          if (dns.visibility !== "absent") return;
          const untouched = {
            create:
              "Prisma was not changed: the RoutingUrl was not created, and no certificate was ordered.",
            hostnameChange:
              "Prisma was not changed: the RoutingUrl's hostname was not changed, and no certificate was ordered.",
            check:
              "The RoutingUrl is saved in Prisma, but Prisma was not asked to look at its DNS, so no certificate was ordered.",
          }[before];
          return yield* new RoutingUrlRecordsNotSeen({
            hostname,
            records: [cname],
            message: `After ${Duration.toMinutes(RECORDS_WAIT)} minutes, not every authoritative nameserver for '${hostname}' answers with CNAME ${cname.name} = ${cname.value}, though the DNS host published it. ${untouched} Redeploy once it appears; if it never does, check that the domain is delegated to this DNS host at its registrar.`,
          });
        });

      /** The row a create resent after a lost reply made: same service, `logicalId` and hostname. */
      const rowMadeByResentCreate = (
        service: Service,
        serviceId: string,
        hostname: string,
        logicalId: string,
      ) =>
        branchUrls(service).pipe(
          Effect.map((urls) =>
            urls.find(
              (url) =>
                url.serviceId === serviceId &&
                url.logicalId === logicalId &&
                normalizeHostname(url.hostname) === hostname,
            ),
          ),
        );

      /**
       * Create or update the row `news` describes, and return it as Prisma
       * answered, with whether this deploy already saw its published records
       * and whether it created the row or changed its hostname.
       */
      const save = (
        fqn: string,
        news: RoutingUrl["Props"],
        output: RoutingUrl["Attributes"] | undefined,
      ) =>
        Effect.gen(function* () {
          const serviceId = yield* resolveServiceId(news.app);
          const hostname = normalizeHostname(news.hostname);
          const logicalId = news.logicalId ?? defaultLogicalId(fqn);
          const publishes = news.publishesRecords === true;
          const createDomainOwnership = news.createDomainOwnership ?? false;
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
            if (publishes) yield* awaitPublishedRecords(service, hostname, "create");
            const url = yield* createServiceUrl({
              serviceId,
              hostname,
              logicalId,
              createDomainOwnership,
            }).pipe(
              Effect.map((created) => created.data),
              Effect.catchTags(createRefusals(hostname, logicalId, serviceId)),
              Effect.catchTag(["RoutingUrlLogicalIdTaken", "RoutingUrlQuotaExceeded"], (refused) =>
                rowMadeByResentCreate(service, serviceId, hostname, logicalId).pipe(
                  Effect.flatMap((own) => (own ? Effect.succeed(own) : Effect.fail(refused))),
                ),
              ),
            );
            return { url, service, recordsSeen: publishes, hostnameWritten: true };
          }
          const change = {
            ...(normalizeHostname(observed.hostname) === hostname ? {} : { hostname }),
            ...(observed.serviceId === serviceId ? {} : { serviceId }),
            ...(observed.logicalId === logicalId ? {} : { logicalId }),
          };
          if (Object.keys(change).length === 0) {
            return { url: observed, service, recordsSeen: false, hostnameWritten: false };
          }
          if (change.hostname !== undefined && observed.status === "active") {
            yield* ensureCanServe(service, observed.hostname, hostname, createDomainOwnership);
          } else if (change.hostname !== undefined && publishes) {
            yield* awaitPublishedRecords(service, hostname, "hostnameChange");
          }
          const updated = yield* updateUrl({
            id: observed.id,
            ...change,
            createDomainOwnership,
          }).pipe(Effect.catchTags(updateRefusals(hostname, logicalId, serviceId)));
          return {
            url: updated.data,
            service,
            recordsSeen: publishes && change.hostname !== undefined,
            hostnameWritten: change.hostname !== undefined,
          };
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
          // A service on no Branch can have no RoutingUrl to find.
          const service = yield* serviceOf(serviceId).pipe(
            Effect.catchTag("RoutingUrlServiceNotOnABranch", () => Effect.undefined),
          );
          if (service === undefined) return undefined;
          const logicalId = olds.logicalId ?? defaultLogicalId(fqn);
          const found = ownRow(
            yield* branchUrls(service),
            serviceId,
            normalizeHostname(olds.hostname),
            logicalId,
          );
          if (found) return attrsFrom(found);
          const [claimed] = yield* branchUrls(service, logicalId);
          return claimed ? Unowned(attrsFrom(claimed)) : undefined;
        }),
        reconcile: Effect.fn(function* ({ fqn, news, olds, output }) {
          const { url, service, recordsSeen, hostnameWritten } = yield* save(fqn, news, output);
          const hostname = normalizeHostname(news.hostname);
          const current =
            news.createDomainOwnership === true && url.state === "no_domain_ownership"
              ? (yield* updateUrl({ id: url.id, createDomainOwnership: true }).pipe(
                  Effect.catchTags(
                    updateRefusals(hostname, news.logicalId ?? defaultLogicalId(fqn), service.id),
                  ),
                )).data
              : url;
          if (current.state === "no_domain_ownership") {
            yield* Effect.logWarning(noDomainOwnershipWarning(current.hostname));
          }
          if (!checksAfterSave(news, olds, hostnameWritten) || !needsCheck(current)) {
            return attrsFrom(current);
          }
          if (!recordsSeen) yield* awaitPublishedRecords(service, hostname, "check");
          return attrsFrom(yield* checkOnce(current));
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
    state: "active" as const,
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
    certificateFailureReason: null,
    setupUrl: null,
  }));

export const RoutingUrlProvider = () =>
  Layer.mergeAll(
    ProviderLayer.dual(RoutingUrlRow, {
      local: () => ProviderLocal(),
      live: () => ProviderLive(),
    }),
    RoutingUrlRequiredRecordsProvider(),
  );
