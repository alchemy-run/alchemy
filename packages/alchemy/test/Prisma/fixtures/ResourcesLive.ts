import {
  getBranch,
  getConnection,
  getDatabase,
  getEnvironmentVariable,
  getProjectBranches,
  getService,
} from "@distilled.cloud/prisma/management";
import * as Effect from "effect/Effect";
import { expectGone } from "./Live.ts";

/**
 * Out-of-band probes shared by the per-resource live suites
 * (`Project`, `Branch`, `Database`, `EnvironmentVariable`, `CustomDomain`).
 */

export const expectBranchGone = (branchId: string) =>
  expectGone(
    getBranch({ branchId }).pipe(
      Effect.as(false),
      Effect.catchTag("NotFound", () => Effect.succeed(true)),
    ),
  );

export const expectDatabaseGone = (databaseId: string) =>
  expectGone(
    getDatabase({ databaseId }).pipe(
      Effect.as(false),
      Effect.catchTag("NotFound", () => Effect.succeed(true)),
    ),
  );

export const expectConnectionGone = (id: string) =>
  expectGone(
    getConnection({ id }).pipe(
      Effect.as(false),
      Effect.catchTag("NotFound", () => Effect.succeed(true)),
    ),
  );

export const expectAppGone = (serviceId: string) =>
  expectGone(
    getService({ serviceId }).pipe(
      Effect.as(false),
      Effect.catchTag("NotFound", () => Effect.succeed(true)),
    ),
  );

export const expectEnvironmentVariableGone = (envVarId: string) =>
  expectGone(
    getEnvironmentVariable({ envVarId }).pipe(
      Effect.as(false),
      Effect.catchTag("NotFound", () => Effect.succeed(true)),
    ),
  );

export const observeBranch = (branchId: string) =>
  getBranch({ branchId }).pipe(Effect.map((response) => response.data));

export const observeDatabase = (databaseId: string) =>
  getDatabase({ databaseId }).pipe(Effect.map((response) => response.data));

export const observeEnvironmentVariable = (envVarId: string) =>
  getEnvironmentVariable({ envVarId }).pipe(Effect.map((response) => response.data));

/** The project's single default branch, observed out of band. */
export const observeDefaultBranch = (projectId: string) =>
  getProjectBranches({ projectId }).pipe(
    Effect.map((response) => response.data.filter((branch) => branch.isDefault)),
    Effect.flatMap((defaults) =>
      defaults.length === 1
        ? Effect.succeed(defaults[0]!)
        : Effect.die(new Error(`Expected one default branch, found ${defaults.length}`)),
    ),
  );
