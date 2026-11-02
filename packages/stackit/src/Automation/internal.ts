import * as automation from "@distilled.cloud/stackit/automation";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/**
 * Shared scaffolding of the Automation resources. Not exported from the namespace barrel.
 *
 * The spec's `x-stackit-authorization` names this service on every operation.
 */
export const AUTOMATION_SERVICE_ID = "cloud.stackit.automation";

/** The only template input kind the spec has. */
export const RECOVERY_POINT_KIND = "VolumeRecoveryPointManagement";

/** The spec sets no limit. This is the limit of a DNS label, so a generated name stays short. */
export const AUTOMATION_NAME_MAX_LENGTH = 63;

export interface AutomationScope {
  readonly projectId: string;
  readonly region: string;
}

/**
 * The name this generation of an automation gets when none is set. It ends in the instance
 * id, which makes it the only name that proves a found automation is ours.
 */
export const generatedAutomationName = (id: string, instanceId: string) =>
  createPhysicalName({
    id,
    instanceId,
    lowercase: true,
    maxLength: AUTOMATION_NAME_MAX_LENGTH,
  });

export const getAutomationOrUndefined = (scope: AutomationScope, automationId: string) =>
  automation
    .getVolumeAutomation({ ...scope, automationId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/** Every automation in a project and region, every page. A missing project holds none. */
export const listProjectAutomations = (scope: AutomationScope) =>
  automation.listVolumeAutomations.items({ ...scope, pageSize: 100 }).pipe(
    Stream.runCollect,
    Effect.map((items) => [...items]),
    Effect.catchTag("NotFound", () => Effect.succeed<automation.ListAutomationsItem[]>([])),
  );
