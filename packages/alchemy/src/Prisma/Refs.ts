import * as Effect from "effect/Effect";
import * as Output from "../Output.ts";
import type { ComputeService } from "./ComputeService.ts";
import type { Database } from "./Database.ts";
import type { Project } from "./Project.ts";

export const isPrismaDevId = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("dev:");

export const concreteIdOf = (value: unknown): string | undefined =>
  typeof value === "string" && !isPrismaDevId(value) ? value : undefined;

const resolveId = (label: string, value: unknown) =>
  Effect.gen(function* () {
    if (typeof value === "string") return value;
    if (Output.isOutput(value)) {
      const accessor = yield* value as Output.Output<string>;
      return yield* accessor;
    }
    return yield* Effect.fail(new Error(`Unable to resolve Prisma ${label}.`));
  });

export const unresolvedProjectIdOf = (project: string | Project | undefined) =>
  concreteIdOf(
    typeof project === "string" ? project : (project?.projectId as unknown),
  );

export const resolveProjectId = (project: string | Project) =>
  resolveId(
    "project id",
    typeof project === "string" ? project : (project.projectId as unknown),
  );

export const unresolvedDatabaseIdOf = (
  database: string | Database | undefined,
) =>
  concreteIdOf(
    typeof database === "string" ? database : (database?.databaseId as unknown),
  );

export const resolveDatabaseId = (database: string | Database) =>
  resolveId(
    "database id",
    typeof database === "string" ? database : (database.databaseId as unknown),
  );

export const unresolvedComputeServiceIdOf = (
  computeService: string | ComputeService | undefined,
) =>
  concreteIdOf(
    typeof computeService === "string"
      ? computeService
      : (computeService?.computeServiceId as unknown),
  );

export const resolveComputeServiceId = (
  computeService: string | ComputeService,
) =>
  resolveId(
    "compute service id",
    typeof computeService === "string"
      ? computeService
      : (computeService.computeServiceId as unknown),
  );
