import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { Bucket } from "../Bucket.ts";
import type { ComputeService } from "../ComputeService.ts";
import type { Database } from "../Database.ts";
import type { Project } from "../Project.ts";

export class RefsOperationFailed extends Data.TaggedError("RefsOperationFailed")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type InputObject<T extends object> = {
  [Key in keyof T]: Input<T[Key]>;
};

export const isInputObject = <T extends object>(
  value: Input<T>,
): value is InputObject<T> & Input<T> =>
  typeof value === "object" && value !== null && !Output.isOutput(value) && !Effect.isEffect(value);

export const isPrismaDevId = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("dev:");

export const concreteIdOf = (value: unknown): string | undefined =>
  typeof value === "string" && !isPrismaDevId(value) ? value : undefined;

export const concreteIdsChanged = (oldId: string | undefined, newId: string | undefined) =>
  oldId !== undefined && newId !== undefined && newId !== oldId;

const resolveId = (label: string, value: unknown) =>
  typeof value === "string"
    ? Effect.succeed(value)
    : Effect.fail(new RefsOperationFailed({ message: `Unable to resolve Prisma ${label}.` }));

export const unresolvedProjectIdOf = (project: string | Project | undefined) =>
  concreteIdOf(typeof project === "string" ? project : (project?.projectId as unknown));

export const resolveProjectId = (project: string | Project) =>
  resolveId("project id", typeof project === "string" ? project : (project.projectId as unknown));

export const unresolvedDatabaseIdOf = (database: string | Database | undefined) =>
  concreteIdOf(typeof database === "string" ? database : (database?.databaseId as unknown));

export const resolveDatabaseId = (database: string | Database) =>
  resolveId(
    "database id",
    typeof database === "string" ? database : (database.databaseId as unknown),
  );

export const unresolvedBucketIdOf = (bucket: string | Bucket | undefined) =>
  concreteIdOf(typeof bucket === "string" ? bucket : (bucket?.bucketId as unknown));

export const resolveBucketId = (bucket: string | Bucket) =>
  resolveId("bucket id", typeof bucket === "string" ? bucket : (bucket.bucketId as unknown));

export const unresolvedServiceIdOf = (service: string | ComputeService | undefined) =>
  concreteIdOf(typeof service === "string" ? service : (service?.serviceId as unknown));

/**
 * A resource received no Compute service ID. On the first deploy after the
 * upgrade that renamed `Prisma.App`, a service whose saved state predates the
 * rename has no `serviceId` until it is reconciled once, and a version
 * attached with `Prisma.activateVersion` reads it before that.
 */
export class ComputeServiceIdUnavailable extends Data.TaggedError("ComputeServiceIdUnavailable")<{
  readonly message: string;
}> {}

export const serviceIdUnavailable = () =>
  new ComputeServiceIdUnavailable({
    message:
      "This resource received no Compute service ID. The service's saved state was written before Prisma.App was renamed Prisma.ComputeService, and Prisma.activateVersion makes the service and its version read each other before that state is rewritten. Deploy once with the renamed resources and without Prisma.activateVersion, so the service's state is rewritten, then add Prisma.activateVersion and deploy again.",
  });

export const resolveServiceId = (service: string | ComputeService | undefined) =>
  service === undefined
    ? Effect.fail(serviceIdUnavailable())
    : typeof service === "string"
      ? Effect.succeed(service)
      : typeof service.serviceId === "string"
        ? Effect.succeed(service.serviceId)
        : Effect.fail(serviceIdUnavailable());
