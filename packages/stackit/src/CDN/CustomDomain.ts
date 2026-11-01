import * as cdn from "@distilled.cloud/stackit/cdn";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { normalizeDnsName } from "../DNS/internal.ts";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger, triggerProps } from "../internal/diff.ts";
import { secretsDiffer } from "../internal/equal.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import { isAlchemyOwned } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  CDN_POLL,
  CDN_TIMEOUT,
  type CdnError,
  errorSummary,
  getCustomDomainOrUndefined,
  listAllDistributions,
  STALE_POLLS,
  toCdnErrors,
} from "./internal.ts";

/** A certificate you bring. */
export interface CustomDomainCustomCertificate {
  /** Selects your own certificate. */
  type: "custom";
  /** The certificate as PEM. Alchemy encodes it the way the API expects. */
  certificate: string;
  /** Its private key as PEM. STACKIT never returns it. */
  privateKey: string | Redacted.Redacted<string>;
  /**
   * Skip the check that the domain already points at the distribution, so you can
   * move a live domain onto the CDN without downtime: add the domain, then change its
   * record. Only a custom certificate can skip the check.
   * @default false
   */
  skipDnsCheck?: boolean;
}

/** A certificate STACKIT provisions and renews with Let's Encrypt. */
export interface CustomDomainManagedCertificate {
  /** Selects the managed certificate. */
  type: "managed";
}

export interface CustomDomainProps {
  /** Id of the distribution, e.g. `distribution.distributionId`. Changing it replaces the domain. */
  distributionId: string;
  /** The domain, e.g. `www.example.com`. A trailing dot is ignored. Changing it replaces the domain. */
  domain: string;
  /**
   * Certificate served on the domain. Updated in place.
   * @default { type: "managed" }
   */
  certificate?: CustomDomainManagedCertificate | CustomDomainCustomCertificate;
  /**
   * Project of the distribution. Defaults to the profile's project. Changing it replaces
   * the domain.
   */
  projectId?: string;
}

export interface CustomDomainAttributes {
  /** The domain, lowercase and without a trailing dot. */
  domain: string;
  /** Id of the distribution. */
  distributionId: string;
  /** Project of the distribution. */
  projectId: string;
  /** Status; `ACTIVE` after a successful deploy. */
  status: string;
  /** Problems STACKIT reports on the domain. */
  errors: CdnError[];
  /** Kind of certificate in use. */
  certificateType: "managed" | "custom";
  /** Version of a custom certificate, raised by each new one. */
  certificateVersion: number | undefined;
  /** Whether a custom certificate skipped the DNS check. */
  skipDnsCheck: boolean;
}

export type CustomDomain = Resource<
  "Stackit.CDN.CustomDomain",
  CustomDomainProps,
  CustomDomainAttributes,
  never,
  Providers
>;

/**
 * A custom domain on a STACKIT CDN {@link Distribution}, with a certificate STACKIT
 * manages or one you bring. The domain's DNS record must point at the distribution's
 * `hostname` first, unless a custom certificate sets `skipDnsCheck`. Deploys retry for
 * about 5 minutes while the record propagates, and wait for `ACTIVE` for up to 10 minutes.
 *
 * The domain and distribution are its identity, so changing either replaces it. Moving
 * the same domain to another distribution removes it from the old one first. Only the
 * certificate updates in place.
 *
 * STACKIT's custom domains have no labels, so ownership is the row in Alchemy's state. A
 * domain already on the distribution with no state is reported as unowned and only taken
 * over with `--adopt`, which includes one left by a deploy that crashed before writing
 * its state.
 *
 * ### Adding a Domain
 * **Example:** A managed certificate, with the DNS record in a STACKIT zone
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Output from "alchemy/Output";
 *
 * const zone = yield* Stackit.DNS.Zone("Zone", { dnsName: "example.com" });
 * const cdn = yield* Stackit.CDN.Distribution("Cdn", {
 *   backend: { type: "http", originUrl: "https://origin.example.com" },
 * });
 * const record = yield* Stackit.DNS.RecordSet("Www", {
 *   zoneId: zone.zoneId,
 *   name: "www",
 *   type: "CNAME",
 *   records: [Output.interpolate`${cdn.hostname}.`],
 * });
 * const www = yield* Stackit.CDN.CustomDomain("WwwDomain", {
 *   distributionId: cdn.distributionId,
 *   domain: record.fqdn,
 * });
 * ```
 *
 * **Example:** A domain whose DNS lives elsewhere
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const cdn = yield* Stackit.CDN.Distribution("Cdn", {
 *   backend: { type: "http", originUrl: "https://origin.example.com" },
 * });
 * // Create `www.example.com CNAME <cdn.hostname>.` at your DNS provider first.
 * const www = yield* Stackit.CDN.CustomDomain("WwwDomain", {
 *   distributionId: cdn.distributionId,
 *   domain: "www.example.com",
 * });
 * ```
 *
 * ### Bringing a Certificate
 * **Example:** Your own certificate
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const certificate = yield* Config.string("WWW_CERTIFICATE_PEM");
 * const privateKey = yield* Config.redacted("WWW_PRIVATE_KEY_PEM");
 * const cdn = yield* Stackit.CDN.Distribution("Cdn", {
 *   backend: { type: "http", originUrl: "https://origin.example.com" },
 * });
 * const www = yield* Stackit.CDN.CustomDomain("WwwDomain", {
 *   distributionId: cdn.distributionId,
 *   domain: "www.example.com",
 *   certificate: { type: "custom", certificate, privateKey },
 * });
 * ```
 *
 * **Example:** Move a live domain without downtime
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const certificate = yield* Config.string("WWW_CERTIFICATE_PEM");
 * const privateKey = yield* Config.redacted("WWW_PRIVATE_KEY_PEM");
 * const cdn = yield* Stackit.CDN.Distribution("Cdn", {
 *   backend: { type: "http", originUrl: "https://origin.example.com" },
 * });
 * // Deploy this, repoint the DNS record at cdn.hostname, then remove `skipDnsCheck`
 * // or switch to a managed certificate.
 * const www = yield* Stackit.CDN.CustomDomain("WwwDomain", {
 *   distributionId: cdn.distributionId,
 *   domain: "www.example.com",
 *   certificate: { type: "custom", certificate, privateKey, skipDnsCheck: true },
 * });
 * ```
 *
 * ### Runtime Operations
 * **Example:** Report the domain's status from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Www = Stackit.CDN.CustomDomain("WwwDomain", {
 *   distributionId: "11111111-1111-4111-8111-111111111111",
 *   domain: "www.example.com",
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const getCustomDomain = yield* Stackit.CDN.GetCustomDomain(yield* Www);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { customDomain } = yield* getCustomDomain();
 *         return yield* HttpServerResponse.json({ status: customDomain.status });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.CDN.GetCustomDomainHttp)),
 * ) {}
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Moving a domain to another distribution
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // The domain is removed from the old distribution first, since one domain can't be on
 * // two, so it stops serving until the new one is ready.
 * const next = yield* Stackit.CDN.Distribution("Next", {
 *   backend: { type: "http", originUrl: "https://next.example.com" },
 * });
 * const www = yield* Stackit.CDN.CustomDomain("WwwDomain", {
 *   distributionId: next.distributionId,
 *   domain: "www.example.com",
 * });
 * ```
 *
 * @resource
 * @product STACKIT CDN
 * @category CDN
 */
export const CustomDomain = Resource<CustomDomain>("Stackit.CDN.CustomDomain");

const MANAGED: CustomDomainManagedCertificate = { type: "managed" };

/**
 * The DNS check while a record propagates: about 5 minutes, then the typed error
 * reaches the deployer.
 */
const CNAME_RETRY = { schedule: Schedule.spaced("30 seconds"), times: 10 } as const;

const isCnameMissing = (errors: ReadonlyArray<cdn.StatusError> | undefined) =>
  (errors ?? []).some((error) => error.key === "CUSTOM_DOMAIN_CNAME_MISSING");

const statesCustom = (
  certificate: cdn.GetCustomDomainResponseCertificate,
): certificate is cdn.GetCustomDomainCustomCertificate => certificate.type === "custom";

const toAttrs = (
  projectId: string,
  distributionId: string,
  { certificate, customDomain }: cdn.GetCustomDomainResponse,
): CustomDomainAttributes => ({
  domain: normalizeDnsName(customDomain.name),
  distributionId,
  projectId,
  status: customDomain.status,
  errors: toCdnErrors(customDomain.errors),
  certificateType: statesCustom(certificate) ? "custom" : "managed",
  certificateVersion: statesCustom(certificate) ? certificate.version : undefined,
  skipDnsCheck: statesCustom(certificate) ? certificate.skipDnsCheck : false,
});

/** The certificate as the API takes it: PEM, base64-encoded, as the Terraform provider sends it. */
const toPayload = (certificate: CustomDomainManagedCertificate | CustomDomainCustomCertificate) =>
  Effect.sync((): cdn.PutCustomDomainRequestCertificate => {
    if (certificate.type === "managed") return { type: "managed" };
    const base64 = (pem: string) => Buffer.from(pem, "utf8").toString("base64");
    const key = Redacted.isRedacted(certificate.privateKey)
      ? Redacted.value(certificate.privateKey)
      : certificate.privateKey;
    return {
      type: "custom",
      certificate: base64(certificate.certificate),
      key: Redacted.make(base64(key)),
      ...(certificate.skipDnsCheck !== undefined ? { skipDnsCheck: certificate.skipDnsCheck } : {}),
    };
  });

/**
 * Whether the observed certificate differs from the desired one. Neither the certificate
 * nor the key can be observed, so the previous props are all there is to compare.
 */
const certificateDrifted = (
  observed: cdn.GetCustomDomainResponseCertificate,
  desired: CustomDomainManagedCertificate | CustomDomainCustomCertificate,
  previous: CustomDomainProps["certificate"],
): boolean => {
  if (desired.type === "managed") return statesCustom(observed);
  if (!statesCustom(observed)) return true;
  if (observed.skipDnsCheck !== (desired.skipDnsCheck ?? false)) return true;
  if (previous?.type !== "custom") return true;
  return (
    previous.certificate !== desired.certificate ||
    secretsDiffer(previous.privateKey, desired.privateKey)
  );
};

const waitForGone = (
  projectId: string,
  distributionId: string,
  domain: string,
  startedDeleting: boolean,
) => {
  // An `ERROR` from before the delete can show once more. Only one seen after
  // `DELETING` is a failed delete.
  let sawDeleting = startedDeleting;
  return waitUntilGone({
    resource: `STACKIT CDN custom domain ${domain}`,
    read: getCustomDomainOrUndefined(projectId, distributionId, domain),
    failed: ({ customDomain }: cdn.GetCustomDomainResponse) => {
      if (customDomain.status === "DELETING") sawDeleting = true;
      return sawDeleting && customDomain.status === "ERROR"
        ? errorSummary(customDomain.errors, customDomain.status)
        : undefined;
    },
    state: ({ customDomain }: cdn.GetCustomDomainResponse) => customDomain.status,
    timeout: CDN_TIMEOUT,
    ...CDN_POLL,
  });
};

export const CustomDomainProvider = () =>
  Provider.succeed(CustomDomain, {
    stables: ["domain", "distributionId", "projectId"],
    // Delete order: custom domains go before their distribution.
    nuke: { dependsOn: ["Stackit.CDN.Distribution"] },

    // Custom domains have no labels, so nuke takes every one on a distribution Alchemy owns.
    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const distributions = yield* listAllDistributions(env.projectId);
      const domains: CustomDomainAttributes[] = [];
      for (const distribution of distributions) {
        if (!isAlchemyOwned(distribution.config.labels)) continue;
        for (const domain of distribution.domains) {
          if (domain.type !== "custom") continue;
          const custom = yield* getCustomDomainOrUndefined(
            env.projectId,
            distribution.id,
            domain.name,
          );
          if (custom !== undefined) {
            domains.push(toAttrs(env.projectId, distribution.id, custom));
          }
        }
      }
      return domains;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // A domain can't be on two distributions, and an unresolved prop can resolve to the
      // domain the old one holds: delete the old one first.
      if (
        hasUnresolvedTrigger<CustomDomainProps>(news, ["distributionId", "domain", "projectId"])
      ) {
        return { action: "replace", deleteFirst: true } as const;
      }
      const resolved = triggerProps<CustomDomainProps>(news);
      const env = yield* StackitEnvironment.current;
      const domain = normalizeDnsName(resolved.domain);
      if (
        domain !== output.domain ||
        resolved.distributionId !== output.distributionId ||
        (resolved.projectId ?? env.projectId) !== output.projectId
      ) {
        return { action: "replace", deleteFirst: domain === output.domain } as const;
      }
      // The certificate updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output, previous }) {
      const env = yield* StackitEnvironment.current;
      const projectId = output?.projectId ?? olds?.projectId ?? env.projectId;
      const distributionId = output?.distributionId ?? olds?.distributionId;
      const domain = output?.domain ?? (olds?.domain && normalizeDnsName(olds.domain));
      if (distributionId === undefined || domain === undefined) return undefined;
      const observed = yield* getCustomDomainOrUndefined(projectId, distributionId, domain);
      // Going away: reconcile waits it out and creates a new one.
      if (observed === undefined || observed.customDomain.status === "DELETING") return undefined;
      const attrs = toAttrs(projectId, distributionId, observed);
      // No labels: a row in state or the generation being replaced is ours, and anything
      // else on the distribution proves nothing. The generation being replaced has to match
      // on domain, distribution and project: the same domain elsewhere is someone else's.
      const isPrevious =
        previous?.domain === domain &&
        previous.distributionId === distributionId &&
        previous.projectId === projectId;
      return output !== undefined || isPrevious ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, olds, output }) {
      const env = yield* StackitEnvironment.current;
      const projectId = news.projectId ?? output?.projectId ?? env.projectId;
      const distributionId = news.distributionId;
      const domain = normalizeDnsName(news.domain);
      const desired = news.certificate ?? MANAGED;
      const resource = `STACKIT CDN custom domain ${domain}`;
      const read = cdn.getCustomDomain({ projectId, distributionId, domain });

      // 1. Observe. The distribution and domain are the API's key.
      let current = yield* getCustomDomainOrUndefined(projectId, distributionId, domain);
      if (current?.customDomain.status === "DELETING") {
        yield* waitForGone(projectId, distributionId, domain, true);
        current = undefined;
      }

      // 2. Ensure and sync: PUT is an upsert. A domain in `ERROR` is re-submitted too, so it
      // either recovers or the deploy fails.
      const versionBefore =
        current !== undefined && statesCustom(current.certificate)
          ? current.certificate.version
          : undefined;
      const submit =
        current === undefined ||
        current.customDomain.status === "ERROR" ||
        certificateDrifted(current.certificate, desired, olds?.certificate);
      if (submit) {
        const certificate = yield* toPayload(desired);
        yield* cdn.putCustomDomain({ projectId, distributionId, domain, certificate }).pipe(
          Effect.retry({
            while: (error) => error._tag === "CustomDomainCnameMissing",
            ...CNAME_RETRY,
          }),
        );
      }

      // Wait for `ACTIVE`. A read right after the PUT can still report the old certificate;
      // the version shows a new custom one landed, and anything else gets a few polls.
      let polls = 0;
      const applied = ({ certificate }: cdn.GetCustomDomainResponse) =>
        !submit ||
        polls > STALE_POLLS ||
        (desired.type === "custom"
          ? statesCustom(certificate) && certificate.version !== versionBefore
          : !statesCustom(certificate));
      const ready = yield* waitFor({
        resource,
        read,
        ready: (observed) => observed.customDomain.status === "ACTIVE" && applied(observed),
        failed: ({ customDomain }) => {
          polls++;
          if (customDomain.status === "DELETING") return "it is being deleted";
          if (customDomain.status !== "ERROR" || polls <= STALE_POLLS) return undefined;
          // The record may still be propagating: keep polling until the budget ends.
          return isCnameMissing(customDomain.errors)
            ? undefined
            : errorSummary(customDomain.errors, customDomain.status);
        },
        state: ({ customDomain }) =>
          customDomain.status === "ERROR"
            ? errorSummary(customDomain.errors, customDomain.status)
            : customDomain.status,
        timeout: CDN_TIMEOUT,
        ...CDN_POLL,
      });

      // 4. Return.
      return toAttrs(projectId, distributionId, ready);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { projectId, distributionId, domain } = output;
      const current = yield* getCustomDomainOrUndefined(projectId, distributionId, domain);
      if (current === undefined) return;
      const deleting = current.customDomain.status === "DELETING";
      if (!deleting) {
        yield* cdn
          .deleteCustomDomain({ projectId, distributionId, domain })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      }
      yield* waitForGone(projectId, distributionId, domain, deleting);
    }),
  });
