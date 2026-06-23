import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  PrismaClient,
  isNotFound,
  type PrismaManagementClient,
} from "./Client.ts";
import type { ComputeService } from "./ComputeService.ts";
import type { Providers } from "./Providers.ts";
import {
  concreteIdsChanged,
  isInputObject,
  isPrismaDevId,
  resolveComputeServiceId,
  unresolvedComputeServiceIdOf,
} from "./Refs.ts";
import type { CustomDomain as ApiCustomDomain } from "./Types.ts";

export interface CustomDomainProps {
  /**
   * Compute service ID or `compute.computeServiceId` output that owns the domain.
   */
  computeService: string | ComputeService;
  /**
   * Hostname to attach to the compute service.
   */
  hostname: string;
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
     * Hostname attached to the compute service.
     */
    hostname: string;
    /**
     * Compute service ID that owns the domain.
     */
    computeServiceId: string;
    /**
     * Prisma normalized custom domain provisioning status.
     */
    status: ApiCustomDomain["status"];
    /**
     * Provider-level custom domain provisioning status.
     */
    providerStatus: ApiCustomDomain["providerStatus"];
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
 * A Prisma Compute custom domain.
 *
 * @section Creating a Custom Domain
 * @example Attach a hostname to a Compute service
 * ```typescript
 * const domain = yield* Prisma.CustomDomain("api-domain", {
 *   computeService: api.computeServiceId,
 *   hostname: "api.example.com",
 * });
 * ```
 */
export const CustomDomain = Resource<CustomDomain>("Prisma.CustomDomain");

const attrsFrom = (domain: ApiCustomDomain): CustomDomain["Attributes"] => ({
  customDomainId: domain.id,
  hostname: domain.hostname,
  computeServiceId: domain.computeServiceId,
  status: domain.status,
  providerStatus: domain.providerStatus,
  failureReason: domain.failureReason,
  failureCategory: domain.failureCategory,
  certExpiresAt: domain.certExpiresAt,
  dnsRecords: domain.dnsRecords,
  createdAt: domain.createdAt,
  updatedAt: domain.updatedAt,
});

const normalizeHostname = (hostname: string) =>
  hostname.trim().replace(/\.$/, "").toLowerCase();

const sameHostname = (left: string, right: string) =>
  normalizeHostname(left) === normalizeHostname(right);

const findDomain = (
  client: PrismaManagementClient,
  computeServiceId: string,
  hostname: string,
) =>
  client.listComputeServiceDomains(computeServiceId).pipe(
    Effect.catchIf(isNotFound, () => Effect.succeed([])),
    Effect.map((domains) =>
      domains.find((domain) => sameHostname(domain.hostname, hostname)),
    ),
  );

const ensureDefaultBranchService = (
  client: PrismaManagementClient,
  computeServiceId: string,
) =>
  Effect.gen(function* () {
    const service = yield* client.getComputeService(computeServiceId);
    if (!service.branchId) {
      return yield* Effect.fail(
        new Error(
          "Prisma custom domains can only be attached to Compute services on the default Branch.",
        ),
      );
    }
    const branch = yield* client
      .getBranch(service.branchId)
      .pipe(
        Effect.catchIf(isNotFound, () =>
          Effect.fail(
            new Error(
              `Unable to verify default Branch for Compute service ${computeServiceId}.`,
            ),
          ),
        ),
      );
    if (!branch.isDefault) {
      return yield* Effect.fail(
        new Error(
          "Prisma custom domains can only be attached to Compute services on the default Branch.",
        ),
      );
    }
  });

export const CustomDomainProvider = () =>
  Provider.effect(
    CustomDomain,
    Effect.gen(function* () {
      const client = yield* PrismaClient;
      return {
        stables: ["customDomainId"],
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isInputObject(news)) return undefined;
          if (isPrismaDevId(output?.customDomainId)) {
            return { action: "update" } as const;
          }
          const oldComputeServiceId = unresolvedComputeServiceIdOf(
            olds.computeService,
          );
          const newComputeServiceId = isResolved(news.computeService)
            ? unresolvedComputeServiceIdOf(news.computeService)
            : undefined;
          if (
            concreteIdsChanged(oldComputeServiceId, newComputeServiceId) ||
            (isResolved(news.hostname) &&
              normalizeHostname(news.hostname) !==
                normalizeHostname(olds.hostname))
          ) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ output, olds }) {
          const customDomainId = isPrismaDevId(output?.customDomainId)
            ? undefined
            : output?.customDomainId;
          const domain = customDomainId
            ? yield* client
                .getCustomDomain(customDomainId)
                .pipe(
                  Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
                )
            : yield* Effect.gen(function* () {
                const computeServiceId = unresolvedComputeServiceIdOf(
                  olds.computeService,
                );
                return computeServiceId
                  ? yield* findDomain(client, computeServiceId, olds.hostname)
                  : undefined;
              });
          return domain ? attrsFrom(domain) : undefined;
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          const computeServiceId = yield* resolveComputeServiceId(
            news.computeService,
          );
          const hostname = normalizeHostname(news.hostname);
          const customDomainId = isPrismaDevId(output?.customDomainId)
            ? undefined
            : output?.customDomainId;
          const domain = customDomainId
            ? yield* client
                .getCustomDomain(customDomainId)
                .pipe(
                  Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
                )
            : yield* findDomain(client, computeServiceId, hostname);
          if (!domain) {
            yield* ensureDefaultBranchService(client, computeServiceId);
          }
          return attrsFrom(
            domain ??
              (yield* client.createComputeServiceDomain(computeServiceId, {
                hostname,
              })),
          );
        }),
        delete: Effect.fn(function* ({ output }) {
          if (isPrismaDevId(output.customDomainId)) return;
          yield* client
            .deleteCustomDomain(output.customDomainId)
            .pipe(Effect.catchIf(isNotFound, () => Effect.void));
        }),
      };
    }),
  );
