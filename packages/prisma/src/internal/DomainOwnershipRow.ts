import {
  createDomainOwnershipVerify,
  createWorkspaceDomainOwnership,
  deleteDomainOwnership,
  getDomainOwnership,
  getWorkspaceDomainOwnershipsVerification,
  getWorkspaces,
} from "@distilled.cloud/prisma/management";
import { Unowned } from "alchemy/AdoptPolicy";
import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { Providers } from "../Providers.ts";
import { AuthoritativeRecordCheck } from "./AuthoritativeDns.ts";
import { DEV_TIMESTAMP, devId, devProvider } from "./DevStub.ts";
import {
  type ApiDomainOwnership,
  DomainOwnershipOperationFailed,
  ensureSameWorkspace,
  findOwnership,
  listOwnerships,
  type ProjectReference,
  recordDomainOf,
  resolveWorkspaceId,
} from "./DomainOwnership.ts";
import { normalizeHostname } from "./Hostname.ts";
import { isInputObject, isPrismaDevId } from "./Refs.ts";

export interface DomainOwnershipRowProps {
  /** Project (or project ID) whose workspace owns the domain. */
  project: ProjectReference;
  /** An exact hostname such as `app.example.com`, or a wildcard such as `*.example.com`. */
  domain: string;
  /** The stack has published the row's `TXT` record. */
  publishesRecord?: boolean;
}

/** Props for `Prisma.DomainOwnership.lookup`: a domain ownership this stack does not manage. */
export interface DomainOwnershipLookup {
  /** Project (or project ID) whose workspace owns the domain ownership. */
  project: ProjectReference;
  /** The domain ownership's exact domain, such as `app.example.com` or `*.example.com`. */
  domain: string;
}

export interface DomainOwnershipRow extends Resource<
  "Prisma.DomainOwnership",
  DomainOwnershipRowProps,
  {
    /** Prisma domain ownership ID. */
    domainOwnershipId: string;
    /** Workspace that owns the domain. */
    workspaceId: string;
    /** Domain the workspace owns. */
    domain: string;
    /** Name of the `TXT` record that proves ownership. */
    recordName: string;
    /** Value of the `TXT` record that proves ownership. */
    recordValue: string;
    /** As Prisma reported it when the deploy last wrote or verified the row. */
    status: "unverified" | "verified" | "expiring";
    /** Prisma's deadline to publish the record again, while `expiring`, as last reported. */
    expiresAt: string | null;
    /** ISO timestamp when the ownership was recorded. */
    createdAt: string;
  },
  never,
  Providers,
  DomainOwnershipLookup
> {}

export const DomainOwnershipRow = Resource<DomainOwnershipRow>("Prisma.DomainOwnership");

const attrsFrom = (ownership: ApiDomainOwnership): DomainOwnershipRow["Attributes"] => ({
  domainOwnershipId: ownership.id,
  workspaceId: ownership.workspaceId,
  domain: ownership.domain,
  recordName: ownership.verification.name,
  recordValue: ownership.verification.value,
  status: ownership.status,
  expiresAt: ownership.expiresAt,
  createdAt: ownership.createdAt,
});

const deleteOwnership = (domainOwnershipId: string) =>
  deleteDomainOwnership({ domainOwnershipId }).pipe(Effect.catchTag("NotFound", () => Effect.void));

const getOwnership = (domainOwnershipId: string) =>
  getDomainOwnership({ domainOwnershipId }).pipe(
    Effect.map((response) => response.data),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

const createOwnership = (workspaceId: string, domain: string) =>
  Effect.gen(function* () {
    const created = (yield* createWorkspaceDomainOwnership({ workspaceId, domain })).data;
    if (normalizeHostname(created.domain) !== domain) {
      return yield* new DomainOwnershipOperationFailed({
        message: `Prisma recorded ownership of '${created.domain}', not the requested '${domain}'.`,
      });
    }
    return created;
  });

const VERIFY_GIVE_UPS = [
  "TooManyRequests",
  "InternalServerError",
  "BadGateway",
  "ServiceUnavailable",
  "GatewayTimeout",
] as const;

const verify = (ownership: ApiDomainOwnership, repeats: number) =>
  createDomainOwnershipVerify({ domainOwnershipId: ownership.id }).pipe(
    Effect.map((response) => response.data),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (checked) => checked.status === "verified",
      times: repeats,
    }),
    Effect.catchTag(VERIFY_GIVE_UPS, () => Effect.succeed(ownership)),
    Effect.catchTag("NotFound", () =>
      Effect.fail(
        new DomainOwnershipOperationFailed({
          message: `Prisma domain ownership '${ownership.id}' for '${ownership.domain}' was deleted during the deploy. Redeploy to create it again.`,
        }),
      ),
    ),
  );

const RECORD_WAIT = Duration.minutes(3);

const ProviderLive = () =>
  Provider.effect(
    DomainOwnershipRow,
    Effect.gen(function* () {
      const checkRecord = yield* AuthoritativeRecordCheck;

      // Prisma's create looks the record up, and its resolver caches a miss.
      const ensureWithPublishedRecord = (
        workspaceId: string,
        domain: string,
        existing: ApiDomainOwnership | undefined,
      ) =>
        Effect.gen(function* () {
          const record =
            existing?.verification ??
            (yield* getWorkspaceDomainOwnershipsVerification({ workspaceId, domain })).data;
          const visibility = yield* checkRecord(
            { type: "TXT", name: record.name, value: record.value },
            {
              margin: "always",
              nameservers: "parent",
              attempts: "until-seen",
              waitFor: RECORD_WAIT,
            },
          );
          const ownership = existing ?? (yield* createOwnership(workspaceId, domain));
          return visibility === "absent" || ownership.status === "verified"
            ? ownership
            : yield* verify(ownership, 6);
        });

      return {
        stables: ["workspaceId", "domain"],
        list: Effect.fn(function* () {
          const workspaces = yield* getWorkspaces({});
          const ownerships = yield* Effect.forEach(
            workspaces.data,
            (workspace) => listOwnerships(workspace.id),
            { concurrency: 4 },
          );
          return ownerships.flat().map(attrsFrom);
        }),
        lookup: Effect.fn(function* ({ project, domain }) {
          const workspaceId = yield* resolveWorkspaceId(project);
          const found = yield* findOwnership(workspaceId, normalizeHostname(domain));
          return found ? attrsFrom(found) : undefined;
        }),
        diff: Effect.fn(function* ({ news, output }) {
          if (!output || !isInputObject(news) || typeof news.domain !== "string") {
            return undefined;
          }
          return normalizeHostname(news.domain) === normalizeHostname(output.domain)
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
          const existing = yield* findOwnership(workspaceId, normalizeHostname(olds.domain));
          return existing ? Unowned(attrsFrom(existing)) : undefined;
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          const workspaceId = yield* resolveWorkspaceId(news.project);
          const domain = normalizeHostname(news.domain);
          yield* ensureSameWorkspace(domain, output?.workspaceId, workspaceId);
          const domainOwnershipId = isPrismaDevId(output?.domainOwnershipId)
            ? undefined
            : output?.domainOwnershipId;
          const recorded = domainOwnershipId ? yield* getOwnership(domainOwnershipId) : undefined;
          const existing =
            recorded && normalizeHostname(recorded.domain) === domain
              ? recorded
              : yield* findOwnership(workspaceId, domain);
          const ownership =
            existing?.status === "verified"
              ? existing
              : news.publishesRecord === true
                ? yield* ensureWithPublishedRecord(workspaceId, domain, existing)
                : existing
                  ? yield* verify(existing, 0)
                  : yield* createOwnership(workspaceId, domain);
          return attrsFrom(ownership);
        }),
        delete: Effect.fn(function* ({ output }) {
          if (isPrismaDevId(output.domainOwnershipId)) return;
          yield* deleteOwnership(output.domainOwnershipId);
        }),
      };
    }),
  );

const ProviderLocal = () =>
  devProvider(DomainOwnershipRow, ["domainOwnershipId", "workspaceId"], ({ id, news }) => ({
    domainOwnershipId: devId("domain-ownership", id),
    workspaceId: "dev:workspace:local",
    domain: String(news.domain),
    recordName: `_prisma-verification.${recordDomainOf(String(news.domain))}`,
    recordValue: "prisma-verification=dev",
    status: "verified" as const,
    expiresAt: null,
    createdAt: DEV_TIMESTAMP,
  }));

export const DomainOwnershipRowProvider = () =>
  ProviderLayer.dual(DomainOwnershipRow, {
    local: () => ProviderLocal(),
    live: () => ProviderLive(),
  });
