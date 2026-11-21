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
import { Unowned } from "alchemy/AdoptPolicy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as DNS from "alchemy/DNS/Adapter";
import type { Input } from "alchemy/Input";
import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import { ProviderModePolicy } from "alchemy/ProviderMode";
import { Resource, type ResourceLike } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { AuthoritativeRecordCheck, SwitchboardDnsCheck } from "./internal/AuthoritativeDns.ts";
import { attrOrString, devId, devProvider } from "./internal/DevStub.ts";
import { isPlainHostname, normalizeHostname } from "./internal/Hostname.ts";
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
 * then redeploy. When `switchboardDns` or `ownership` is `unknown`, this
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
   * Whether the workspace was shown to own the new hostname: `verified` when
   * a domain ownership covers it, `seen` when every authoritative nameserver
   * answers its `TXT` record with the workspace's value, `absent` when one
   * answers without it, and `unknown` when this machine could not check.
   */
  readonly ownership: "verified" | "seen" | "absent" | "unknown";
}> {}

/**
 * With `dns`, the hostname does not serve, for one of three causes:
 * another RoutingUrl holds it (`heldBy`), which waiting does not change; its
 * certificate failed (`certificateFailure`), which only a retry from the
 * Console fixes; or it did not become `active` within 6 minutes, stopped on
 * `firstUnmetCondition`, and a redeploy waits again.
 */
export class RoutingUrlNotActive extends Data.TaggedError("RoutingUrlNotActive")<{
  readonly message: string;
  readonly routingUrlId: string;
  readonly hostname: string;
  /** The first condition not met, or null when Prisma has not yet marked a met RoutingUrl `active`. */
  readonly firstUnmetCondition: ApiRoutingUrl["firstUnmetCondition"];
  /** The error from Prisma's last sync with its custom domain, if any. */
  readonly customDomainSyncError: string | null;
  /** The RoutingUrl that holds the hostname, if another one does. */
  readonly heldBy: ApiRoutingUrl["heldBy"];
  /** Why the certificate failed, when it did; null otherwise. */
  readonly certificateFailure: string | null;
}> {}

/**
 * With `dns`, the hostname's published records did not appear at every
 * authoritative nameserver within about a minute, so the RoutingUrl was not
 * saved and no certificate was ordered. Redeploy once they appear.
 */
export class RoutingUrlRecordsNotSeen extends Data.TaggedError("RoutingUrlRecordsNotSeen")<{
  readonly message: string;
  readonly hostname: string;
  /** The published records an authoritative nameserver answered without. */
  readonly records: ReadonlyArray<{
    readonly type: "TXT" | "CNAME";
    readonly name: string;
    readonly value: string;
  }>;
}> {}

/**
 * With `dns`, Prisma cannot order the hostname's certificate yet: the
 * workspace reached its hourly limit of new certificates. Prisma continues on
 * its own at `resetAt`; a redeploy after then waits for the hostname to serve.
 */
export class RoutingUrlCertificateLimitReached extends Data.TaggedError(
  "RoutingUrlCertificateLimitReached",
)<{
  readonly message: string;
  readonly routingUrlId: string;
  readonly hostname: string;
  /** New certificates a workspace may order per hour. */
  readonly limit: number;
  /** When the limit resets, as Prisma reports it (ISO 8601). */
  readonly resetAt: string;
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
   * @default the resource's fully qualified name: `Site/Url` for
   * `Prisma.RoutingUrl("Url", …)` inside a `Prisma.Website` named `Site`
   */
  logicalId?: Input<string>;
  /**
   * DNS host that publishes the hostname's `TXT` and `CNAME` records, e.g.
   * `Cloudflare.DNS.Adapter()` (see
   * [DNS Adapters](/infrastructure-as-code/dns-adapters)). Omitted: publish
   * `records` yourself. Removing `dns` from a deployed RoutingUrl removes the
   * records it published; to publish them with another tool instead, publish
   * them there first: `_prisma-verification.<hostname>` with the workspace's
   * value, and the `CNAME` to the switchboard.
   */
  dns?: DNS.DnsConfig;
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
     * This deploy publishes the hostname's records through `dns`. The
     * provider then waits for them to appear before Prisma first looks at a
     * new hostname, and waits for the RoutingUrl to become `active`.
     */
    publishesRecords?: boolean;
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
 * Creating it needs no DNS: without `dns`, the deploy succeeds at once and
 * reports, in `records`, the `TXT` record that proves the workspace owns the
 * hostname and the `CNAME` to the regional switchboard. Prisma makes it `active` once both
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
 * new hostname stays `pending` behind `heldBy`, and with `dns` the deploy
 * fails with `RoutingUrlNotActive`.
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
 * removes them. A hostname that serves from another host today stops serving
 * there as soon as its `CNAME` is replaced; publish the records yourself to
 * move it. A create Prisma refuses leaves both records published until you
 * change or remove the RoutingUrl. A record already published with the same
 * value is treated as this RoutingUrl's, and destroy removes it. Nothing is
 * published under `alchemy dev`. A zone apex such as `example.com` needs a
 * DNS host that flattens a `CNAME` at the apex; at any other host, omit `dns`
 * and publish an ALIAS or ANAME yourself.
 *
 * With `dns`, the deploy waits until the hostname has served once: when the
 * RoutingUrl is created, when its hostname changes, and while it has never
 * been `active`. It waits up to about a minute for the new records to appear
 * at the hostname's authoritative nameservers, and fails with
 * `RoutingUrlRecordsNotSeen`, saving nothing, while one is still absent.
 * After saving, it asks Prisma to check once when Prisma has not seen the
 * records and holds no certificate for the hostname, then reads the
 * RoutingUrl every 10 seconds until it is `active`, for up to 6 minutes:
 * about 7 minutes in all. A certificate normally takes about 20 seconds, and
 * Prisma reads it again 3 minutes after ordering it. A RoutingUrl that served
 * and later reads `pending` reports it in `status` without failing a deploy.
 *
 * The wait fails with `RoutingUrlNotActive` when the 6 minutes run out,
 * naming the first unmet condition and Prisma's last sync error, and a
 * redeploy waits again. It fails at once with `RoutingUrlNotActive` when
 * another RoutingUrl holds the hostname (`heldBy`), and when the certificate
 * failed (`certificateFailure`): a redeploy does not retry it; retry it from
 * `setupUrl` in the Console, which orders a new certificate. It fails at once
 * with `RoutingUrlCertificateLimitReached` when the workspace has reached its
 * hourly limit of new certificates; Prisma continues on its own when the
 * limit resets, and a redeploy after then waits again. After each of these
 * failures the RoutingUrl is saved, and the next deploy finds it instead of
 * creating another.
 *
 * Prisma orders a certificate for each new hostname once its records are
 * published, for each hostname change, and again when an order fails or is
 * stuck. A workspace may order 10 an hour. A RoutingUrl created again after
 * it was deleted counts again, so count CI reruns and parallel jobs that
 * deploy to the same workspace.
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
      .records(publishedRecordsId(hostname), { records: required.records })
      .pipe(Namespace.push(id));
    return yield* RoutingUrlRow(id, {
      ...rowProps,
      hostname: Output.map(Output.of(published as ResourceLike), () => requested),
      publishesRecords: true,
    });
  });

/** `alchemy dev` publishes no DNS, unless the RoutingUrl is `Alchemy.remote()`. */
const publishesDns = Effect.gen(function* () {
  const context = yield* Effect.serviceOption(AlchemyContext);
  const dev = Option.isSome(context) && context.value.dev;
  return !dev || (yield* ProviderModePolicy) === true;
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
  conditions: url.conditions,
  firstUnmetCondition: url.firstUnmetCondition,
  records: url.records,
  ownershipExpiry: url.ownershipExpiry,
  heldBy: url.heldBy,
  customDomainSyncError: url.customDomainSyncError,
  setupUrl: url.setupUrl,
});

const serviceOf = (serviceId: string) =>
  Effect.gen(function* () {
    const service = (yield* getService({ serviceId })).data;
    if (service.branchId === null) return yield* notOnABranch(serviceId);
    return { ...service, branchId: service.branchId };
  });

type Service = Effect.Success<ReturnType<typeof serviceOf>>;

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

/** `*.example.com` for `api.example.com`; a wildcard's base needs two labels. */
const wildcardOf = (hostname: string) => {
  const labels = hostname.split(".");
  return labels.length >= 3 ? `*.${labels.slice(1).join(".")}` : undefined;
};

/**
 * How long a deploy with `dns` waits for its RoutingUrl to become `active`.
 * A certificate takes about 20 seconds, and Prisma reads it again only 180
 * seconds after ordering it; the rest is room for DNS propagation.
 */
const ACTIVE_WAIT = Duration.minutes(6);
const ACTIVE_POLL_INTERVAL = Duration.seconds(10);
const ACTIVE_POLLS = Duration.toMillis(ACTIVE_WAIT) / Duration.toMillis(ACTIVE_POLL_INTERVAL);

/**
 * Prisma reports its hourly certificate limit only as this
 * `customDomainSyncError` text, written by the control plane's
 * `certificateSlotWaitMessage`.
 */
const CERTIFICATE_LIMIT =
  /^The workspace has reached its hourly limit of (\d+) new certificates\. The limit resets at (\S+)\.$/;

const certificateLimitOf = (url: ApiRoutingUrl) => {
  const match = CERTIFICATE_LIMIT.exec(url.customDomainSyncError ?? "");
  return match ? { limit: Number(match[1]), resetAt: match[2]! } : undefined;
};

const holderOf = (heldBy: NonNullable<ApiRoutingUrl["heldBy"]>) =>
  heldBy.serviceId === null
    ? (heldBy.message ?? "held by another RoutingUrl")
    : `held by Prisma service '${heldBy.serviceId}'`;

const notActive = (url: ApiRoutingUrl) => {
  const reported =
    url.customDomainSyncError === null ? "" : ` Prisma reports: "${url.customDomainSyncError}".`;
  const certificateFailed = url.customDomain?.status === "failed";
  const unmet =
    url.firstUnmetCondition === null
      ? "every condition is met, but Prisma has not marked it active yet"
      : `its first unmet condition is ${url.firstUnmetCondition}`;
  const reason =
    url.heldBy !== null
      ? `is ${holderOf(url.heldBy)}, so it cannot become active until that RoutingUrl gives it up.${reported}`
      : certificateFailed
        ? `has a failed certificate: ${url.customDomain?.failureReason ?? "Prisma gave no reason"}.${reported} A redeploy does not retry it. Retry it in the Console${url.setupUrl === null ? "" : ` at ${url.setupUrl}`}; a retry orders a new certificate, which counts toward the workspace's hourly limit.`
        : `did not become active within ${Duration.toMinutes(ACTIVE_WAIT)} minutes: ${unmet}.${reported} Prisma keeps working on it; redeploy to wait again.`;
  return new RoutingUrlNotActive({
    routingUrlId: url.id,
    hostname: url.hostname,
    firstUnmetCondition: url.firstUnmetCondition,
    customDomainSyncError: url.customDomainSyncError,
    heldBy: url.heldBy,
    certificateFailure: certificateFailed
      ? (url.customDomain?.failureReason ?? "Prisma gave no reason")
      : null,
    message: `Prisma RoutingUrl '${url.hostname}' ${reason}`,
  });
};

/**
 * `url` once it is `active`, read every {@link ACTIVE_POLL_INTERVAL} up to
 * {@link ACTIVE_WAIT}. Fails at once when waiting cannot help: Prisma has
 * reached its hourly certificate limit, another RoutingUrl holds the
 * hostname, or the certificate failed.
 */
const untilActive = (
  url: ApiRoutingUrl,
  pollsLeft = ACTIVE_POLLS,
): Effect.Effect<
  ApiRoutingUrl,
  RoutingUrlNotActive | RoutingUrlCertificateLimitReached | Effect.Error<ReturnType<typeof getUrl>>,
  Effect.Services<ReturnType<typeof getUrl>>
> =>
  Effect.gen(function* () {
    if (url.status === "active") return url;
    const limited = certificateLimitOf(url);
    if (limited) {
      return yield* new RoutingUrlCertificateLimitReached({
        routingUrlId: url.id,
        hostname: url.hostname,
        ...limited,
        message: `Prisma RoutingUrl '${url.hostname}' cannot get its certificate yet: the workspace reached its hourly limit of ${limited.limit} new certificates, which resets at ${limited.resetAt}. Prisma continues on its own at that time; a redeploy after then waits for the hostname to serve.`,
      });
    }
    if (url.heldBy !== null || url.customDomain?.status === "failed" || pollsLeft <= 0) {
      return yield* notActive(url);
    }
    yield* Effect.sleep(ACTIVE_POLL_INTERVAL);
    return yield* untilActive((yield* getUrl({ id: url.id })).data, pollsLeft - 1);
  });

/**
 * Prisma looks the hostname's DNS up only when the row is written or checked.
 * A check orders a certificate only by retrying a failed one, or by
 * registering the first one, which the write would have made anyway. With no
 * custom domain there is nothing to retry, so one check per deploy is safe.
 */
const checkedOnceIfDnsMissed = (url: ApiRoutingUrl) =>
  url.customDomain === null &&
  (url.firstUnmetCondition === "ownershipVerified" ||
    url.firstUnmetCondition === "dnsPointsAtSwitchboard")
    ? createUrlCheck({ id: url.id }).pipe(Effect.map((response): ApiRoutingUrl => response.data))
    : Effect.succeed(url);

/** Whether this reconcile waits: the hostname has not served under this state yet. */
const waitsForActive = (news: RoutingUrl["Props"], output: RoutingUrl["Attributes"] | undefined) =>
  news.publishesRecords === true &&
  (output?.status !== "active" ||
    normalizeHostname(output.hostname) !== normalizeHostname(news.hostname));

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
        publishesRecords: boolean,
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
          const ownership =
            verification === undefined
              ? ("verified" as const)
              : yield* checkRecord(
                  { type: "TXT", name: verification.name, value: verification.value },
                  {
                    margin: "if-unseen",
                    nameservers: "name",
                    serversOf: to,
                    attempts: publishesRecords ? "until-seen" : "once",
                  },
                );
          const owned = ownership === "verified" || ownership === "seen";
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
          const unowned =
            owned || verification === undefined
              ? ""
              : ownership === "unknown"
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
            ownership,
            message: `Prisma RoutingUrl '${from}' is serving, and '${to}' cannot be shown to serve yet.${unowned}${unchecked}${publish}`,
          });
        });

      /**
       * Before Prisma checks a hostname whose records this deploy published,
       * wait up to about a minute for them to appear at its authoritative
       * nameservers, and refuse the write while one is still absent.
       */
      const awaitPublishedRecords = (service: Service, hostname: string) =>
        Effect.gen(function* () {
          const workspaceId = (yield* getProject({ id: service.projectId })).data.workspace.id;
          const verification = (yield* getWorkspaceDomainOwnershipsVerification({
            workspaceId,
            domain: hostname,
          })).data;
          const txt = { type: "TXT" as const, name: verification.name, value: verification.value };
          const cname = {
            type: "CNAME" as const,
            name: hostname,
            value: switchboardTarget(service.appEndpointDomain),
          };
          const options = {
            margin: "if-unseen",
            nameservers: "name",
            attempts: "until-seen",
          } as const;
          const [ownership, dns] = yield* Effect.all(
            [
              checkRecord(txt, { ...options, serversOf: hostname }),
              checkSwitchboardDns({ name: hostname, switchboard: cname.value }, options),
            ],
            { concurrency: "unbounded" },
          );
          const missing = [
            ...(ownership === "absent" ? [txt] : []),
            ...(dns.visibility === "absent" ? [cname] : []),
          ];
          if (missing.length === 0) return;
          return yield* new RoutingUrlRecordsNotSeen({
            hostname,
            records: missing,
            message: `Not every authoritative nameserver for '${hostname}' answers with ${missing.map((record) => `${record.type} ${record.name} = ${record.value}`).join(" and ")} yet, though the DNS host published ${missing.length === 1 ? "it" : "them"}. Nothing was saved in Prisma and no certificate was ordered; redeploy once ${missing.length === 1 ? "it appears" : "they appear"}.`,
          });
        });

      /** Create or update the row `news` describes, and return it as Prisma answered. */
      const save = (
        fqn: string,
        news: RoutingUrl["Props"],
        output: RoutingUrl["Attributes"] | undefined,
      ) =>
        Effect.gen(function* () {
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
            if (news.publishesRecords === true) yield* awaitPublishedRecords(service, hostname);
            const rowMadeByResentCreate = branchUrls(service).pipe(
              Effect.map((again) => ownRow(again, serviceId, hostname, logicalId)),
            );
            return yield* createServiceUrl({ serviceId, hostname, logicalId }).pipe(
              Effect.map((created) => created.data),
              Effect.catchTags(createRefusals(hostname, logicalId, serviceId)),
              Effect.catchTag("RoutingUrlLogicalIdTaken", (taken) =>
                rowMadeByResentCreate.pipe(
                  Effect.flatMap((own) => (own ? Effect.succeed(own) : Effect.fail(taken))),
                ),
              ),
            );
          }
          const change = {
            ...(normalizeHostname(observed.hostname) === hostname ? {} : { hostname }),
            ...(observed.serviceId === serviceId ? {} : { serviceId }),
            ...(observed.logicalId === logicalId ? {} : { logicalId }),
          };
          if (Object.keys(change).length === 0) return observed;
          if (change.hostname !== undefined && observed.status === "active") {
            yield* ensureCanServe(
              service,
              observed.hostname,
              hostname,
              news.publishesRecords === true,
            );
          } else if (change.hostname !== undefined && news.publishesRecords === true) {
            yield* awaitPublishedRecords(service, hostname);
          }
          const updated = yield* updateUrl({ id: observed.id, ...change }).pipe(
            Effect.catchTags(updateRefusals(hostname, logicalId, serviceId)),
          );
          return updated.data;
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
          const logicalId = olds.logicalId ?? fqn;
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
        reconcile: Effect.fn(function* ({ fqn, news, output }) {
          const saved = yield* save(fqn, news, output);
          if (!waitsForActive(news, output)) return attrsFrom(saved);
          return attrsFrom(yield* untilActive(yield* checkedOnceIfDnsMissed(saved)));
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

export const RoutingUrlProvider = () =>
  Layer.mergeAll(
    ProviderLayer.dual(RoutingUrlRow, {
      local: () => ProviderLocal(),
      live: () => ProviderLive(),
    }),
    RoutingUrlRequiredRecordsProvider(),
  );
