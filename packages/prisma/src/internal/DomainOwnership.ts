import type { DomainOwnershipRequired } from "@distilled.cloud/prisma/management";
import { getProject } from "@distilled.cloud/prisma/management";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Project } from "../Project.ts";
import { concreteIdOf } from "./Refs.ts";

/**
 * Prisma refused the hostname because this workspace has not proved it owns
 * it. Publish a `TXT` record named `recordName` with the value `recordValue`
 * (keep it — later domains on the same hostname reuse it), then redeploy.
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

/** Hostnames compare without case or a trailing dot. */
export const normalizeDomain = (domain: string) => domain.trim().replace(/\.$/, "").toLowerCase();
