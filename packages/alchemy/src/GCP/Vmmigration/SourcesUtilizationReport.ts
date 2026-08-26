import * as vm from "@distilled.cloud/gcp/vmmigration_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  collectPages,
  encodeOwnershipLine,
  fingerprint,
  forEachSource,
  hasOwnershipMarker,
  normalizeLocation,
  ownedByAlchemy,
  parseName,
  parseOwnership,
  replaceOnIdentity,
  ResourceNotResolved,
  sourceOf,
  toPhysicalId,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type UtilizationReportTimeFrame =
  | vm.UtilizationReportTimeFrameEnum
  | (string & {});
export type UtilizationReportState =
  | vm.UtilizationReportStateEnum
  | (string & {});
export type VmUtilizationInfo = vm.VmUtilizationInfo;

export type SourcesUtilizationReportProps = {
  /**
   * Parent source. Full name
   * `projects/{project}/locations/{location}/sources/{source}` or the
   * source id (combined with `location`). Immutable — changing it
   * replaces the report.
   */
  source: string;
  /**
   * Region used when `source` is a bare id.
   * @default "us-central1"
   */
  location?: string;
  /**
   * Utilization report id. If omitted, a unique RFC1035 name is
   * generated. Immutable — changing it replaces the report.
   */
  utilizationReportId?: string;
  /**
   * User-friendly display name. Reports have no labels field, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  displayName?: string;
  /**
   * Time frame of the report.
   * @default "WEEK"
   */
  timeFrame?: UtilizationReportTimeFrame;
  /**
   * VMs to include. Only `vmId` is honored on create; other fields are
   * filled by the service.
   */
  vms?: VmUtilizationInfo[];
};

export type SourcesUtilizationReport = Resource<
  "GCP.Vmmigration.SourcesUtilizationReport",
  SourcesUtilizationReportProps,
  {
    /** Full resource name. */
    name: string;
    /** Utilization report id (last path segment). */
    utilizationReportId: string;
    /** Parent source resource name. */
    source: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Time frame of the report. */
    timeFrame: string | undefined;
    /** VMs included in the report. */
    vms: VmUtilizationInfo[] | undefined;
    /** Number of VMs included. */
    vmCount: number | undefined;
    /** Report state. */
    state: string | undefined;
    /** End of the sampled time frame. */
    frameEndTime: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A VM Migration utilization report for selected VMs in a source
 * environment (CPU, memory, disk, network).
 *
 * Reports have no labels field — Alchemy stamps ownership into the
 * display name so `list` / nuke can find them. The API has no patch
 * method; changing time frame, VMs, or display name replaces the
 * report.
 *
 * ### Creating a Utilization Report
 * **Example:** Weekly report for selected VMs
 * ```typescript
 * const report = yield* GCP.Vmmigration.SourcesUtilizationReport("Week", {
 *   source: source.name,
 *   timeFrame: "WEEK",
 *   vms: [{ vmId: "vm-123" }, { vmId: "vm-456" }],
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Vmmigration
 */
export const SourcesUtilizationReport = Resource<SourcesUtilizationReport>(
  "GCP.Vmmigration.SourcesUtilizationReport",
);

const DEFAULT_TIME_FRAME: UtilizationReportTimeFrame = "WEEK";

const resourceName = (source: string, utilizationReportId: string) =>
  `${source}/utilizationReports/${utilizationReportId}`;

const toAttrs = (report: vm.UtilizationReport, project: string) => {
  const name = report.name ?? "";
  const parsed = parseName(name, "utilizationReports");
  const ownership = parseOwnership(report.displayName);
  return {
    name,
    utilizationReportId: parsed.id,
    source: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    displayName: ownership.text,
    timeFrame: report.timeFrame,
    vms: report.vms,
    vmCount: report.vmCount,
    state: report.state,
    frameEndTime: report.frameEndTime,
    createTime: report.createTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : vm
        .getProjectsLocationsSourcesUtilizationReports({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listChildren = (parent: string) =>
  collectPages(
    vm.listProjectsLocationsSourcesUtilizationReports.pages({
      parent,
      pageSize: 1000,
      view: "BASIC",
    }),
    (page) => page.utilizationReports,
  ).pipe(
    Effect.catchTag(["NotFound", "Forbidden"], () =>
      Effect.succeed([] as vm.UtilizationReport[]),
    ),
  );

export const SourcesUtilizationReportProvider = () =>
  Provider.succeed(SourcesUtilizationReport, {
    stables: [
      "name",
      "utilizationReportId",
      "source",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousSource = olds?.source ?? output?.source;
      const previousFrame =
        olds?.timeFrame ?? output?.timeFrame ?? DEFAULT_TIME_FRAME;
      const nextFrame = news.timeFrame ?? previousFrame;
      const extra =
        previousFrame !== nextFrame ||
        fingerprint(news.vms?.map((vmInfo) => vmInfo.vmId)) !==
          fingerprint((olds?.vms ?? output?.vms)?.map((vmInfo) => vmInfo.vmId));
      return replaceOnIdentity({
        previousId: olds?.utilizationReportId ?? output?.utilizationReportId,
        nextId:
          news.utilizationReportId ??
          olds?.utilizationReportId ??
          output?.utilizationReportId,
        previousLocation: normalizeLocation(olds?.location ?? output?.location),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
        ),
        previousParent: previousSource,
        nextParent: news.source ?? previousSource,
        extra,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(olds?.location ?? output?.location);
      const utilizationReportId = yield* toPhysicalId(
        id,
        olds?.utilizationReportId,
        output?.utilizationReportId,
        "utilreport",
      );
      const source =
        olds?.source !== undefined
          ? sourceOf(olds.source, env.project, location)
          : (output?.source ?? "");
      const name =
        output?.name ??
        (source.length > 0 ? resourceName(source, utilizationReportId) : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* forEachSource(env.project, listChildren);
        return items
          .filter((item) => hasOwnershipMarker(item.displayName))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(news.location ?? output?.location);
      const source = sourceOf(news.source, env.project, location);
      const utilizationReportId = yield* toPhysicalId(
        id,
        news.utilizationReportId,
        output?.utilizationReportId,
        "utilreport",
      );
      const name = resourceName(source, utilizationReportId);
      const ownership = yield* createInternalLabels(id);
      const displayName = encodeOwnershipLine(
        ownership,
        news.displayName ?? utilizationReportId,
      );
      const timeFrame = news.timeFrame ?? DEFAULT_TIME_FRAME;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* vm
          .createProjectsLocationsSourcesUtilizationReports({
            parent: source,
            utilizationReportId,
            body: {
              displayName,
              timeFrame,
              vms: news.vms,
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
      const operation = yield* vm
        .deleteProjectsLocationsSourcesUtilizationReports({
          name: output.name,
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
