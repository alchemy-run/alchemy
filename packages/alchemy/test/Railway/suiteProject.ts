/**
 * One Railway project for the live test process. Not a stack resource —
 * tests pass it as `project:` so `stack.destroy()` cannot delete it.
 *
 * Named so `matchesAlchemyPhysicalName` still lists it (service `list()`
 * walks owned projects) and `pnpm nuke` can reclaim it.
 */
import {
  CredentialsFromEnv,
  GraphQlHttpGate,
  Retry as RailwayRetry,
} from "@distilled.cloud/railway";
import * as railway from "@distilled.cloud/railway";
import { resolveWorkspace } from "@/Railway/Environment.ts";
import type { Project } from "@/Railway/Project.ts";
import { isRailwayTransient } from "@/Railway/transient.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { SUITE_PROJECT_NAME } from "./suiteProjectName.ts";

export { SUITE_PROJECT_NAME } from "./suiteProjectName.ts";

const toProject = (
  project: {
    id: string;
    name?: string | null;
    workspaceId?: string | null;
    workspace?: { id: string } | null;
    primaryEnvironmentId?: string | null;
    baseEnvironmentId?: string | null;
    baseEnvironment?: { id: string } | null;
    deletedAt?: string | null;
  },
  workspaceId: string,
): Project =>
  ({
    projectId: project.id,
    name: project.name || SUITE_PROJECT_NAME,
    workspaceId: project.workspaceId ?? project.workspace?.id ?? workspaceId,
    environmentId:
      project.primaryEnvironmentId ??
      project.baseEnvironmentId ??
      project.baseEnvironment?.id ??
      "",
    url: `https://railway.com/project/${project.id}`,
  }) as Project;

const findByName = (workspaceId: string) =>
  railway.projects
    .items({ workspaceId, first: 50, includeDeleted: false })
    .pipe(
      Stream.filter(
        (project) =>
          project.deletedAt == null && project.name === SUITE_PROJECT_NAME,
      ),
      Stream.take(1),
      Stream.runHead,
      Effect.map((option) =>
        option._tag === "Some" ? option.value : undefined,
      ),
    );

const acquire = Effect.gen(function* () {
  const workspace = yield* resolveWorkspace();
  const existing = yield* findByName(workspace.id);
  const resolve = (project: Parameters<typeof toProject>[0]) =>
    Effect.gen(function* () {
      const attrs = toProject(project, workspace.id);
      if (attrs.environmentId.length > 0) {
        return attrs;
      }
      const fresh = yield* railway.project({ id: attrs.projectId });
      return toProject(fresh, workspace.id);
    });

  if (existing !== undefined) {
    return yield* resolve(existing);
  }

  return yield* railway
    .projectCreate({
      input: {
        name: SUITE_PROJECT_NAME,
        workspaceId: workspace.id,
        description: "alchemy railway live-test suite (shared)",
      },
    })
    .pipe(
      RailwayRetry.none,
      Effect.retry({
        while: isRailwayTransient,
        schedule: Schedule.spaced("31 seconds"),
        times: 8,
      }),
      Effect.flatMap((project) => resolve(project)),
      Effect.catch((error) =>
        findByName(workspace.id).pipe(
          Effect.flatMap((found) =>
            found !== undefined ? resolve(found) : Effect.fail(error),
          ),
        ),
      ),
    );
}).pipe(
  Effect.provide(CredentialsFromEnv),
  Effect.provide(GraphQlHttpGate.pipe(Layer.provide(FetchHttpClient.layer))),
);

/**
 * Process-cached create-or-get. Yield it inside a test or pass the
 * Effect as `project:` (resource-valued props accept Effects).
 */
export const suiteProject: Effect.Effect<Project> = Effect.runSync(
  Effect.cached(acquire),
);
