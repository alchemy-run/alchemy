import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  PrismaClient,
  isConflict,
  isNotFound,
  type PrismaManagementClient,
} from "./Client.ts";
import type { Project } from "./Project.ts";
import type { Providers } from "./Providers.ts";
import {
  concreteIdsChanged,
  isInputObject,
  isPrismaDevId,
  resolveProjectId,
  unresolvedProjectIdOf,
} from "./Refs.ts";
import type { Branch as ApiBranch } from "./Types.ts";

export interface BranchProps {
  /**
   * Project ID or `project.projectId` output that owns this branch.
   */
  project: string | Project;
  /**
   * Git-style branch name.
   */
  gitName: string;
  /**
   * Whether this branch should be the project's default branch.
   *
   * @default false
   */
  isDefault?: boolean;
}

export interface Branch extends Resource<
  "Prisma.Branch",
  BranchProps,
  {
    /**
     * Prisma branch ID.
     */
    branchId: string;
    /**
     * Git-style branch name.
     */
    gitName: string;
    /**
     * Project ID that owns the branch.
     */
    projectId: string;
    /**
     * Whether this branch is the project's default branch.
     */
    isDefault: boolean;
    /**
     * ISO timestamp when the branch was created.
     */
    createdAt: string;
    /**
     * ISO timestamp when the branch was last updated.
     */
    updatedAt: string;
  },
  never,
  Providers
> {}

/**
 * A Prisma project branch for preview-class databases and compute resources.
 *
 * @section Creating a Branch
 * @example Preview branch
 * ```typescript
 * const branch = yield* Prisma.Branch("preview", {
 *   project: project.projectId,
 *   gitName: "feature/search",
 * });
 * ```
 */
export const Branch = Resource<Branch>("Prisma.Branch");

const findBranch = (
  client: PrismaManagementClient,
  projectId: string,
  gitName: string,
) =>
  client
    .listBranches(projectId, { gitName })
    .pipe(
      Effect.map((branches) =>
        branches.find((b: ApiBranch) => b.gitName === gitName),
      ),
    );

const attrsFrom = (branch: ApiBranch): Branch["Attributes"] => ({
  branchId: branch.id,
  gitName: branch.gitName,
  projectId: branch.project.id,
  isDefault: branch.isDefault,
  createdAt: branch.createdAt,
  updatedAt: branch.updatedAt,
});

export const BranchProvider = () =>
  Provider.effect(
    Branch,
    Effect.gen(function* () {
      const client = yield* PrismaClient;
      return {
        stables: ["branchId"],
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isInputObject(news)) return undefined;
          if (isPrismaDevId(output?.branchId)) {
            return { action: "update" } as const;
          }
          const oldProjectId = unresolvedProjectIdOf(olds.project);
          const newProjectId = isResolved(news.project)
            ? unresolvedProjectIdOf(news.project)
            : undefined;
          if (
            concreteIdsChanged(oldProjectId, newProjectId) ||
            (isResolved(news.gitName) && news.gitName !== olds.gitName)
          ) {
            return { action: "replace" } as const;
          }
          if (!isResolved(news.isDefault)) return undefined;
          if ((news.isDefault ?? false) !== (olds.isDefault ?? false)) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ output, olds }) {
          const branchId = isPrismaDevId(output?.branchId)
            ? undefined
            : output?.branchId;
          const branch = branchId
            ? yield* client
                .getBranch(branchId)
                .pipe(
                  Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
                )
            : yield* Effect.gen(function* () {
                const projectId = unresolvedProjectIdOf(olds.project);
                return projectId
                  ? yield* findBranch(client, projectId, olds.gitName)
                  : undefined;
              });
          return branch ? attrsFrom(branch) : undefined;
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          const projectId = yield* resolveProjectId(news.project);
          const branchId = isPrismaDevId(output?.branchId)
            ? undefined
            : output?.branchId;
          let branch = branchId
            ? yield* client
                .getBranch(branchId)
                .pipe(
                  Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
                )
            : yield* findBranch(client, projectId, news.gitName);
          if (!branch) {
            branch = yield* client
              .createBranch(projectId, {
                gitName: news.gitName,
                isDefault: news.isDefault,
              })
              .pipe(
                Effect.catchIf(isConflict, () =>
                  findBranch(client, projectId, news.gitName).pipe(
                    Effect.flatMap((branch) =>
                      branch
                        ? Effect.succeed(branch)
                        : Effect.fail(
                            new Error(
                              `Prisma branch '${news.gitName}' already exists but could not be read`,
                            ),
                          ),
                    ),
                  ),
                ),
              );
          }
          if (branch.isDefault !== (news.isDefault ?? false)) {
            branch = yield* client.updateBranch(branch.id, {
              isDefault: news.isDefault ?? false,
            });
          }
          return attrsFrom(branch);
        }),
        delete: Effect.fn(function* ({ output, session }) {
          if (isPrismaDevId(output.branchId)) return;
          const branch = output.isDefault
            ? output
            : yield* client
                .getBranch(output.branchId)
                .pipe(
                  Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
                );
          if (!branch) return;
          if (branch.isDefault) {
            // Prisma treats the default branch as project-owned state, not an
            // independently deletable resource.
            if (session !== undefined) {
              yield* session.note(
                "Skipping direct delete for default Prisma branch; Prisma removes it when the owning project is deleted.",
              );
            }
            return;
          }
          yield* client
            .deleteBranch(output.branchId)
            .pipe(Effect.catchIf(isNotFound, () => Effect.void));
        }),
      };
    }),
  );
