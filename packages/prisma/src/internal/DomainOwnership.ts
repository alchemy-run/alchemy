import { getProject } from "@distilled.cloud/prisma/management";
import {
  type CreateWorkspaceDomainOwnershipResponseData,
  type DomainOwnershipRequired,
  getWorkspaceDomainOwnerships,
} from "@distilled.cloud/prisma/unstable/management";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Project } from "../Project.ts";
import { normalizeHostname } from "./Hostname.ts";
import { PrismaPaginationError } from "./Pagination.ts";
import { concreteIdOf } from "./Refs.ts";

/**
 * Raised by `Prisma.CustomDomain` when Prisma has not verified that the
 * workspace owns the hostname. Publish a `TXT` record named `recordName` with
 * the value `recordValue`, keep it, then redeploy.
 */
export class PrismaDomainOwnershipRequired extends Data.TaggedError(
  "PrismaDomainOwnershipRequired",
)<{
  /** Hostname Prisma refused. */
  readonly hostname: string;
  /** Name of the `TXT` record to publish, e.g. `_prisma-verification.app.example.com`. */
  readonly recordName: string;
  /** Value of the `TXT` record to publish, e.g. `prisma-verification=<token>`. */
  readonly recordValue: string;
  readonly message: string;
}> {}

/** The `{ error: { verification } }` body of Prisma's `domain-ownership-required` 422. */
const OwnershipRejection = Schema.Struct({
  error: Schema.Struct({
    hint: Schema.optional(Schema.String),
    verification: Schema.Struct({ name: Schema.String, value: Schema.String }),
  }),
});

/** Name the record a `DomainOwnershipRequired` rejection asks for. */
export const ownershipRequiredOf = (error: DomainOwnershipRequired, hostname: string) => {
  const rejection = Schema.decodeUnknownOption(OwnershipRejection)(error.body);
  const recordName = Option.isSome(rejection)
    ? rejection.value.error.verification.name
    : `_prisma-verification.${hostname}`;
  const recordValue = Option.isSome(rejection) ? rejection.value.error.verification.value : "";
  return new PrismaDomainOwnershipRequired({
    hostname,
    recordName,
    recordValue,
    message: `Prisma requires proof that this workspace owns '${hostname}'. Publish a TXT record named '${recordName}'${recordValue ? ` with value '${recordValue}'` : ""}, keep it, and redeploy.${recordValue ? "" : ` ${error.message}`}`,
  });
};

export class DomainOwnershipOperationFailed extends Data.TaggedError(
  "DomainOwnershipOperationFailed",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** A Prisma Project resource, its ID, or an `{ projectId }` reference. */
export type ProjectReference = string | Project | { readonly projectId: string };

/** Workspace that owns `project`: read from the Project, or looked up by ID. */
export const resolveWorkspaceId = (project: ProjectReference) =>
  Effect.gen(function* () {
    const workspaceId =
      typeof project === "string" || !("workspaceId" in project)
        ? undefined
        : concreteIdOf(project.workspaceId as unknown);
    if (workspaceId !== undefined) return workspaceId;
    const projectId = concreteIdOf(
      typeof project === "string" ? project : (project.projectId as unknown),
    );
    if (projectId === undefined) {
      return yield* new DomainOwnershipOperationFailed({
        message: "Unable to resolve the Prisma project that owns the domain.",
      });
    }
    const response = yield* getProject({ id: projectId });
    return response.data.workspace.id;
  });

export type ApiDomainOwnership = CreateWorkspaceDomainOwnershipResponseData;

export const listOwnerships = (workspaceId: string, domain?: string) =>
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

export const findOwnership = (workspaceId: string, domain: string) =>
  listOwnerships(workspaceId, domain).pipe(
    Effect.map((ownerships) =>
      ownerships.find((ownership) => normalizeHostname(ownership.domain) === domain),
    ),
  );

/** Prisma names the `TXT` record of `*.example.com` after `example.com`, so a wildcard and its apex share one record. */
export const recordDomainOf = (domain: string) => domain.replace(/^\*\./, "");

/**
 * The domains whose domain ownership covers a normalized `hostname`: the
 * hostname itself, and the wildcard whose `*` stands for its first label
 * (`*.example.com` for `api.example.com`). A wildcard's base needs two
 * labels, and a wildcard does not cover its apex.
 */
export const coveringDomainsOf = (hostname: string): ReadonlyArray<string> => {
  const labels = hostname.split(".");
  return labels.length >= 3 ? [hostname, `*.${labels.slice(1).join(".")}`] : [hostname];
};

export const domainSharingRecordWith = (domain: string) =>
  domain.startsWith("*.") ? recordDomainOf(domain) : `*.${domain}`;

export const ensureSameWorkspace = (
  domain: string,
  recordedWorkspaceId: string | undefined,
  workspaceId: string,
) => {
  const recorded = concreteIdOf(recordedWorkspaceId);
  if (recorded === undefined || recorded === workspaceId) return Effect.void;
  return Effect.fail(
    new DomainOwnershipOperationFailed({
      message: `The domain ownership of '${domain}' belongs to workspace '${recorded}', but the project is now in workspace '${workspaceId}'. A domain ownership belongs to a workspace and does not move with a project. Point project back to a project in workspace '${recorded}', or remove this Prisma.DomainOwnership from the stack and deploy, which deletes it from workspace '${recorded}' unless it is retained, then declare it again.`,
    }),
  );
};

/**
 * What a domain ownership that is not verified means for the hostnames it
 * covers, by Prisma's rule for its status. `example` names one of them.
 */
export const notVerifiedWarning = (
  ownership: {
    readonly domain: string;
    readonly status: "unverified" | "expiring";
    readonly expiresAt: string | null;
    readonly recordName: string;
    readonly recordValue: string;
  },
  example?: string,
) => {
  const covered =
    example === undefined ? "hostnames it covers" : `hostnames it covers, such as '${example}',`;
  const record = `TXT ${ownership.recordName} = ${ownership.recordValue}`;
  return ownership.status === "expiring"
    ? `The domain ownership of '${ownership.domain}' is expiring. Of the ${covered}, those that already serve keep serving until Prisma lapses it after ${ownership.expiresAt ?? "its expiry"}, and none starts serving, unless ${record} is published or another verified domain ownership covers them.`
    : `The domain ownership of '${ownership.domain}' is unverified: it does not make ${covered} serve until Prisma finds ${record}, unless another verified domain ownership covers them.`;
};
