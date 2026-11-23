import { isThrottling } from "@distilled.cloud/core/category";
import {
  type CreateServiceDomainResponseData,
  createDomainRetry,
  createServiceDomain,
  deleteDomain,
  getDomain,
  getServiceDomains,
  getServiceUrls,
  getServices,
} from "@distilled.cloud/prisma/management";
import * as Retry from "@distilled.cloud/prisma/Retry";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { App } from "./App.ts";
import type { Compute } from "./Compute.ts";
import type { DomainOwnership } from "./DomainOwnership.ts";
import { AuthoritativeRecordCheck } from "./internal/AuthoritativeDns.ts";
import { DEV_TIMESTAMP, attrOrString, devId, devProvider } from "./internal/DevStub.ts";
import { ownershipRequiredOf } from "./internal/DomainOwnership.ts";
import { normalizeHostname, sameHostname } from "./internal/Hostname.ts";
import { PrismaPaginationError } from "./internal/Pagination.ts";
import { concreteIdOf, concreteIdsChanged, isInputObject, isPrismaDevId } from "./internal/Refs.ts";
import { hostnameHasLogicalId } from "./internal/RoutingUrl.ts";
import type { Providers } from "./Providers.ts";

/** A custom domain as the Management API returns it. */
type ApiCustomDomain = CreateServiceDomainResponseData;

export class CustomDomainConflict extends Data.TaggedError("CustomDomainConflict")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class CustomDomainInvalidProps extends Data.TaggedError("CustomDomainInvalidProps")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class CustomDomainOperationFailed extends Data.TaggedError("CustomDomainOperationFailed")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class CustomDomainUnexpectedResponse extends Data.TaggedError(
  "CustomDomainUnexpectedResponse",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

type AppReference = string | App | Compute;

export interface CustomDomainProps {
  /**
   * App ID or Compute output that owns the domain.
   */
  app: AppReference;
  /**
   * Hostname to attach to the app.
   */
  hostname: string;
  /**
   * Ownership that proves the workspace owns the hostname, exact or
   * wildcard. Passing it creates the domain after the proof.
   */
  ownership?: DomainOwnership;
}

export interface CustomDomain extends Resource<
  "Prisma.CustomDomain",
  CustomDomainProps,
  {
    /**
     * Prisma custom domain ID.
     */
    customDomainId: string;
    /**
     * Hostname attached to the app.
     */
    hostname: string;
    /**
     * Current app ID that owns the domain.
     */
    appId: string;
    /**
     * Prisma normalized custom domain provisioning status.
     */
    status: ApiCustomDomain["status"];
    /**
     * Raw custom-domain status returned by Foundry.
     */
    foundryStatus: string;
    /**
     * Failure reason returned by Prisma, when provisioning failed.
     */
    failureReason: string | null;
    /**
     * Failure category returned by Prisma, when provisioning failed.
     */
    failureCategory: ApiCustomDomain["failureCategory"];
    /**
     * Certificate expiration timestamp, when available.
     */
    certExpiresAt: string | null;
    /**
     * DNS records the hostname should point at.
     */
    dnsRecords: ApiCustomDomain["dnsRecords"];
    /**
     * ISO timestamp when the custom domain was created.
     */
    createdAt: string;
    /**
     * ISO timestamp when the custom domain was last updated.
     */
    updatedAt: string;
  },
  never,
  Providers
> {}

/**
 * A Prisma app custom domain.
 *
 * Prisma verifies the hostname's `CNAME` to the app's regional switchboard
 * (`switchboard.{region}.prisma.build`, listed in `dnsRecords`) when the
 * domain is created, so publish it first. Prisma also requires the workspace
 * to own the hostname; until it does, the deploy fails with
 * `PrismaDomainOwnershipRequired`, whose `recordName` and `recordValue` name
 * the record to publish. Creation then starts asynchronous certificate
 * provisioning; inspect `status`, `foundryStatus`, and `failureReason` before
 * routing production traffic.
 *
 * App and hostname changes are intentionally rejected because the Management
 * API cannot replace a live domain atomically. Create a second resource,
 * verify DNS and TLS, cut traffic over, and then remove the old resource.
 *
 * Prisma records a custom domain as a RoutingUrl, and has done so for every
 * custom domain since its backfill ran on 2026-11-17. To move a hostname to
 * `Prisma.RoutingUrl`, replace the CustomDomain with a RoutingUrl for the
 * same app and hostname in one deploy: the RoutingUrl takes over the row
 * Prisma recorded, and the CustomDomain's delete then leaves the hostname
 * serving.
 *
 * ### Creating a Custom Domain
 * **Example:** Attach a hostname to an app
 * ```typescript
 * const domain = yield* Prisma.CustomDomain("api-domain", {
 *   app: api.appId,
 *   hostname: "api.example.com",
 * });
 * ```
 *
 * @deprecated Prisma removes the custom domain routes about 2026-12-21. Use
 * `Prisma.RoutingUrl`.
 *
 * @resource
 * @product Compute
 */
export const CustomDomain = Resource<CustomDomain>("Prisma.CustomDomain");

const attrsFrom = (domain: ApiCustomDomain): CustomDomain["Attributes"] => ({
  customDomainId: domain.id,
  hostname: domain.hostname,
  appId: domain.appId,
  status: domain.status,
  foundryStatus: domain.foundryStatus,
  failureReason: domain.failureReason,
  failureCategory: domain.failureCategory,
  certExpiresAt: domain.certExpiresAt,
  dnsRecords: domain.dnsRecords,
  createdAt: domain.createdAt,
  updatedAt: domain.updatedAt,
});

export class PrismaCustomDomainAdoptionRequired extends Data.TaggedError(
  "PrismaCustomDomainAdoptionRequired",
)<{
  readonly message: string;
}> {}

const adoptionRequiredError = (hostname: string, appId: string, detail: string) =>
  new PrismaCustomDomainAdoptionRequired({
    message: `Prisma custom domain '${hostname}' ${detail} on App '${appId}' but is not owned by this resource. Import it with explicit adoption instead of silently taking it over.`,
  });

const appIdValue = (app: AppReference | undefined) => (typeof app === "string" ? app : app?.appId);

const unresolvedAppIdOf = (app: AppReference | undefined) => concreteIdOf(appIdValue(app));

const resolveAppId = (app: AppReference) => {
  const value = appIdValue(app);
  return typeof value === "string"
    ? Effect.succeed(value)
    : Effect.fail(new CustomDomainOperationFailed({ message: "Unable to resolve Prisma app id." }));
};

const findDomain = (appId: string, hostname: string) =>
  getServiceDomains({ serviceId: appId }).pipe(
    Effect.map((response) => response.data),
    Effect.catchTag("NotFound", () => Effect.succeed([])),
    Effect.flatMap((domains) => {
      const matches = domains.filter((domain) => sameHostname(domain.hostname, hostname));
      return matches.length > 1
        ? Effect.fail(
            new CustomDomainConflict({
              message: `Prisma app '${appId}' has multiple custom domains matching '${hostname}'; refusing to select one arbitrarily.`,
            }),
          )
        : Effect.succeed(matches[0]);
    }),
  );

/**
 * Prisma's spec does not say a resent create is harmless, so only throttled
 * requests, which Prisma did not process, are resent.
 */
const withoutRetriedCreate = Retry.policy({
  while: isThrottling,
  backoff: { baseMs: 1000, factor: 2, capMs: 5000, maxRetries: 8, jitterMs: 50, serverHint: true },
});

const getCustomDomain = (domainId: string) =>
  getDomain({ domainId }).pipe(
    Effect.map((response) => response.data),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

const listAllApps = Effect.gen(function* () {
  const apps: { readonly id: string }[] = [];
  let cursor: string | undefined;
  while (true) {
    const page = yield* getServices({ limit: 100, ...(cursor === undefined ? {} : { cursor }) });
    apps.push(...page.data);
    if (!page.pagination.hasMore) return apps;
    if (page.pagination.nextCursor === null) {
      return yield* new PrismaPaginationError({
        message: "Prisma listed more apps without a next cursor.",
      });
    }
    cursor = page.pagination.nextCursor;
  }
});

const ProviderLive = () =>
  Provider.effect(
    CustomDomain,
    Effect.gen(function* () {
      const checkRecord = yield* AuthoritativeRecordCheck;
      return {
        stables: ["customDomainId"],
        list: Effect.fn(function* () {
          const apps = yield* listAllApps;
          const domains = yield* Effect.forEach(
            apps,
            (app) =>
              getServiceDomains({ serviceId: app.id }).pipe(
                Effect.map((response) => response.data),
                Effect.catchTag("NotFound", () => Effect.succeed([])),
              ),
            { concurrency: 8 },
          );
          return domains.flat().map(attrsFrom);
        }),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isInputObject(news)) return undefined;
          if (isPrismaDevId(output?.customDomainId)) {
            return { action: "update" } as const;
          }
          const oldAppId = output?.appId ?? unresolvedAppIdOf(olds.app);
          const newAppId = isResolved(news.app)
            ? unresolvedAppIdOf(news.app as AppReference)
            : undefined;
          const oldHostname = normalizeHostname(output?.hostname ?? olds.hostname);
          const newHostname = isResolved(news.hostname)
            ? normalizeHostname(news.hostname)
            : undefined;
          if (
            concreteIdsChanged(oldAppId, newAppId) ||
            (newHostname !== undefined && newHostname !== oldHostname)
          ) {
            return yield* new CustomDomainInvalidProps({
              message: `Prisma cannot atomically replace custom domain '${oldHostname}' without risking traffic before the new domain is active. Create a second Prisma.CustomDomain logical resource, verify DNS/TLS and cut traffic over explicitly, then remove this resource.`,
            });
          }
          // A live failed Foundry attempt reaches the canonical retry endpoint
          // below. Each reconcile performs at most one retry and never polls.
          if (output?.status === "failed") {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ output, olds }) {
          const customDomainId = isPrismaDevId(output?.customDomainId)
            ? undefined
            : output?.customDomainId;
          const findDomainInApp = Effect.gen(function* () {
            const appId = unresolvedAppIdOf(olds.app);
            return appId ? yield* findDomain(appId, olds.hostname) : undefined;
          });
          const domain = customDomainId
            ? yield* getCustomDomain(customDomainId)
            : yield* findDomainInApp;
          if (!domain) return undefined;
          const attrs = attrsFrom(domain);
          return customDomainId === undefined ? Unowned(attrs) : attrs;
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          const appId = yield* resolveAppId(news.app);
          const hostname = normalizeHostname(news.hostname);
          const customDomainId = isPrismaDevId(output?.customDomainId)
            ? undefined
            : output?.customDomainId;
          const domain = customDomainId
            ? yield* getCustomDomain(customDomainId)
            : yield* findDomain(appId, hostname);
          const identityMatches = (domain: ApiCustomDomain) =>
            domain.appId === appId && sameHostname(domain.hostname, hostname);
          if (domain && !identityMatches(domain)) {
            return yield* new CustomDomainConflict({
              message: `Prisma custom domain '${customDomainId}' resolves to app '${domain.appId}' and hostname '${domain.hostname}', not requested app '${appId}' and hostname '${hostname}'. Refusing to claim convergence; replace the mismatched domain.`,
            });
          }
          if (domain && customDomainId === undefined) {
            return yield* adoptionRequiredError(hostname, appId, "already exists");
          }
          if (!domain) {
            yield* checkRecord(
              { type: "CNAME", name: hostname },
              { margin: "if-unseen", nameservers: "parent" },
            );
            const registeredDuringDnsWait = yield* findDomain(appId, hostname);
            if (registeredDuringDnsWait) {
              return yield* adoptionRequiredError(hostname, appId, "already exists");
            }
          }
          const reconciled = domain
            ? domain.status === "failed"
              ? (yield* createDomainRetry({ domainId: domain.id })).data
              : domain
            : yield* withoutRetriedCreate(createServiceDomain({ serviceId: appId, hostname })).pipe(
                // A CNAME or ownership TXT published moments earlier, e.g. in
                // the same deploy, may not be visible to Prisma's resolver yet.
                Effect.retry({
                  while: (error) =>
                    error._tag === "DomainDnsNotConfigured" ||
                    error._tag === "DomainOwnershipRequired",
                  schedule: Schedule.spaced("5 seconds"),
                  times: 6,
                }),
                Effect.catchTags({
                  DomainOwnershipRequired: (error) =>
                    Effect.fail(ownershipRequiredOf(error, hostname)),
                  Conflict: () =>
                    Effect.fail(
                      adoptionRequiredError(hostname, appId, "appeared after the adoption check"),
                    ),
                }),
                Effect.map((response) => response.data),
              );
          if (!identityMatches(reconciled)) {
            return yield* new CustomDomainUnexpectedResponse({
              message: `Prisma custom domain '${reconciled.id}' retry/create response resolves to app '${reconciled.appId}' and hostname '${reconciled.hostname}', not requested app '${appId}' and hostname '${hostname}'. Refusing to persist mismatched identity.`,
            });
          }
          return attrsFrom(reconciled);
        }),
        delete: Effect.fn(function* ({ output }) {
          const customDomainId = concreteIdOf(output.customDomainId);
          if (customDomainId === undefined) return;
          const domain = yield* getCustomDomain(customDomainId);
          if (!domain) return;
          if (domain.appId !== output.appId || !sameHostname(domain.hostname, output.hostname)) {
            return yield* new CustomDomainConflict({
              message: `Prisma custom domain '${customDomainId}' no longer matches app '${output.appId}' and hostname '${output.hostname}'. Refusing to delete a mismatched domain.`,
            });
          }
          const urls = yield* getServiceUrls({ serviceId: output.appId }).pipe(
            Effect.map((response) => response.data),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          );
          // Alchemy deletes removed resources after every create and update, so a
          // RoutingUrl that took this row over in the same deploy has already
          // written its logicalId.
          if (hostnameHasLogicalId(urls, output.hostname)) return;
          yield* deleteDomain({ domainId: customDomainId }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
      };
    }),
  );

const ProviderLocal = () =>
  devProvider(CustomDomain, ["customDomainId"], ({ id, news }) => ({
    customDomainId: devId("custom-domain", id),
    hostname: news.hostname,
    appId: attrOrString(news.app, "appId"),
    status: "active",
    foundryStatus: "active",
    failureReason: null,
    failureCategory: null,
    certExpiresAt: null,
    dnsRecords: [
      {
        type: "CNAME" as const,
        name: news.hostname,
        value: "localhost",
        ttl: null,
      },
    ],
    createdAt: DEV_TIMESTAMP,
    updatedAt: DEV_TIMESTAMP,
  }));

export const CustomDomainProvider = () =>
  ProviderLayer.dual(CustomDomain, {
    local: () => ProviderLocal(),
    live: () => ProviderLive(),
  });
