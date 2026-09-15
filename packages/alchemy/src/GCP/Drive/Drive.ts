import * as drive from "@distilled.cloud/gcp/drive_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  backgroundImageOf,
  type DriveBackgroundImageFile,
  type DriveRestrictions,
  encodeOwnershipLine,
  findOwnedDrive,
  getDrive,
  hasOwnershipMarker,
  ignoreMissing,
  jsonEqual,
  listOwnedDrives,
  MAX_DRIVE_NAME_LENGTH,
  ownedByAlchemy,
  ownershipLabels,
  parseOwnership,
  restrictionsOf,
  sameBoolean,
  sameText,
  toGeneratedName,
} from "./internal.ts";

export type DriveProps = {
  /**
   * Shared drive id. Server-assigned on create. Immutable — changing it
   * replaces the drive.
   */
  driveId?: string;
  /**
   * Display name. Shared drives have no labels field, so Alchemy
   * ownership is stored in a `[alchemy …]` prefix and stripped from
   * attributes.
   */
  name?: string;
  /**
   * Hide the shared drive from the default view.
   */
  hidden?: boolean;
  /**
   * Color as an RGB hex string. Mutually exclusive with `themeId` on
   * update.
   */
  colorRgb?: string;
  /**
   * Theme id (write-only). Set on create or on an update that does not
   * set `colorRgb`.
   */
  themeId?: string;
  /**
   * Restrictions. Cannot be set on create — applied on the first
   * update after the drive exists.
   */
  restrictions?: DriveRestrictions;
  /**
   * Background image crop. Write-only; mutually exclusive with
   * `themeId`.
   */
  backgroundImageFile?: DriveBackgroundImageFile;
};

export type Drive = Resource<
  "GCP.Drive.Drive",
  DriveProps,
  {
    /** Shared drive id. */
    driveId: string;
    /** Project id used when the drive was reconciled. */
    project: string;
    /** User-facing name with the Alchemy ownership prefix stripped. */
    name: string | undefined;
    /** Whether the drive is hidden from default view. */
    hidden: boolean;
    /** Color as an RGB hex string. */
    colorRgb: string | undefined;
    /** Restrictions. */
    restrictions: DriveRestrictions | undefined;
    /** Organizational unit id, when returned. */
    orgUnitId: string | undefined;
    /** Background image link. */
    backgroundImageLink: string | undefined;
    /** RFC3339 creation timestamp. */
    createdTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Drive shared drive.
 *
 * Shared drives have no labels field, so Alchemy stamps ownership into
 * `name` for `list` / nuke. The Drive id is identity — changing it
 * replaces the drive. Name, hidden, color, and restrictions update in
 * place. Creating a shared drive requires a Workspace account with
 * shared-drive privileges.
 *
 * ### Creating a Shared Drive
 * **Example:** Generated name
 * ```typescript
 * const shared = yield* GCP.Drive.Drive("Team", {});
 * ```
 *
 * **Example:** Named drive with restrictions
 * ```typescript
 * const shared = yield* GCP.Drive.Drive("Team", {
 *   name: "Engineering",
 *   restrictions: { driveMembersOnly: true },
 * });
 * ```
 *
 * ### Updating a Shared Drive
 * **Example:** Rename
 * ```typescript
 * const shared = yield* GCP.Drive.Drive("Team", {
 *   driveId: existing.driveId,
 *   name: "Platform",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Drive
 */
export const Drive = Resource<Drive>("GCP.Drive.Drive");

export class DriveNotResolved extends Data.TaggedError(
  "GCP.Drive.DriveNotResolved",
)<{
  driveId: string;
}> {}

const toAttrs = (item: drive.Drive, project: string) => ({
  driveId: item.id ?? "",
  project,
  name: parseOwnership(item.name).text,
  hidden: item.hidden === true,
  colorRgb: item.colorRgb,
  restrictions: restrictionsOf(item.restrictions),
  orgUnitId: item.orgUnitId,
  backgroundImageLink: item.backgroundImageLink,
  createdTime: item.createdTime,
});

const refresh = (driveId: string, fallback: drive.Drive) =>
  getDrive(driveId).pipe(Effect.map((fresh) => fresh ?? fallback));

export const DriveProvider = () =>
  Provider.succeed(Drive, {
    stables: ["driveId", "project", "createdTime", "orgUnitId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.driveId ?? output?.driveId;
      if (
        previousId !== undefined &&
        news.driveId !== undefined &&
        news.driveId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const driveId = olds?.driveId ?? output?.driveId ?? "";
      let existing = yield* getDrive(driveId);
      if (existing === undefined) {
        existing = yield* findOwnedDrive(id);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.name))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwnedDrives();
        return items
          .filter((item) => hasOwnershipMarker(item.name))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const labels = yield* ownershipLabels(id);
      const displayName = yield* toGeneratedName(id, news.name, output?.name);
      const name = encodeOwnershipLine(
        labels,
        displayName,
        MAX_DRIVE_NAME_LENGTH,
      );
      const requestId = yield* toGeneratedName(
        `${id}-req`,
        undefined,
        output?.driveId,
        63,
      );

      let current = yield* getDrive(news.driveId ?? output?.driveId ?? "");
      if (current === undefined) {
        current = yield* findOwnedDrive(id);
      }

      if (current === undefined) {
        const created = yield* drive
          .createDrives({
            requestId,
            body: {
              name,
              themeId: news.themeId,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => findOwnedDrive(id)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new DriveNotResolved({
          driveId: news.driveId ?? output?.driveId ?? name,
        });
      }

      const driveId = current.id ?? news.driveId ?? output?.driveId ?? "";
      const nameChanged = !sameText(current.name, name);
      const hiddenChanged =
        news.hidden !== undefined && !sameBoolean(current.hidden, news.hidden);
      const colorChanged =
        news.colorRgb !== undefined &&
        !sameText(current.colorRgb, news.colorRgb);
      const restrictionsChanged =
        news.restrictions !== undefined &&
        !jsonEqual(restrictionsOf(current.restrictions), news.restrictions);
      const backgroundChanged =
        news.backgroundImageFile !== undefined &&
        !jsonEqual(
          backgroundImageOf(current.backgroundImageFile),
          news.backgroundImageFile,
        );
      const themeChanged =
        news.themeId !== undefined && news.colorRgb === undefined;

      if (
        nameChanged ||
        hiddenChanged ||
        colorChanged ||
        restrictionsChanged ||
        backgroundChanged ||
        themeChanged
      ) {
        current = yield* drive.updateDrives({
          driveId,
          body: {
            name,
            hidden: news.hidden,
            colorRgb: news.themeId === undefined ? news.colorRgb : undefined,
            themeId: news.colorRgb === undefined ? news.themeId : undefined,
            restrictions: news.restrictions,
            backgroundImageFile:
              news.themeId === undefined ? news.backgroundImageFile : undefined,
          },
        });
      }

      const fresh = yield* refresh(driveId, current);
      return toAttrs(fresh, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.driveId.length === 0) return;
      yield* ignoreMissing(
        drive.deleteDrives({
          driveId: output.driveId,
        }),
      );
    }),
  });
