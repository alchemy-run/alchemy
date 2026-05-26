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
import { destroyComputeService } from "./ComputeLifecycle.ts";
import type { Project } from "./Project.ts";
import type { Providers } from "./Providers.ts";
import {
  concreteIdsChanged,
  isInputObject,
  isPrismaDevId,
  resolveProjectId,
  unresolvedProjectIdOf,
} from "./Refs.ts";
import type {
  ComputeService as ApiComputeService,
  PrismaRegionId,
} from "./Types.ts";

export interface ComputeServiceProps {
  /**
   * Project ID or `project.projectId` output that owns this compute service.
   */
  project: string | Project;
  /**
   * Compute service display name.
   */
  displayName: string;
  /**
   * Region where the service is placed.
   *
   * @default "us-east-1"
   */
  regionId?: PrismaRegionId;
  /**
   * Branch ID to attach the service to. Mutually exclusive with branchGitName.
   */
  branchId?: string | null;
  /**
   * Branch git name to attach the service to. Mutually exclusive with branchId.
   */
  branchGitName?: string | null;
}

export interface ComputeService extends Resource<
  "Prisma.ComputeService",
  ComputeServiceProps,
  {
    /**
     * Prisma compute service ID.
     */
    computeServiceId: string;
    /**
     * Compute service display name.
     */
    name: string;
    /**
     * Project ID that owns the compute service.
     */
    projectId: string;
    /**
     * Region ID where the service is placed.
     */
    regionId: string;
    /**
     * Branch ID attached to the service, or null when unassigned.
     */
    branchId: string | null;
    /**
     * Latest promoted compute version ID, when available.
     */
    latestVersionId: string | null;
    /**
     * Stable service endpoint domain.
     */
    serviceEndpointDomain: string;
    /**
     * ISO timestamp when the compute service was created.
     */
    createdAt: string;
  },
  never,
  Providers
> {}

/**
 * A Prisma compute service.
 *
 * @section Creating a Service
 * @example Compute service attached to a branch
 * ```typescript
 * const service = yield* Prisma.ComputeService("web", {
 *   project: project.projectId,
 *   displayName: "web",
 *   branchGitName: "main",
 * });
 * ```
 */
export const ComputeService = Resource<ComputeService>("Prisma.ComputeService");

const findService = (
  client: PrismaManagementClient,
  projectId: string,
  displayName: string,
) =>
  client
    .listProjectComputeServices(projectId, { limit: 100 })
    .pipe(
      Effect.map((services: ApiComputeService[]) =>
        services.find((s) => s.name === displayName),
      ),
    );

const attrsFrom = (
  service: ApiComputeService,
): ComputeService["Attributes"] => ({
  computeServiceId: service.id,
  name: service.name,
  projectId: service.projectId,
  regionId: service.region.id,
  branchId: service.branchId,
  latestVersionId: service.latestVersionId,
  serviceEndpointDomain: service.serviceEndpointDomain,
  createdAt: service.createdAt,
});

const branchNeedsSync = Effect.fn(function* (
  client: PrismaManagementClient,
  projectId: string,
  service: ApiComputeService,
  props: ComputeServiceProps,
) {
  if (props.branchId !== undefined && !isPrismaDevId(props.branchId)) {
    return service.branchId !== props.branchId;
  }
  if (props.branchGitName === undefined) {
    return false;
  }
  if (props.branchGitName === null) {
    return service.branchId !== null;
  }
  const branch = yield* client
    .listBranches(projectId, { gitName: props.branchGitName, limit: 1 })
    .pipe(Effect.map((branches) => branches[0]));
  return branch === undefined || branch.id !== service.branchId;
});

const newlyCreatedServiceNeedsBranchSync = (
  service: ApiComputeService,
  props: ComputeServiceProps,
) => {
  if (props.branchId !== undefined && !isPrismaDevId(props.branchId)) {
    return service.branchId !== props.branchId;
  }
  if (props.branchGitName === undefined) {
    return false;
  }
  if (props.branchGitName === null) {
    return service.branchId !== null;
  }
  return service.branchId === null;
};

const branchAttachment = (props: ComputeServiceProps) =>
  props.branchId !== undefined && !isPrismaDevId(props.branchId)
    ? {
        branchId: props.branchId,
        branchGitName: undefined,
      }
    : props.branchGitName !== undefined
      ? {
          branchId: undefined,
          branchGitName: props.branchGitName,
        }
      : {
          branchId: undefined,
          branchGitName: undefined,
        };

const validateComputeServiceProps = (props: ComputeServiceProps) =>
  Effect.gen(function* () {
    if (props.branchId !== undefined && props.branchGitName !== undefined) {
      return yield* Effect.fail(
        new Error("branchId and branchGitName are mutually exclusive."),
      );
    }
  });

export const ComputeServiceProvider = () =>
  Provider.effect(
    ComputeService,
    Effect.gen(function* () {
      const client = yield* PrismaClient;
      return {
        stables: ["computeServiceId"],
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isInputObject(news)) return undefined;
          const diffProps = {
            displayName: news.displayName,
            regionId: news.regionId,
            branchId: news.branchId,
            branchGitName: news.branchGitName,
          };
          if (!isResolved(diffProps)) return undefined;
          const resolvedDiffProps = diffProps as Pick<
            ComputeServiceProps,
            "displayName" | "regionId" | "branchId" | "branchGitName"
          >;
          if (isPrismaDevId(output?.computeServiceId)) {
            return { action: "update" } as const;
          }
          const oldProjectId = unresolvedProjectIdOf(olds.project);
          const newProjectId = isResolved(news.project)
            ? unresolvedProjectIdOf(news.project)
            : undefined;
          if (
            concreteIdsChanged(oldProjectId, newProjectId) ||
            (resolvedDiffProps.regionId ?? "us-east-1") !==
              (olds.regionId ?? "us-east-1")
          ) {
            return { action: "replace" } as const;
          }
          if (
            resolvedDiffProps.displayName !== olds.displayName ||
            resolvedDiffProps.branchId !== olds.branchId ||
            resolvedDiffProps.branchGitName !== olds.branchGitName
          ) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ output, olds }) {
          const computeServiceId = isPrismaDevId(output?.computeServiceId)
            ? undefined
            : output?.computeServiceId;
          const service = computeServiceId
            ? yield* client
                .getComputeService(computeServiceId)
                .pipe(
                  Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
                )
            : yield* Effect.gen(function* () {
                const projectId = unresolvedProjectIdOf(olds.project);
                return projectId
                  ? yield* findService(client, projectId, olds.displayName)
                  : undefined;
              });
          return service ? attrsFrom(service) : undefined;
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          yield* validateComputeServiceProps(news);
          const projectId = yield* resolveProjectId(news.project);
          const computeServiceId = isPrismaDevId(output?.computeServiceId)
            ? undefined
            : output?.computeServiceId;
          let service = computeServiceId
            ? yield* client
                .getComputeService(computeServiceId)
                .pipe(
                  Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
                )
            : yield* findService(client, projectId, news.displayName);
          let createdService = false;
          const attach = branchAttachment(news);
          if (!service) {
            const result = yield* client
              .createProjectComputeService(projectId, {
                displayName: news.displayName,
                regionId: news.regionId ?? "us-east-1",
                branchId: attach.branchId,
                branchGitName: attach.branchGitName,
              })
              .pipe(
                Effect.map((service: ApiComputeService) => ({
                  service,
                  created: true,
                })),
                Effect.catchIf(isConflict, () =>
                  findService(client, projectId, news.displayName).pipe(
                    Effect.flatMap((service) =>
                      service
                        ? Effect.succeed({ service, created: false })
                        : Effect.fail(
                            new Error(
                              `Prisma compute service '${news.displayName}' already exists but could not be read`,
                            ),
                          ),
                    ),
                  ),
                ),
              );
            service = result.service;
            createdService = result.created;
          }
          const needsBranchSync = createdService
            ? newlyCreatedServiceNeedsBranchSync(service, news)
            : yield* branchNeedsSync(client, projectId, service, news);
          if (service.name !== news.displayName || needsBranchSync) {
            service = yield* client.updateComputeService(service.id, {
              displayName: news.displayName,
              branchId: attach.branchId,
              branchGitName: attach.branchGitName,
            });
          }
          return attrsFrom(service);
        }),
        delete: Effect.fn(function* ({ output }) {
          if (isPrismaDevId(output.computeServiceId)) return;
          yield* destroyComputeService(client, output.computeServiceId);
        }),
      };
    }),
  );
