import { Query } from "@distilled.cloud/core/query";
import { Railway } from "@distilled.cloud/railway";
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Equivalence from "effect/Equivalence";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { withEnvironmentConfigLock } from "./transient.ts";

/**
 * What an image service takes when Railway finds a newer image.
 * `disabled` takes nothing, `patch` takes patch bumps of a semver tag,
 * `minor` takes minor and patch bumps.
 */
export const ImageUpdateType = Schema.Literals(["disabled", "patch", "minor"]);
export type ImageUpdateType = typeof ImageUpdateType.Type;

/**
 * How Railway compares tags. `semver` follows version tags; `sha` follows
 * the digest behind a mutable tag such as `latest`.
 */
export const ImageUpdateTagMode = Schema.Literals(["semver", "sha"]);
export type ImageUpdateTagMode = typeof ImageUpdateTagMode.Type;

const Hour = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 24 }));

/**
 * One weekly UTC window in which Railway may apply an image update.
 * `day` is the UTC weekday, `0` (Sunday) through `6` (Saturday).
 * `startHour` (inclusive, `0`-`23`) is before `endHour` (exclusive,
 * `1`-`24`). A window cannot cross midnight: use two windows on
 * consecutive days.
 */
export const ImageUpdateWindow = Schema.Struct({
  day: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })),
  startHour: Hour,
  endHour: Hour,
}).check(
  Schema.makeFilter(
    (window: { readonly startHour: number; readonly endHour: number }) =>
      window.startHour < window.endHour || "startHour must be before endHour",
  ),
);
export type ImageUpdateWindow = typeof ImageUpdateWindow.Type;

/** `source.autoUpdates` as Alchemy writes it. */
export const ImageUpdates = Schema.Struct({
  type: ImageUpdateType,
  tagMode: ImageUpdateTagMode.pipe(Schema.optional),
  schedule: ImageUpdateWindow.pipe(Schema.Array, Schema.optional),
});
export type ImageUpdates = typeof ImageUpdates.Type;

/**
 * `source.autoUpdates` as Railway reports it. Values are not narrowed: a
 * policy set in the dashboard may use a value Alchemy does not know, and
 * that compares as different from the desired one.
 */
const ObservedImageUpdates = Schema.Struct({
  type: Schema.String.pipe(Schema.NullOr, Schema.optional),
  tagMode: Schema.String.pipe(Schema.NullOr, Schema.optional),
  schedule: Schema.Array(
    Schema.Struct({ day: Schema.Number, startHour: Schema.Number, endHour: Schema.Number }),
  ).pipe(Schema.NullOr, Schema.optional),
});
export type ObservedImageUpdates = typeof ObservedImageUpdates.Type;

/** The slice of an environment config that holds `source.autoUpdates`. */
const ImageUpdatesConfig = Schema.Struct({
  services: Schema.Record(
    Schema.String,
    Schema.Struct({
      source: Schema.Struct({
        autoUpdates: ObservedImageUpdates.pipe(Schema.NullOr, Schema.optional),
      }).pipe(Schema.NullOr, Schema.optional),
    }).pipe(Schema.NullOr),
  ).pipe(Schema.NullOr, Schema.optional),
});

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

/** `desired` as a policy Railway accepts, or a typed failure saying why not. */
export const validateImageUpdates = (desired: unknown) =>
  Schema.decodeUnknownEffect(ImageUpdates)(desired).pipe(
    Effect.mapError(
      (error) =>
        new ServiceImageUpdatesInvalid({
          message: `Railway.Service \`imageUpdates\` is not a policy Railway accepts: ${error.message}`,
        }),
    ),
  );

/**
 * `source.autoUpdates` for `serviceId` inside an environment config. Empty
 * when Railway has none. Fails with a `SchemaError` when the config does not
 * have the expected shape.
 */
export const serviceImageUpdates = (config: unknown, serviceId: string) =>
  Schema.decodeUnknownEffect(ImageUpdatesConfig)(config).pipe(
    Effect.map(
      (decoded): ObservedImageUpdates => decoded.services?.[serviceId]?.source?.autoUpdates ?? {},
    ),
  );

type Window = { readonly day: number; readonly startHour: number; readonly endHour: number };

const windowOrder: Order.Order<Window> = Order.Struct({
  day: Order.Number,
  startHour: Order.Number,
  endHour: Order.Number,
});

/** Same windows, in any order. */
const sameSchedule: Equivalence.Equivalence<ReadonlyArray<Window>> = Equivalence.mapInput(
  Equivalence.Array(
    Equivalence.Struct({
      day: Equivalence.Number,
      startHour: Equivalence.Number,
      endHour: Equivalence.Number,
    }),
  ),
  (windows: ReadonlyArray<Window>) => Arr.sort(windows, windowOrder),
);

/**
 * The fields of `desired` that differ from `observed`, or `None` when
 * Railway already has them. A field left out of `desired` is not touched,
 * and a missing schedule counts as an empty one (any time).
 */
export const imageUpdatesPatch = (
  desired: ImageUpdates,
  observed: ObservedImageUpdates,
): Option.Option<{
  type?: ImageUpdateType;
  tagMode?: ImageUpdateTagMode;
  schedule?: Array<ImageUpdateWindow>;
}> => {
  const typeChanged = desired.type !== observed.type;
  const tagModeChanged = desired.tagMode !== undefined && desired.tagMode !== observed.tagMode;
  const scheduleChanged =
    desired.schedule !== undefined && !sameSchedule(desired.schedule, observed.schedule ?? []);
  if (!typeChanged && !tagModeChanged && !scheduleChanged) return Option.none();
  return Option.some({
    ...(typeChanged ? { type: desired.type } : {}),
    ...(tagModeChanged ? { tagMode: desired.tagMode } : {}),
    ...(scheduleChanged ? { schedule: [...(desired.schedule ?? [])] } : {}),
  });
};

interface ServiceTarget {
  readonly environmentId: string;
  readonly projectId: string;
  readonly serviceId: string;
}

const readEnvironmentConfig = Query.fn((args: { id: string; projectId?: string }) => ({
  config: Railway.environment(args).config,
}));

const environmentPatchCommit = Query.fn(
  (args: { environmentId: string; commitMessage: string; patch: unknown; skipDeploys: boolean }) =>
    Railway.environmentPatchCommit(args),
);

const readImageUpdates = (target: ServiceTarget) =>
  readEnvironmentConfig({
    id: target.environmentId,
    ...(target.projectId.length > 0 ? { projectId: target.projectId } : {}),
  }).pipe(
    Effect.flatMap((environment) => serviceImageUpdates(environment.config, target.serviceId)),
  );

/**
 * Converge `source.autoUpdates` to `desired` through
 * `environmentPatchCommit`, the write Railway's own IaC makes. Only fields
 * that differ are written, nothing is written when Railway already has the
 * policy, and the commit skips deploys: an update policy is not a reason to
 * redeploy. Waits until the environment config reports the policy, and
 * fails if it never does.
 */
export const syncServiceImageUpdates = Effect.fn(function* (
  // Validated with `validateImageUpdates` before any cloud call.
  input: ServiceTarget & { readonly desired: ImageUpdates },
) {
  const desired = input.desired;
  const applied = (observed: ObservedImageUpdates) =>
    Option.isNone(imageUpdatesPatch(desired, observed));

  const committed = yield* withEnvironmentConfigLock(
    input.environmentId,
    readImageUpdates(input).pipe(
      Effect.flatMap((observed) =>
        Option.match(imageUpdatesPatch(desired, observed), {
          onNone: () => Effect.succeed(false),
          onSome: (autoUpdates) =>
            environmentPatchCommit({
              environmentId: input.environmentId,
              commitMessage: "Set Railway image update policy",
              patch: { services: { [input.serviceId]: { source: { autoUpdates } } } },
              skipDeploys: true,
            }).pipe(Effect.as(true)),
        }),
      ),
    ),
  );
  if (!committed) return;

  yield* readImageUpdates(input).pipe(
    Effect.repeat({ until: applied, schedule: Schedule.spaced("1 second"), times: 10 }),
    Effect.filterOrFail(
      applied,
      (observed) =>
        new ServiceImageUpdatesNotApplied({
          serviceId: input.serviceId,
          environmentId: input.environmentId,
          observed,
        }),
    ),
  );
});
