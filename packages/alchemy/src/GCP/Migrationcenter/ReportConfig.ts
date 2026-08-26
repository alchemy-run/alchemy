import * as mc from "@distilled.cloud/gcp/migrationcenter_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_LOCATION,
  encodeOwnership,
  expandParent,
  fingerprint,
  hasOwnershipMarker,
  locationParent,
  normalizeLocation,
  ownedByAlchemy,
  parseName,
  parseOwnership,
  replaceOnIdentity,
  ResourceNotResolved,
  toPhysicalId,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type GroupPreferenceSetAssignment = {
  /** Group resource name or group id. */
  group: string;
  /** Preference set resource name or preference set id. */
  preferenceSet: string;
};

export type ReportConfigProps = {
  /**
   * Report config id (the `{reportConfig}` segment of
   * `projects/{project}/locations/{location}/reportConfigs/{reportConfig}`).
   * If omitted, a unique RFC1035 name is generated. Immutable — changing
   * it replaces the config.
   */
  reportConfigId?: string;
  /**
   * Region (`us-central1`, …). Immutable — changing it replaces the
   * config. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default "us-central1"
   */
  location?: string;
  /**
   * Combinations of groups and preference sets that reports generated
   * from this config evaluate. The API has no update method, so changing
   * assignments replaces the config.
   */
  groupPreferencesetAssignments: GroupPreferenceSetAssignment[];
  /**
   * User-friendly display name. Maximum length is 63 characters.
   */
  displayName?: string;
  /**
   * Free-text description. Report configs have no labels field, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  description?: string;
};

export type ReportConfig = Resource<
  "GCP.Migrationcenter.ReportConfig",
  ReportConfigProps,
  {
    /** Full resource name. */
    name: string;
    /** Report config id (last path segment). */
    reportConfigId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Group and preference-set combinations. */
    groupPreferencesetAssignments: GroupPreferenceSetAssignment[];
    /** User-friendly display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Migration Center report configuration that binds asset groups to
 * preference sets for TCO reports.
 *
 * Report configs have no labels field — Alchemy stamps ownership into the
 * description so `list` / nuke can find them. The API has no patch
 * method; changing assignments, display name, or description replaces the
 * config. Nested reports are force-deleted with the config.
 *
 * ### Creating a Report Config
 * **Example:** Bind a group to a preference set
 * ```typescript
 * const group = yield* GCP.Migrationcenter.Group("Workloads", {});
 * const prefs = yield* GCP.Migrationcenter.PreferenceSet("Prod", {});
 * const config = yield* GCP.Migrationcenter.ReportConfig("Tco", {
 *   displayName: "tco",
 *   groupPreferencesetAssignments: [
 *     { group: group.name, preferenceSet: prefs.name },
 *   ],
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Migrationcenter
 */
export const ReportConfig = Resource<ReportConfig>(
  "GCP.Migrationcenter.ReportConfig",
);

const resourceName = (
  project: string,
  location: string,
  reportConfigId: string,
) => `${locationParent(project, location)}/reportConfigs/${reportConfigId}`;

const assignmentsOf = (
  items: GroupPreferenceSetAssignment[],
  project: string,
  location: string,
): mc.ReportConfigGroupPreferenceSetAssignment[] =>
  items.map((item) => ({
    group: expandParent(item.group, project, location, "groups"),
    preferenceSet: expandParent(
      item.preferenceSet,
      project,
      location,
      "preferenceSets",
    ),
  }));

const toAssignments = (
  items: mc.ReportConfigGroupPreferenceSetAssignmentList | undefined,
): GroupPreferenceSetAssignment[] =>
  (items ?? [])
    .filter((item) => item.group && item.preferenceSet)
    .map((item) => ({
      group: item.group!,
      preferenceSet: item.preferenceSet!,
    }));

const toAttrs = (item: mc.ReportConfig, project: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "reportConfigs");
  const ownership = parseOwnership(item.description);
  return {
    name,
    reportConfigId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    groupPreferencesetAssignments: toAssignments(
      item.groupPreferencesetAssignments,
    ),
    displayName: item.displayName,
    description: ownership.text,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : mc
        .getProjectsLocationsReportConfigs({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  mc.listProjectsLocationsReportConfigs
    .pages({
      parent: `projects/${project}/locations/-`,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.reportConfigs ?? [])),
      Stream.filter((item) => hasOwnershipMarker(item.description)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag(["NotFound", "Forbidden"], () =>
        mc.listProjectsLocationsReportConfigs
          .pages({
            parent: locationParent(project, DEFAULT_LOCATION),
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.reportConfigs ?? []),
            ),
            Stream.filter((item) => hasOwnershipMarker(item.description)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag(["NotFound", "Forbidden"], () =>
              Effect.succeed([] as mc.ReportConfig[]),
            ),
          ),
      ),
    );

export const ReportConfigProvider = () =>
  Provider.succeed(ReportConfig, {
    stables: ["name", "reportConfigId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const payloadChanged =
        fingerprint({
          assignments: news.groupPreferencesetAssignments,
          displayName: news.displayName,
          description: news.description,
        }) !==
        fingerprint({
          assignments:
            olds?.groupPreferencesetAssignments ??
            output?.groupPreferencesetAssignments,
          displayName: olds?.displayName ?? output?.displayName,
          description: olds?.description ?? output?.description,
        });
      return replaceOnIdentity({
        previousId: olds?.reportConfigId ?? output?.reportConfigId,
        nextId:
          news.reportConfigId ?? olds?.reportConfigId ?? output?.reportConfigId,
        previousLocation: normalizeLocation(olds?.location ?? output?.location),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
        ),
        extra: payloadChanged,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const reportConfigId = yield* toPhysicalId(
        id,
        olds?.reportConfigId,
        output?.reportConfigId,
        "reportcfg",
      );
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name =
        output?.name ?? resourceName(env.project, location, reportConfigId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const reportConfigId = yield* toPhysicalId(
        id,
        news.reportConfigId,
        output?.reportConfigId,
        "reportcfg",
      );
      const location = normalizeLocation(news.location ?? output?.location);
      const name = resourceName(env.project, location, reportConfigId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const displayName = news.displayName ?? reportConfigId;
      const groupPreferencesetAssignments = assignmentsOf(
        news.groupPreferencesetAssignments,
        env.project,
        location,
      );

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* mc
          .createProjectsLocationsReportConfigs({
            parent: locationParent(env.project, location),
            reportConfigId,
            body: {
              displayName,
              description,
              groupPreferencesetAssignments,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* mc
        .deleteProjectsLocationsReportConfigs({
          name: output.name,
          force: true,
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
