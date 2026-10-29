import {
  type CreateWorkspaceDomainOwnershipResponseData,
  createWorkspaceDomainOwnership,
  deleteDomainOwnership,
  getDomainOwnership,
  getWorkspaceDomainOwnerships,
  getWorkspaceDomainOwnershipsVerification,
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
  ownershipRequiredOf,
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
    /** Name of the `TXT` record that proved ownership. */
    recordName: string;
    /** Value of the `TXT` record that proved ownership. */
    recordValue: string;
    /** ISO timestamp when Prisma verified the record. */
    verifiedAt: string;
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
  verifiedAt: ownership.verifiedAt,
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
          if (observed && normalizeDomain(observed.domain) === domain) {
            return attrsFrom(observed);
          }
          const record = yield* getWorkspaceDomainOwnershipsVerification({ workspaceId, domain });
          // Proving looks the record up through Prisma's caching resolver.
          yield* waitForAuthoritativeRecord(
            { type: "TXT", name: record.data.name, value: record.data.value },
            { margin: "always" },
          );
          const proved = yield* createWorkspaceDomainOwnership({ workspaceId, domain }).pipe(
            Effect.retry({
              while: (error) => error._tag === "DomainOwnershipRequired",
              schedule: Schedule.spaced("5 seconds"),
              times: 6,
            }),
            Effect.catchTag("DomainOwnershipRequired", (error) =>
              Effect.fail(ownershipRequiredOf(error, domain)),
            ),
          );
          if (normalizeDomain(proved.data.domain) !== domain) {
            return yield* new DomainOwnershipOperationFailed({
              message: `Prisma recorded ownership of '${proved.data.domain}', not the requested '${domain}'.`,
            });
          }
          return attrsFrom(proved.data);
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
    verifiedAt: DEV_TIMESTAMP,
    createdAt: DEV_TIMESTAMP,
  }));

export const DomainOwnershipProofProvider = () =>
  ProviderLayer.dual(DomainOwnershipProof, {
    local: () => ProviderLocal(),
    live: () => ProviderLive(),
  });
