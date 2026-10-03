import * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { FormulaVmSettings } from "./Formula.ts";

/** ARM namespace of Azure DevTest Labs. */
export const DEVTESTLAB_NAMESPACE = "Microsoft.DevTestLab";

/**
 * Generated name for a DevTest Labs resource: letters, digits, and `-`,
 * at most 50 characters (the lab limit; child names share it).
 */
export const createLabResourceName = (id: string, maxLength = 50) =>
  createPhysicalName({ id, maxLength });

const isArmId = (value: string) => value.toLowerCase().startsWith("/subscriptions/");

/**
 * True when any value set in `desired` differs from `observed`. Only the
 * keys present in `desired` are compared (recursively), so server-filled
 * read-only fields never count as drift. ARM IDs compare
 * case-insensitively.
 */
export const diverges = (desired: unknown, observed: unknown): boolean => {
  if (desired === undefined) return false;
  if (desired === null) return observed !== null && observed !== undefined;
  if (Array.isArray(desired)) {
    if (!Array.isArray(observed) || observed.length !== desired.length) {
      return true;
    }
    return desired.some((item, i) => diverges(item, observed[i]));
  }
  if (typeof desired === "object") {
    if (typeof observed !== "object" || observed === null) return true;
    return Object.entries(desired as Record<string, unknown>).some(
      ([key, value]) =>
        diverges(value, (observed as Record<string, unknown>)[key]),
    );
  }
  if (typeof desired === "string" && typeof observed === "string") {
    return isArmId(desired)
      ? desired.toLowerCase() !== observed.toLowerCase()
      : desired !== observed;
  }
  return desired !== observed;
};

/** Observe a lab; `undefined` when it does not exist. */
export const getLab = (
  subscriptionId: string,
  resourceGroupName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    devtestlabs.GetLab({ subscriptionId, resourceGroupName, name }),
  );

/**
 * Location of a lab. Every child of a lab must live in the lab's location,
 * so children inherit it instead of exposing their own.
 */
export const labLocation = (
  subscriptionId: string,
  resourceGroupName: string,
  labName: string,
) =>
  devtestlabs
    .GetLab({ subscriptionId, resourceGroupName, name: labName })
    .pipe(Effect.map((lab) => lab.location));

/** Daily, weekly, or hourly recurrence and notifications of a schedule. */
export interface ScheduleRecurrenceProps {
  /**
   * Whether the schedule is active.
   * @default "Enabled"
   */
  status?: "Enabled" | "Disabled";
  /** Run once a day at `time` (24-hour `HHmm`, e.g. `"1900"`). */
  dailyRecurrence?: { time: string };
  /**
   * Run on the given weekdays (`"Monday"`, ...) at `time` (24-hour `HHmm`).
   */
  weeklyRecurrence?: { weekdays: string[]; time: string };
  /** Run every hour at `minute`. */
  hourlyRecurrence?: { minute: number };
  /**
   * Windows time zone ID of the recurrence times, e.g. `"UTC"` or
   * `"Pacific Standard Time"`.
   * @default "UTC"
   */
  timeZoneId?: string;
  /** Notification sent before the scheduled task runs. */
  notificationSettings?: {
    /** Whether notifications are sent. */
    status?: "Enabled" | "Disabled";
    /** Minutes before the task to notify. */
    timeInMinutes?: number;
    /** Webhook that receives the notification. */
    webhookUrl?: string;
    /** Semicolon-separated email recipients. */
    emailRecipient?: string;
    /** Locale of the notification email, e.g. `"en"`. */
    notificationLocale?: string;
  };
}

/** Schedule properties sent on PUT. */
export const scheduleInput = (
  props: ScheduleRecurrenceProps & {
    taskType: string;
    targetResourceId?: string;
  },
): devtestlabs.SchedulePropertiesInput => ({
  status: props.status ?? "Enabled",
  taskType: props.taskType,
  dailyRecurrence: props.dailyRecurrence,
  weeklyRecurrence: props.weeklyRecurrence,
  hourlyRecurrence: props.hourlyRecurrence,
  timeZoneId: props.timeZoneId ?? "UTC",
  notificationSettings: props.notificationSettings,
  targetResourceId: props.targetResourceId,
});

/** Schedule attributes shared by every schedule resource. */
export interface ScheduleAttributes {
  /** Name of the schedule. */
  scheduleName: string;
  /** ARM resource ID of the schedule. */
  scheduleId: string;
  /** Task the schedule runs. */
  taskType: string;
  /** Whether the schedule is active. */
  status: string;
  /** Time zone of the recurrence times. */
  timeZoneId: string | undefined;
  /** Location of the schedule. */
  location: string;
  /** Unique immutable identifier (GUID) of the schedule. */
  uniqueIdentifier: string | undefined;
  /** User tags (Alchemy ownership tags stripped). */
  tags: Record<string, string>;
}

/** VM creation properties sent for formula content (password excluded). */
export const vmSettingsInput = (settings: FormulaVmSettings) => ({
  size: settings.size,
  galleryImageReference:
    settings.galleryImageReference === undefined
      ? undefined
      : { version: "latest", ...settings.galleryImageReference },
  customImageId: settings.customImageId,
  userName: settings.userName,
  sshKey: settings.sshKey,
  isAuthenticationWithSshKey: settings.isAuthenticationWithSshKey,
  labVirtualNetworkId: settings.labVirtualNetworkId,
  labSubnetName: settings.labSubnetName,
  disallowPublicIpAddress: settings.disallowPublicIpAddress,
  storageType: settings.storageType,
  allowClaim: settings.allowClaim,
  notes: settings.notes,
  artifacts: settings.artifacts,
});

