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
  findOwnedTeamdrive,
  getTeamdrive,
  hasOwnershipMarker,
  ignoreMissing,
  jsonEqual,
  listOwnedTeamdrives,
  MAX_DRIVE_NAME_LENGTH,
  ownedByAlchemy,
  ownershipLabels,
  parseOwnership,
  restrictionsOf,
  sameText,
  toGeneratedName,
} from "./internal.ts";

export type TeamdriveProps = {
  /**
   * Team Drive id. Server-assigned on create. Immutable — changing it
   * replaces the Team Drive.
   */
  teamDriveId?: string;
  /**
   * Display name. Team Drives have no labels field, so Alchemy
   * ownership is stored in a `[alchemy …]` prefix and stripped from
   * attributes.
   */
  name?: string;
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
   * Restrictions. Applied after create.
   */
  restrictions?: DriveRestrictions;
  /**
   * Background image crop. Write-only; mutually exclusive with
   * `themeId`.
   */
  backgroundImageFile?: DriveBackgroundImageFile;
};

export type Teamdrive = Resource<
  "GCP.Drive.Teamdrive",
  TeamdriveProps,
  {
    /** Team Drive id. */
    teamDriveId: string;
    /** Project id used when the Team Drive was reconciled. */
    project: string;
    /** User-facing name with the Alchemy ownership prefix stripped. */
    name: string | undefined;
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
 * A Google Drive Team Drive (deprecated shared-drive API).
 *
 * Prefer `GCP.Drive.Drive`. Team Drives have no labels field, so Alchemy
 * stamps ownership into `name` for `list` / nuke. The Team Drive id is
 * identity. Name, color, and restrictions update in place. Creating a
 * Team Drive requires a Workspace account with shared-drive privileges.
 *
 * ### Creating a Team Drive
 * **Example:** Generated name
 * ```typescript
 * const team = yield* GCP.Drive.Teamdrive("Legacy", {});
 * ```
 *
 * **Example:** Named Team Drive
 * ```typescript
 * const team = yield* GCP.Drive.Teamdrive("Legacy", {
 *   name: "Archives",
 * });
 * ```
 *
 * ### Updating a Team Drive
 * **Example:** Rename
 * ```typescript
 * const team = yield* GCP.Drive.Teamdrive("Legacy", {
 *   teamDriveId: existing.teamDriveId,
 *   name: "Cold storage",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Drive
 */
export const Teamdrive = Resource<Teamdrive>("GCP.Drive.Teamdrive");

export class TeamdriveNotResolved extends Data.TaggedError(
  "GCP.Drive.TeamdriveNotResolved",
)<{
  teamDriveId: string;
}> {}

const toAttrs = (item: drive.TeamDrive, project: string) => ({
  teamDriveId: item.id ?? "",
  project,
  name: parseOwnership(item.name).text,
  colorRgb: item.colorRgb,
  restrictions: restrictionsOf(item.restrictions),
  orgUnitId: item.orgUnitId,
  backgroundImageLink: item.backgroundImageLink,
  createdTime: item.createdTime,
});

const refresh = (teamDriveId: string, fallback: drive.TeamDrive) =>
  getTeamdrive(teamDriveId).pipe(Effect.map((fresh) => fresh ?? fallback));

export const TeamdriveProvider = () =>
  Provider.succeed(Teamdrive, {
    stables: ["teamDriveId", "project", "createdTime", "orgUnitId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.teamDriveId ?? output?.teamDriveId;
      if (
        previousId !== undefined &&
        news.teamDriveId !== undefined &&
        news.teamDriveId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const teamDriveId = olds?.teamDriveId ?? output?.teamDriveId ?? "";
      let existing = yield* getTeamdrive(teamDriveId);
      if (existing === undefined) {
        existing = yield* findOwnedTeamdrive(id);
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
        const items = yield* listOwnedTeamdrives();
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
        output?.teamDriveId,
        63,
      );

      let current = yield* getTeamdrive(
        news.teamDriveId ?? output?.teamDriveId ?? "",
      );
      if (current === undefined) {
        current = yield* findOwnedTeamdrive(id);
      }

      if (current === undefined) {
        const created = yield* drive
          .createTeamdrives({
            requestId,
            body: {
              name,
              themeId: news.themeId,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => findOwnedTeamdrive(id)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new TeamdriveNotResolved({
          teamDriveId: news.teamDriveId ?? output?.teamDriveId ?? name,
        });
      }

      const teamDriveId =
        current.id ?? news.teamDriveId ?? output?.teamDriveId ?? "";
      const nameChanged = !sameText(current.name, name);
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
        colorChanged ||
        restrictionsChanged ||
        backgroundChanged ||
        themeChanged
      ) {
        current = yield* drive.updateTeamdrives({
          teamDriveId,
          body: {
            name,
            colorRgb: news.themeId === undefined ? news.colorRgb : undefined,
            themeId: news.colorRgb === undefined ? news.themeId : undefined,
            restrictions: news.restrictions,
            backgroundImageFile:
              news.themeId === undefined ? news.backgroundImageFile : undefined,
          },
        });
      }

      const fresh = yield* refresh(teamDriveId, current);
      return toAttrs(fresh, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.teamDriveId.length === 0) return;
      yield* ignoreMissing(
        drive.deleteTeamdrives({
          teamDriveId: output.teamDriveId,
        }),
      );
    }),
  });
