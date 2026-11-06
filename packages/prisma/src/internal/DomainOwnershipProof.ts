import {
  type CreateWorkspaceDomainOwnershipResponseData,
  createDomainOwnershipVerify,
  createWorkspaceDomainOwnership,
  deleteDomainOwnership,
  getDomainOwnership,
  getWorkspaceDomainOwnerships,
  getWorkspaces,
} from "@distilled.cloud/prisma/management";
import { Unowned } from "alchemy/AdoptPolicy";
import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { Providers } from "../Providers.ts";
import { waitForAuthoritativeRecord } from "./AuthoritativeDns.ts";
import { DEV_TIMESTAMP, devId, devProvider } from "./DevStub.ts";
import {
  DomainOwnershipOperationFailed,
  normalizeDomain,
  PrismaDomainOwnershipRequired,
  type ProjectReference,
  resolveWorkspaceId,
} from "./DomainOwnership.ts";
import { PrismaPaginationError } from "./Pagination.ts";
import { isInputObject, isPrismaDevId } from "./Refs.ts";

export interface DomainOwnershipProofProps {
  /** Project (or project ID) whose workspace proves ownership. */
  project: ProjectReference;
  /** An exact hostname such as `app.example.com`, or a wildcard such as `*.example.com`. */
  domain: string;
}

export interface DomainOwnershipProof extends Resource<
  "Prisma.DomainOwnership",
  DomainOwnershipProofProps,
  {
    /** Prisma domain ownership ID. */
    domainOwnershipId: string;
    /** Workspace that proved it owns the domain. */
    workspaceId: string;
    /** Domain the workspace owns. */
    domain: string;
    /** Name of the `TXT` record that proves ownership. */
    recordName: string;
    /** Value of the `TXT` record that proves ownership. */
    recordValue: string;
    /**
     * `verified` while Prisma finds the record. `expiring` once a verified
     * record is gone: hostnames already serving keep serving until
     * `expiresAt`. `unverified` otherwise.
     */
    status: "unverified" | "verified" | "expiring";
    /** ISO deadline to publish the record again, while `expiring`. */
    expiresAt: string | null;
    /** ISO timestamp when Prisma last found the record, while `verified`. */
    verifiedAt: string | null;
    /** ISO timestamp when the ownership was recorded. */
    createdAt: string;
  },
  never,
  Providers
> {}

export const DomainOwnershipProof = Resource<DomainOwnershipProof>("Prisma.DomainOwnership");

type ApiDomainOwnership = CreateWorkspaceDomainOwnershipResponseData;

const attrsFrom = (ownership: ApiDomainOwnership): DomainOwnershipProof["Attributes"] => ({
  domainOwnershipId: ownership.id,
  workspaceId: ownership.workspaceId,
  domain: ownership.domain,
  recordName: ownership.verification.name,
  recordValue: ownership.verification.value,
  status: ownership.status,
  expiresAt: ownership.expiresAt,
  verifiedAt: ownership.status === "verified" ? ownership.verificationRecordLastSeenAt : null,
  createdAt: ownership.createdAt,
});

const listOwnerships = (workspaceId: string, domain?: string) =>
  Effect.gen(function* () {
    const ownerships: ApiDomainOwnership[] = [];
    let cursor: string | undefined;
    while (true) {
      const page = yield* getWorkspaceDomainOwnerships({
        workspaceId,
        limit: 100,
        ...(domain === undefined ? {} : { domain }),
        ...(cursor === undefined ? {} : { cursor }),
      });
      ownerships.push(...page.data);
      if (!page.pagination.hasMore) return ownerships;
      if (page.pagination.nextCursor === null) {
        return yield* new PrismaPaginationError({
          message: `Prisma listed more domain ownerships for workspace '${workspaceId}' without a next cursor.`,
        });
      }
      cursor = page.pagination.nextCursor;
    }
  });

const findOwnership = (workspaceId: string, domain: string) =>
  listOwnerships(workspaceId, domain).pipe(
    Effect.map((ownerships) =>
      ownerships.find((ownership) => normalizeDomain(ownership.domain) === domain),
    ),
  );

const getOwnership = (domainOwnershipId: string) =>
  getDomainOwnership({ domainOwnershipId }).pipe(
    Effect.map((response) => response.data),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

const ownershipRequired = (ownership: ApiDomainOwnership) =>
  new PrismaDomainOwnershipRequired({
    hostname: ownership.domain,
    recordName: ownership.verification.name,
    recordValue: ownership.verification.value,
    message: `Prisma has not verified that this workspace owns '${ownership.domain}' (status '${ownership.status}'). Publish a TXT record named '${ownership.verification.name}' with value '${ownership.verification.value}', keep it, and redeploy.`,
  });

/** Ask Prisma to look the record up again until it reports `verified`. */
const verifyOwnership = (ownership: ApiDomainOwnership) =>
  ownership.status === "verified"
    ? Effect.succeed(ownership)
    : createDomainOwnershipVerify({ domainOwnershipId: ownership.id }).pipe(
        Effect.map((response) => response.data),
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (checked) => checked.status === "verified",
          times: 6,
        }),
      );

const ProviderLive = () =>
  Provider.effect(
    DomainOwnershipProof,
    Effect.gen(function* () {
      return {
        stables: ["domainOwnershipId", "workspaceId"],
        list: Effect.fn(function* () {
          const workspaces = yield* getWorkspaces({});
          const ownerships = yield* Effect.forEach(
            workspaces.data,
            (workspace) => listOwnerships(workspace.id),
            { concurrency: 4 },
          );
          return ownerships.flat().map(attrsFrom);
        }),
        diff: Effect.fn(function* ({ news, output }) {
          if (!output || !isInputObject(news) || typeof news.domain !== "string") {
            return undefined;
          }
          return normalizeDomain(news.domain) === normalizeDomain(output.domain)
            ? undefined
            : ({ action: "replace" } as const);
        }),
        read: Effect.fn(function* ({ output, olds }) {
          const domainOwnershipId = isPrismaDevId(output?.domainOwnershipId)
            ? undefined
            : output?.domainOwnershipId;
          if (domainOwnershipId !== undefined) {
            const ownership = yield* getOwnership(domainOwnershipId);
            return ownership ? attrsFrom(ownership) : undefined;
          }
          if (typeof olds?.domain !== "string") return undefined;
          // An ownership this resource did not record belongs to another
          // stack (or was proved by hand): deleting it would strip the
          // proof from every domain that relies on it.
          const workspaceId = yield* resolveWorkspaceId(olds.project);
          const existing = yield* findOwnership(workspaceId, normalizeDomain(olds.domain));
          return existing ? Unowned(attrsFrom(existing)) : undefined;
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          const workspaceId = yield* resolveWorkspaceId(news.project);
          const domain = normalizeDomain(news.domain);
          const domainOwnershipId = isPrismaDevId(output?.domainOwnershipId)
            ? undefined
            : output?.domainOwnershipId;
          const observed = domainOwnershipId
            ? yield* getOwnership(domainOwnershipId)
            : yield* findOwnership(workspaceId, domain);
          const existing =
            observed && normalizeDomain(observed.domain) === domain ? observed : undefined;
          if (existing?.status === "verified") return attrsFrom(existing);
          const ownership =
            existing ?? (yield* createWorkspaceDomainOwnership({ workspaceId, domain })).data;
          if (normalizeDomain(ownership.domain) !== domain) {
            return yield* new DomainOwnershipOperationFailed({
              message: `Prisma recorded ownership of '${ownership.domain}', not the requested '${domain}'.`,
            });
          }
          if (ownership.status !== "verified") {
            // Prisma looks the record up through a caching resolver.
            yield* waitForAuthoritativeRecord(
              {
                type: "TXT",
                name: ownership.verification.name,
                value: ownership.verification.value,
              },
              { margin: "always" },
            );
          }
          const checked = yield* verifyOwnership(ownership);
          if (checked.status === "verified") return attrsFrom(checked);
          // A domain ownership this deploy created and could not prove is
          // removed, so the next deploy does not find it Unowned.
          if (existing === undefined) {
            yield* deleteDomainOwnership({ domainOwnershipId: checked.id }).pipe(
              Effect.catchTag("NotFound", () => Effect.void),
            );
          }
          return yield* ownershipRequired(checked);
        }),
        delete: Effect.fn(function* ({ output }) {
          if (isPrismaDevId(output.domainOwnershipId)) return;
          yield* deleteDomainOwnership({ domainOwnershipId: output.domainOwnershipId }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
      };
    }),
  );

const ProviderLocal = () =>
  devProvider(DomainOwnershipProof, ["domainOwnershipId", "workspaceId"], ({ id, news }) => ({
    domainOwnershipId: devId("domain-ownership", id),
    workspaceId: "dev:workspace:local",
    domain: String(news.domain),
    recordName: `_prisma-verification.${String(news.domain).replace(/^\*\./, "")}`,
    recordValue: "prisma-verification=dev",
    status: "verified" as const,
    expiresAt: null,
    verifiedAt: DEV_TIMESTAMP,
    createdAt: DEV_TIMESTAMP,
  }));

export const DomainOwnershipProofProvider = () =>
  ProviderLayer.dual(DomainOwnershipProof, {
    local: () => ProviderLocal(),
    live: () => ProviderLive(),
  });
