import {
  type CreateWorkspaceDomainOwnershipResponseData,
  createDomainOwnershipVerify,
  createWorkspaceDomainOwnership,
  deleteDomainOwnership,
  getDomainOwnership,
  getWorkspaceDomainOwnerships,
  getWorkspaceDomainOwnershipsVerification,
  getWorkspaces,
} from "@distilled.cloud/prisma/management";
import { AdoptPolicy, Unowned } from "alchemy/AdoptPolicy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type { Providers } from "../Providers.ts";
import { AuthoritativeRecordCheck } from "./AuthoritativeDns.ts";
import { DEV_TIMESTAMP, devId, devProvider } from "./DevStub.ts";
import {
  DomainOwnershipOperationFailed,
  normalizeDomain,
  PrismaDomainOwnershipRequired,
  type ProjectReference,
  resolveWorkspaceId,
  withoutRetriedCreate,
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
     * What Prisma reported when the deploy last proved the domain. An
     * unchanged redeploy does not check it again.
     */
    status: "unverified" | "verified" | "expiring";
    /** Prisma's deadline to publish the record again, while `expiring`, as last reported. */
    expiresAt: string | null;
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

interface VerificationRecord {
  readonly name: string;
  readonly value: string;
}

const ownershipRequired = (domain: string, record: VerificationRecord, reason: string) =>
  new PrismaDomainOwnershipRequired({
    hostname: domain,
    recordName: record.name,
    recordValue: record.value,
    message: `${reason} Publish a TXT record named '${record.name}' with value '${record.value}', keep it, and redeploy.`,
  });

const adoptAllowed = Effect.gen(function* () {
  return (
    Option.getOrUndefined(yield* Effect.serviceOption(AdoptPolicy)) ?? (yield* AlchemyContext).adopt
  );
});

/**
 * A domain ownership this resource did not record is taken only while it is
 * `unverified`, which grants nothing, or with `--adopt`.
 */
const claim = (ownership: ApiDomainOwnership) =>
  Effect.gen(function* () {
    if (ownership.status === "unverified" || (yield* adoptAllowed)) return ownership;
    return yield* new DomainOwnershipOperationFailed({
      message: `Prisma domain ownership '${ownership.id}' for '${ownership.domain}' is '${ownership.status}' and was not created by this resource. Redeploy with --adopt to take it over.`,
    });
  });

const createOwnership = (workspaceId: string, domain: string) =>
  Effect.gen(function* () {
    const created = yield* withoutRetriedCreate(
      createWorkspaceDomainOwnership({ workspaceId, domain }),
    );
    return created.httpStatus === 201 ? created.data : yield* claim(created.data);
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
      const checkRecord = yield* AuthoritativeRecordCheck;
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
          const recorded =
            domainOwnershipId === undefined ? undefined : yield* getOwnership(domainOwnershipId);
          if (recorded) return attrsFrom(recorded);
          if (typeof olds?.domain !== "string") return undefined;
          const workspaceId = yield* resolveWorkspaceId(olds.project);
          const existing = yield* findOwnership(workspaceId, normalizeDomain(olds.domain));
          if (!existing) return undefined;
          // An unverified domain ownership grants nothing, so taking it over
          // takes nothing from anyone. A verified or expiring one may keep
          // another stack's hostnames serving.
          return existing.status === "unverified"
            ? attrsFrom(existing)
            : Unowned(attrsFrom(existing));
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          const workspaceId = yield* resolveWorkspaceId(news.project);
          const domain = normalizeDomain(news.domain);
          const domainOwnershipId = isPrismaDevId(output?.domainOwnershipId)
            ? undefined
            : output?.domainOwnershipId;
          const recorded = domainOwnershipId ? yield* getOwnership(domainOwnershipId) : undefined;
          const found =
            recorded && normalizeDomain(recorded.domain) === domain
              ? recorded
              : yield* findOwnership(workspaceId, domain);
          const existing =
            found === undefined || found.id === domainOwnershipId ? found : yield* claim(found);
          if (existing?.status === "verified") return attrsFrom(existing);
          const record =
            existing?.verification ??
            (yield* getWorkspaceDomainOwnershipsVerification({ workspaceId, domain })).data;
          // Prisma looks the record up through a caching resolver, so it
          // must be visible at every authoritative nameserver first.
          // When the nameservers cannot be found or reached, Prisma's own
          // lookup decides.
          const visibility = yield* checkRecord(
            { type: "TXT", name: record.name, value: record.value },
            { margin: "always" },
          );
          if (visibility === "absent") {
            return yield* ownershipRequired(
              domain,
              record,
              `The authoritative nameservers for '${domain}' do not return its verification record yet.`,
            );
          }
          const ownership = existing ?? (yield* createOwnership(workspaceId, domain));
          if (normalizeDomain(ownership.domain) !== domain) {
            return yield* new DomainOwnershipOperationFailed({
              message: `Prisma recorded ownership of '${ownership.domain}', not the requested '${domain}'.`,
            });
          }
          const checked = yield* verifyOwnership(ownership);
          if (checked.status === "verified") return attrsFrom(checked);
          return yield* ownershipRequired(
            domain,
            checked.verification,
            `Prisma has not verified that this workspace owns '${domain}' (status '${checked.status}').`,
          );
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
    createdAt: DEV_TIMESTAMP,
  }));

export const DomainOwnershipProofProvider = () =>
  ProviderLayer.dual(DomainOwnershipProof, {
    local: () => ProviderLocal(),
    live: () => ProviderLive(),
  });
