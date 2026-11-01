/**
 * Shared scaffolding for the STACKIT Intake resources. Not exported from the namespace
 * barrel.
 */
import * as intake from "@distilled.cloud/stackit/intake";
import * as Effect from "effect/Effect";
import { collectTokenPages, MAX_PAGE_SIZE } from "../internal/displayNames.ts";
import { isAlchemyOwned } from "../Labels.ts";

/** Where an Intake object lives: every API path carries both. */
export interface IntakeScope {
  projectId: string;
  region: string;
}

/** Runner budget (the Go SDK's wait handlers, 15 minutes). */
export const RUNNER_TIMEOUT = "15 minutes";
/** Intake budget (the Go SDK's wait handlers, 10 minutes). */
export const INTAKE_TIMEOUT = "10 minutes";
/** User budget (the Go SDK's wait handlers, 5 minutes). */
export const USER_TIMEOUT = "5 minutes";

/** Polling for an operation the Go SDK gives minutes. */
export const POLL = { interval: "2 seconds", maxInterval: "15 seconds" } as const;

/** The API's path parameters for a scope. */
export const onRegion = (scope: IntakeScope) => ({
  projectId: scope.projectId,
  regionId: scope.region,
});

/** `GetIntakeRunner`; `undefined` once the runner is gone. */
export const getRunnerOrUndefined = (scope: IntakeScope, intakeRunnerId: string) =>
  intake
    .getIntakeRunner({ ...onRegion(scope), intakeRunnerId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/** `GetIntake`; `undefined` once the intake is gone. */
export const getIntakeOrUndefined = (scope: IntakeScope, intakeId: string) =>
  intake
    .getIntake({ ...onRegion(scope), intakeId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/** Every runner of a project in a region. */
export const listRunners = (scope: IntakeScope) =>
  collectTokenPages(
    "STACKIT Intake runners",
    (pageToken) =>
      intake.listIntakeRunners({
        ...onRegion(scope),
        pageSize: MAX_PAGE_SIZE,
        ...(pageToken !== undefined ? { pageToken } : {}),
      }),
    (page) => page.intakeRunners,
  );

/** Every intake of a project in a region. */
export const listIntakes = (scope: IntakeScope) =>
  collectTokenPages(
    "STACKIT Intakes",
    (pageToken) =>
      intake.listIntakes({
        ...onRegion(scope),
        pageSize: MAX_PAGE_SIZE,
        ...(pageToken !== undefined ? { pageToken } : {}),
      }),
    (page) => page.intakes,
  );

/** Every intake Alchemy created in a project and region. */
export const listOwnedIntakes = (scope: IntakeScope) =>
  listIntakes(scope).pipe(
    Effect.map((intakes) => intakes.filter((item) => isAlchemyOwned(item.labels))),
  );

/** Every user of an intake. */
export const listIntakeUsers = (scope: IntakeScope, intakeId: string) =>
  collectTokenPages(
    "STACKIT Intake users",
    (pageToken) =>
      intake.listIntakeUsers({
        ...onRegion(scope),
        intakeId,
        pageSize: MAX_PAGE_SIZE,
        ...(pageToken !== undefined ? { pageToken } : {}),
      }),
    (page) => page.intakeUsers,
  );
