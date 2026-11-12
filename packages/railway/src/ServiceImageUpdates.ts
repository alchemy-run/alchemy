import { Query } from "@distilled.cloud/core/query";
import { Railway } from "@distilled.cloud/railway";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { withEnvironmentConfigLock } from "./transient.ts";

/**
 * What an image service takes when Railway finds a newer image.
 * `disabled` takes nothing, `patch` takes patch bumps of a semver tag,
 * `minor` takes minor and patch bumps.
 */
export type ImageUpdateType = "disabled" | "patch" | "minor";

/**
 * How Railway compares tags. `semver` follows version tags; `sha` follows
 * the digest behind a mutable tag such as `latest`.
 */
export type ImageUpdateTagMode = "semver" | "sha";

/**
 * One weekly UTC window in which Railway may apply an image update.
 * A window cannot cross midnight: use two windows on consecutive days.
 */
export interface ImageUpdateWindow {
  /** UTC weekday, `0` (Sunday) through `6` (Saturday). */
  readonly day: number;
  /** UTC hour the window opens (inclusive), `0`-`23`. */
  readonly startHour: number;
  /** UTC hour the window closes (exclusive), `1`-`24`. Greater than `startHour`. */
  readonly endHour: number;
}

/** `source.autoUpdates` as Alchemy writes it. */
export interface ImageUpdates {
  readonly type: ImageUpdateType;
  readonly tagMode?: ImageUpdateTagMode;
  readonly schedule?: ReadonlyArray<ImageUpdateWindow>;
}

/**
 * `source.autoUpdates` as Railway reports it. Values are not narrowed: a
 * policy set in the dashboard may use a value Alchemy does not know, and
 * that compares as different from the desired one.
 */
export interface ObservedImageUpdates {
  readonly type?: string;
  readonly tagMode?: string;
  readonly schedule?: ReadonlyArray<ImageUpdateWindow>;
}

export class ServiceImageUpdatesInvalid extends Data.TaggedError(
  "Railway.ServiceImageUpdatesInvalid",
)<{ message: string }> {}

export class ServiceImageUpdatesNotApplied extends Data.TaggedError(
  "Railway.ServiceImageUpdatesNotApplied",
)<{
  serviceId: string;
  environmentId: string;
  observed: ObservedImageUpdates;
}> {
  override get message() {
    return `Railway service ${this.serviceId} did not report the requested image update policy after it was written (observed ${JSON.stringify(this.observed)}). Railway supports image auto-updates only for Docker Hub and GHCR images.`;
  }
}

class ServiceImageUpdatesPending extends Data.TaggedError("Railway.ServiceImageUpdatesPending")<{
  serviceId: string;
}> {}

const TYPES: ReadonlySet<string> = new Set<ImageUpdateType>(["disabled", "patch", "minor"]);
const TAG_MODES: ReadonlySet<string> = new Set<ImageUpdateTagMode>(["semver", "sha"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value);

/** The reason `desired` is not a policy Railway accepts, or `undefined`. */
export const invalidImageUpdates = (desired: ImageUpdates): string | undefined => {
  if (!TYPES.has(desired.type)) {
    return `Railway.Service \`imageUpdates.type\` must be "disabled", "patch" or "minor", got ${JSON.stringify(desired.type)}`;
  }
  if (desired.tagMode !== undefined && !TAG_MODES.has(desired.tagMode)) {
    return `Railway.Service \`imageUpdates.tagMode\` must be "semver" or "sha", got ${JSON.stringify(desired.tagMode)}`;
  }
  for (const [index, window] of (desired.schedule ?? []).entries()) {
    const { day, startHour, endHour } = window;
    if (
      !isInteger(day) ||
      !isInteger(startHour) ||
      !isInteger(endHour) ||
      day < 0 ||
      day > 6 ||
      startHour < 0 ||
      startHour > 23 ||
      endHour < 1 ||
      endHour > 24 ||
      endHour <= startHour
    ) {
      return `Railway.Service \`imageUpdates.schedule[${index}]\` must have day 0-6, startHour 0-23 and endHour 1-24 greater than startHour, got ${JSON.stringify(window)}`;
    }
  }
  return undefined;
};

const windowKey = (window: ImageUpdateWindow) =>
  `${window.day}:${window.startHour}:${window.endHour}`;

const sameSchedule = (
  left: ReadonlyArray<ImageUpdateWindow>,
  right: ReadonlyArray<ImageUpdateWindow>,
): boolean => {
  if (left.length !== right.length) return false;
  const a = left.map(windowKey).sort();
  const b = right.map(windowKey).sort();
  return a.every((key, index) => key === b[index]);
};

/** `source.autoUpdates` for `serviceId` inside an environment config. */
export const serviceImageUpdates = (config: unknown, serviceId: string): ObservedImageUpdates => {
  if (!isRecord(config)) return {};
  const services = config.services;
  if (!isRecord(services)) return {};
  const service = services[serviceId];
  if (!isRecord(service)) return {};
  const source = service.source;
  if (!isRecord(source)) return {};
  const autoUpdates = source.autoUpdates;
  if (!isRecord(autoUpdates)) return {};

  const schedule = Array.isArray(autoUpdates.schedule)
    ? autoUpdates.schedule.flatMap((entry: unknown) =>
        isRecord(entry) &&
        typeof entry.day === "number" &&
        typeof entry.startHour === "number" &&
        typeof entry.endHour === "number"
          ? [{ day: entry.day, startHour: entry.startHour, endHour: entry.endHour }]
          : [],
      )
    : undefined;
  return {
    ...(typeof autoUpdates.type === "string" ? { type: autoUpdates.type } : {}),
    ...(typeof autoUpdates.tagMode === "string" ? { tagMode: autoUpdates.tagMode } : {}),
    ...(schedule !== undefined ? { schedule } : {}),
  };
};

/**
 * The fields of `desired` that differ from `observed`, or `undefined` when
 * Railway already has them. A field left out of `desired` is not touched,
 * and a missing schedule counts as an empty one (any time).
 */
export const imageUpdatesPatch = (
  desired: ImageUpdates,
  observed: ObservedImageUpdates,
):
  | {
      type?: ImageUpdateType;
      tagMode?: ImageUpdateTagMode;
      schedule?: Array<ImageUpdateWindow>;
    }
  | undefined => {
  const typeChanged = desired.type !== observed.type;
  const tagModeChanged = desired.tagMode !== undefined && desired.tagMode !== observed.tagMode;
  const scheduleChanged =
    desired.schedule !== undefined && !sameSchedule(desired.schedule, observed.schedule ?? []);
  if (!typeChanged && !tagModeChanged && !scheduleChanged) return undefined;
  return {
    ...(typeChanged ? { type: desired.type } : {}),
    ...(tagModeChanged ? { tagMode: desired.tagMode } : {}),
    ...(scheduleChanged
      ? {
          schedule: (desired.schedule ?? []).map(({ day, startHour, endHour }) => ({
            day,
            startHour,
            endHour,
          })),
        }
      : {}),
  };
};

const readEnvironmentConfig = Query.fn((args: { id: string; projectId?: string }) => ({
  config: Railway.environment(args).config,
}));

const environmentPatchCommit = Query.fn(
  (args: { environmentId: string; commitMessage: string; patch: unknown; skipDeploys: boolean }) =>
    Railway.environmentPatchCommit(args),
);

const readImageUpdates = (input: { environmentId: string; projectId: string; serviceId: string }) =>
  readEnvironmentConfig(
    input.projectId.length > 0
      ? { id: input.environmentId, projectId: input.projectId }
      : { id: input.environmentId },
  ).pipe(Effect.map((environment) => serviceImageUpdates(environment.config, input.serviceId)));

/**
 * Converge `source.autoUpdates` to `desired` through
 * `environmentPatchCommit`, the write Railway's own IaC makes. Only fields
 * that differ are written, nothing is written when Railway already has the
 * policy, and the commit skips deploys: an update policy is not a reason to
 * redeploy. Waits until the environment config reports the policy, and
 * fails if it never does.
 */
export const syncServiceImageUpdates = Effect.fn(function* (input: {
  environmentId: string;
  projectId: string;
  serviceId: string;
  desired: ImageUpdates;
}) {
  const invalid = invalidImageUpdates(input.desired);
  if (invalid !== undefined) return yield* new ServiceImageUpdatesInvalid({ message: invalid });

  const patched = yield* withEnvironmentConfigLock(
    input.environmentId,
    Effect.gen(function* () {
      const patch = imageUpdatesPatch(input.desired, yield* readImageUpdates(input));
      if (patch === undefined) return false;
      yield* environmentPatchCommit({
        environmentId: input.environmentId,
        commitMessage: "Set Railway image update policy",
        patch: { services: { [input.serviceId]: { source: { autoUpdates: patch } } } },
        skipDeploys: true,
      });
      return true;
    }),
  );
  if (!patched) return;

  const check = readImageUpdates(input).pipe(
    Effect.flatMap((observed) =>
      imageUpdatesPatch(input.desired, observed) === undefined
        ? Effect.void
        : Effect.fail(new ServiceImageUpdatesPending({ serviceId: input.serviceId })),
    ),
  );
  yield* check.pipe(
    Effect.retry({
      while: (error) => error._tag === "Railway.ServiceImageUpdatesPending",
      schedule: Schedule.spaced("1 second"),
      times: 10,
    }),
    Effect.catchTag("Railway.ServiceImageUpdatesPending", () =>
      readImageUpdates(input).pipe(
        Effect.flatMap((observed) =>
          imageUpdatesPatch(input.desired, observed) === undefined
            ? Effect.void
            : Effect.fail(
                new ServiceImageUpdatesNotApplied({
                  serviceId: input.serviceId,
                  environmentId: input.environmentId,
                  observed,
                }),
              ),
        ),
      ),
    ),
  );
});
