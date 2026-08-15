import * as sandboxes from "@distilled.cloud/vercel/sandboxes";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { VercelEnvironment } from "../VercelEnvironment.ts";
import type { Providers } from "../Providers.ts";

export interface SandboxDriveProps {
  /**
   * The project (ID or name) the drive belongs to. Changing the project
   * replaces the drive.
   */
  project: string;
  /**
   * Name of the drive, unique per project and URL-safe (alphanumeric,
   * hyphens, underscores). If omitted, a unique name is generated from
   * `${app}-${stage}-${id}`. Changing the name replaces the drive.
   */
  name?: string;
  /**
   * Maximum drive size in bytes. Immutable — changing it replaces the
   * drive.
   *
   * @default 100 GiB (Vercel's default)
   */
  maxSizeBytes?: number;
  /**
   * Region where the drive is stored. Immutable — changing it replaces the
   * drive.
   *
   * @default "iad1"
   */
  region?: string;
}

export type SandboxDrive = Resource<
  "Vercel.SandboxDrive",
  SandboxDriveProps,
  {
    /** The unique drive name within the project. */
    name: string;
    /** ID of the project that owns the drive. */
    projectId: string;
    /** The maximum drive size in bytes. */
    maxSizeBytes: number;
    /** The region where the drive is stored. */
    region: string;
    /** Timestamp (ms) when the drive was created. */
    createdAt: number;
    /** Timestamp (ms) when the drive was last updated. */
    updatedAt: number;
  },
  never,
  Providers
>;

type SandboxDriveAttributes = SandboxDrive["Attributes"];

/**
 * A persistent Vercel Sandbox Drive — durable storage that can be mounted
 * into Vercel Sandbox sessions.
 *
 * Drives are in **private beta**: on accounts without access every drive
 * API call (including reads) fails with a typed `Forbidden` error
 * ("Drives are in private beta…"). Drives have no update API — every prop
 * is immutable and changes replace the drive.
 *
 * @resource
 * @section Creating a Drive
 * @example Drive with a generated name
 * ```typescript
 * const project = yield* Vercel.Project("Sandboxes", {});
 * const drive = yield* Vercel.SandboxDrive("Scratch", {
 *   project: project.projectId,
 * });
 * ```
 *
 * @example Drive with an explicit name and size
 * ```typescript
 * const drive = yield* Vercel.SandboxDrive("Cache", {
 *   project: project.projectId,
 *   name: "build-cache",
 *   maxSizeBytes: 10 * 1024 * 1024 * 1024,
 * });
 * ```
 *
 * @see https://vercel.com/docs/vercel-sandbox
 */
export const SandboxDrive = Resource<SandboxDrive>("Vercel.SandboxDrive");

const toAttributes = (drive: sandboxes.Drive): SandboxDriveAttributes => ({
  name: drive.name,
  projectId: drive.projectId,
  maxSizeBytes: drive.maxSizeBytes,
  region: drive.region,
  createdAt: drive.createdAt,
  updatedAt: drive.updatedAt,
});

const createDriveName = (id: string) =>
  createPhysicalName({ id, lowercase: true });

/**
 * Observe a drive by exact name via the paginated list (there is no pure
 * GET — `getOrCreateDrive` is an upsert and must not run during reads).
 */
const observeDrive = (projectId: string, name: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* VercelEnvironment.current;
    let cursor: string | undefined;
    do {
      const page = yield* sandboxes.listDrives({
        projectId,
        limit: 100,
        ...(cursor !== undefined ? { cursor } : {}),
        teamId,
      });
      const match = page.drives.find((d) => d.name === name);
      if (match !== undefined) return match;
      cursor = page.pagination.next ?? undefined;
    } while (cursor !== undefined);
    return undefined;
  });

export const SandboxDriveProvider = () =>
  Provider.succeed(SandboxDrive, {
    stables: ["name", "projectId", "region", "createdAt"],
    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      if (!output) return undefined;
      // Drives have no update API — every declared prop is immutable.
      if (
        news.project !== olds.project ||
        (news.name !== undefined && news.name !== output.name) ||
        (news.maxSizeBytes !== undefined &&
          news.maxSizeBytes !== output.maxSizeBytes) ||
        (news.region !== undefined && news.region !== output.region)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      const project = output?.projectId ?? olds?.project;
      if (project === undefined) return undefined;
      const name = output?.name ?? olds?.name ?? (yield* createDriveName(id));
      const observed = yield* observeDrive(project, name);
      if (observed === undefined) return undefined;
      const attrs = toAttributes(observed);
      // Drives carry no ownership channel — gate takeover of an existing
      // drive behind `--adopt`.
      return output !== undefined ? attrs : Unowned(attrs);
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { teamId } = yield* VercelEnvironment.current;
      const name = news.name ?? output?.name ?? (yield* createDriveName(id));

      // Observe — the drive may already exist (crash recovery, adoption).
      const observed = yield* observeDrive(news.project, name);
      if (observed !== undefined) return toAttributes(observed);

      // Ensure — `getOrCreateDrive` is a true upsert, so a concurrent
      // create is absorbed by the API itself.
      const created = yield* sandboxes.getOrCreateDrive({
        name,
        projectId: news.project,
        ...(news.maxSizeBytes !== undefined
          ? { maxSizeBytes: news.maxSizeBytes }
          : {}),
        ...(news.region !== undefined ? { region: news.region } : {}),
        teamId,
      });
      return toAttributes(created.drive);
    }),
    delete: Effect.fn(function* ({ output }) {
      const { teamId } = yield* VercelEnvironment.current;
      yield* sandboxes
        .deleteDrive({
          name: output.name,
          projectId: output.projectId,
          teamId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
