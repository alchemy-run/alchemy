import type { Project as NeonApiProject } from "@neondatabase/api-client";
import * as Effect from "effect/Effect";
import { createPhysicalName } from "../physical-name.ts";
import { NeonApi } from "./api.ts";
import {
  Project,
  type NeonPgVersion,
  type NeonRegion,
  type ProjectAttr,
  type ProjectProps,
} from "./project.ts";

export const projectProvider = () =>
  Project.provider.effect(
    Effect.gen(function* () {
      const api = yield* NeonApi;

      const createProjectName = (id: string, name: string | undefined) =>
        Effect.gen(function* () {
          return name ?? (yield* createPhysicalName({ id }));
        });

      const mapResult = <Props extends ProjectProps>(
        project: NeonApiProject,
        defaultBranchId: string,
        defaultEndpointId: string,
      ): ProjectAttr<Props> =>
        ({
          projectId: project.id,
          name: project.name,
          createdAt: project.created_at,
          updatedAt: project.updated_at,
          proxyHost: project.proxy_host,
          regionId: project.region_id as NeonRegion,
          pgVersion: project.pg_version as NeonPgVersion,
          settings: project.settings,
          defaultEndpointSettings: project.default_endpoint_settings,
          historyRetentionSeconds: project.history_retention_seconds ?? 86400,
          defaultBranchId,
          defaultEndpointId,
        }) as ProjectAttr<Props>;

      const createProject = Effect.fn(function* (
        projectName: string,
        props: ProjectProps,
      ) {
        const response = yield* Effect.promise(() =>
          api.project.createProject({
            project: {
              name: projectName,
              region_id: props.regionId,
              pg_version: props.pgVersion,
              default_endpoint_settings: props.defaultEndpointSettings,
              branch: {
                name: props.defaultBranchName,
              },
              settings: props.settings,
              history_retention_seconds: props.historyRetentionSeconds,
            },
          }),
        );
        return response.data;
      });

      const updateProject = Effect.fn(function* (
        projectId: string,
        projectName: string,
        props: ProjectProps,
      ) {
        const response = yield* Effect.promise(() =>
          api.project.updateProject(projectId, {
            project: {
              name: projectName,
              settings: props.settings,
              default_endpoint_settings: props.defaultEndpointSettings,
              history_retention_seconds: props.historyRetentionSeconds,
            },
          }),
        );
        return response.data;
      });

      const getProject = Effect.fn(function* (projectId: string) {
        const response = yield* Effect.promise(() =>
          api.project.getProject(projectId),
        );
        return response.data;
      });

      const listProjects = Effect.fn(function* (search?: string) {
        const response = yield* Effect.promise(() =>
          api.project.listProjects({ search }),
        );
        return response.data.projects;
      });

      const deleteProject = Effect.fn(function* (projectId: string) {
        yield* Effect.promise(() => api.project.deleteProject(projectId)).pipe(
          Effect.catchAll(() => Effect.void),
        );
      });

      const listBranches = Effect.fn(function* (projectId: string) {
        const response = yield* Effect.promise(() =>
          api.branch.listProjectBranches(projectId),
        );
        return response.data.branches;
      });

      const listEndpoints = Effect.fn(function* (projectId: string) {
        const response = yield* Effect.promise(() =>
          api.endpoint.listProjectEndpoints(projectId),
        );
        return response.data.endpoints;
      });

      return {
        stables: ["projectId"],

        diff: Effect.fn(function* ({ id, news, output }) {
          const projectName = yield* createProjectName(id, news.name);
          if (projectName !== output.name) {
            return { action: "update" } as const;
          }

          if (news.regionId && news.regionId !== output.regionId) {
            return { action: "replace" } as const;
          }

          if (news.pgVersion && news.pgVersion !== output.pgVersion) {
            return { action: "replace" } as const;
          }
        }),

        create: Effect.fn(function* ({ id, news, session }) {
          const projectName = yield* createProjectName(id, news.name);

          if (news.adopt) {
            const existing = yield* listProjects(projectName);
            const match = existing.find((p) => p.name === projectName);
            if (match) {
              yield* session.note(`Adopting existing project: ${projectName}`);
              const branches = yield* listBranches(match.id);
              const endpoints = yield* listEndpoints(match.id);
              const defaultBranch = branches.find((b) => b.default) ?? branches[0];
              const defaultEndpoint = endpoints[0];
              return mapResult<ProjectProps>(
                match as unknown as NeonApiProject,
                defaultBranch?.id ?? "",
                defaultEndpoint?.id ?? "",
              );
            }
          }

          yield* session.note(`Creating project: ${projectName}`);
          const data = yield* createProject(projectName, news);
          yield* session.note(data.project.id);

          return mapResult<ProjectProps>(
            data.project,
            data.branch.id,
            data.endpoints[0]?.id ?? "",
          );
        }),

        update: Effect.fn(function* ({ id, news, output, session }) {
          const projectName = yield* createProjectName(id, news.name);

          yield* session.note(`Updating project: ${projectName}`);
          const data = yield* updateProject(output.projectId, projectName, news);

          return {
            ...output,
            name: data.project.name,
            updatedAt: data.project.updated_at,
            settings: data.project.settings,
            defaultEndpointSettings: data.project.default_endpoint_settings,
            historyRetentionSeconds:
              data.project.history_retention_seconds ?? 86400,
          } as ProjectAttr<ProjectProps>;
        }),

        delete: Effect.fn(function* ({ output, olds }) {
          if (olds.delete !== false) {
            yield* deleteProject(output.projectId);
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          if (output?.projectId) {
            return yield* getProject(output.projectId).pipe(
              Effect.flatMap((data) =>
                Effect.gen(function* () {
                  const branches = yield* listBranches(data.project.id);
                  const endpoints = yield* listEndpoints(data.project.id);
                  const defaultBranch = branches.find((b) => b.default) ?? branches[0];
                  const defaultEndpoint = endpoints[0];
                  return mapResult<ProjectProps>(
                    data.project,
                    defaultBranch?.id ?? "",
                    defaultEndpoint?.id ?? "",
                  );
                }),
              ),
              Effect.catchAll(() => Effect.succeed(undefined)),
            );
          }

          const projectName = yield* createProjectName(id, olds?.name);
          const projects = yield* listProjects(projectName);
          const match = projects.find((p) => p.name === projectName);

          if (match) {
            const branches = yield* listBranches(match.id);
            const endpoints = yield* listEndpoints(match.id);
            const defaultBranch = branches.find((b) => b.default) ?? branches[0];
            const defaultEndpoint = endpoints[0];
            return mapResult<ProjectProps>(
              match as unknown as NeonApiProject,
              defaultBranch?.id ?? "",
              defaultEndpoint?.id ?? "",
            );
          }

          return undefined;
        }),
      };
    }),
  );
