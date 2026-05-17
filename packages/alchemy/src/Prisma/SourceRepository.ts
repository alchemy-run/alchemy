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
  isPrismaDevId,
  resolveProjectId,
  unresolvedProjectIdOf,
} from "./Refs.ts";
import type { SourceRepository as ApiSourceRepository } from "./Types.ts";

export interface SourceRepositoryProps {
  /**
   * Project ID or `project.projectId` output to link.
   */
  project: string | Project;
  /**
   * Git provider.
   *
   * @default "github"
   */
  provider?: "github";
  /**
   * Numeric provider repository ID.
   */
  providerRepositoryId: number;
}

export interface SourceRepository extends Resource<
  "Prisma.SourceRepository",
  SourceRepositoryProps,
  {
    /**
     * Prisma source repository link ID.
     */
    sourceRepositoryId: string;
    /**
     * Project ID linked to the repository.
     */
    projectId: string;
    /**
     * Numeric provider repository ID.
     */
    repoId: number;
    /**
     * Source control provider.
     */
    provider: "github";
    /**
     * Full repository name, for example "owner/repo".
     */
    repoFullName: string;
    /**
     * Default repository branch.
     */
    defaultBranch: string;
    /**
     * Whether the repository is private.
     */
    isPrivate: boolean;
    /**
     * Link status.
     */
    status: "active" | "archived";
    /**
     * SCM installation ID used for the link.
     */
    installationId: string;
    /**
     * ISO timestamp when the link was created.
     */
    createdAt: string;
    /**
     * ISO timestamp when the link was last updated.
     */
    updatedAt: string;
  },
  never,
  Providers
> {}

/**
 * A linked source repository for Prisma compute services.
 *
 * @section Linking a Repository
 * @example GitHub repository
 * ```typescript
 * const repo = yield* Prisma.SourceRepository("repo", {
 *   project: project.projectId,
 *   providerRepositoryId: 123456789,
 * });
 * ```
 */
export const SourceRepository = Resource<SourceRepository>(
  "Prisma.SourceRepository",
);

const findRepository = (
  client: PrismaManagementClient,
  projectId: string,
  repoId: number,
) =>
  client
    .listSourceRepositories({ projectId, limit: 100 })
    .pipe(
      Effect.map((repos) =>
        repos.find((r: ApiSourceRepository) => r.repoId === repoId),
      ),
    );

const attrsFrom = (
  repo: ApiSourceRepository,
): SourceRepository["Attributes"] => ({
  sourceRepositoryId: repo.id,
  projectId: repo.projectId,
  repoId: repo.repoId,
  provider: repo.provider,
  repoFullName: repo.repoFullName,
  defaultBranch: repo.defaultBranch,
  isPrivate: repo.isPrivate,
  status: repo.status,
  installationId: repo.installationId,
  createdAt: repo.createdAt,
  updatedAt: repo.updatedAt,
});

export const SourceRepositoryProvider = () =>
  Provider.effect(
    SourceRepository,
    Effect.gen(function* () {
      const client = yield* PrismaClient;
      return {
        stables: ["sourceRepositoryId"],
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isResolved(news)) return undefined;
          if (isPrismaDevId(output?.sourceRepositoryId)) {
            return { action: "update" } as const;
          }
          const oldProjectId = unresolvedProjectIdOf(olds.project);
          const newProjectId = unresolvedProjectIdOf(news.project);
          if (oldProjectId === undefined || newProjectId === undefined) {
            return undefined;
          }
          if (
            newProjectId !== oldProjectId ||
            (news.provider ?? "github") !== (olds.provider ?? "github") ||
            news.providerRepositoryId !== olds.providerRepositoryId
          ) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ output, olds }) {
          const sourceRepositoryId = isPrismaDevId(output?.sourceRepositoryId)
            ? undefined
            : output?.sourceRepositoryId;
          const repo = sourceRepositoryId
            ? yield* client
                .getSourceRepository(sourceRepositoryId)
                .pipe(
                  Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
                )
            : yield* Effect.gen(function* () {
                const projectId = unresolvedProjectIdOf(olds.project);
                return projectId
                  ? yield* findRepository(
                      client,
                      projectId,
                      olds.providerRepositoryId,
                    )
                  : undefined;
              });
          return repo ? attrsFrom(repo) : undefined;
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          const projectId = yield* resolveProjectId(news.project);
          const sourceRepositoryId = isPrismaDevId(output?.sourceRepositoryId)
            ? undefined
            : output?.sourceRepositoryId;
          let repo = sourceRepositoryId
            ? yield* client
                .getSourceRepository(sourceRepositoryId)
                .pipe(
                  Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
                )
            : yield* findRepository(
                client,
                projectId,
                news.providerRepositoryId,
              );
          if (!repo) {
            repo = yield* client
              .createSourceRepository({
                projectId,
                provider: news.provider ?? "github",
                providerRepositoryId: news.providerRepositoryId,
              })
              .pipe(
                Effect.catchIf(isConflict, () =>
                  findRepository(
                    client,
                    projectId,
                    news.providerRepositoryId,
                  ).pipe(
                    Effect.flatMap((repo) =>
                      repo
                        ? Effect.succeed(repo)
                        : Effect.fail(
                            new Error(
                              `Prisma source repository '${news.providerRepositoryId}' already exists but could not be read`,
                            ),
                          ),
                    ),
                  ),
                ),
              );
          }
          return attrsFrom(repo);
        }),
        delete: Effect.fn(function* ({ output }) {
          if (isPrismaDevId(output.sourceRepositoryId)) return;
          yield* client
            .deleteSourceRepository(output.sourceRepositoryId)
            .pipe(Effect.catchIf(isNotFound, () => Effect.void));
        }),
      };
    }),
  );
