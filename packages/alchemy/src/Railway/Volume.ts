import { Retry as RailwayRetry } from "@distilled.cloud/railway";
import type {
  EnvironmentResponseVolumeInstancesEdgesItemNode,
  VolumeInstanceResponse,
  VolumeState,
} from "@distilled.cloud/railway";
import * as railway from "@distilled.cloud/railway";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { createRailwayName, matchesAlchemyPhysicalName } from "./Metadata.ts";
import { listOwnedProjects, type Project } from "./Project.ts";
import type { Providers } from "./Providers.ts";

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* Project(...)` and `Project(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

/**
 * Environment identity a Volume is deployed into. Accepts a
 * `Railway.Project` (its primary environment), a `Railway.Environment`,
 * or an `{ environmentId }` stub.
 */
export type VolumeEnvironment = {
  readonly environmentId: string;
};

/**
 * Service identity a Volume can attach to at create time. Accepts a
 * `Railway.Service` or a `{ serviceId }` stub. Subsequent attach is
 * `MountVolume` — omit `service` to leave the volume disconnected.
 */
export type VolumeService = {
  readonly serviceId: string;
};

export interface VolumeProps {
  /**
   * Parent Railway Project. Changing it replaces the Volume.
   */
  project: Ref<Project>;
  /**
   * Environment to deploy the volume instance into. Accepts a
   * `Railway.Project` (primary environment), a `Railway.Environment`, or
   * `{ environmentId }`. Defaults to the project's primary environment.
   * Changing it replaces the Volume.
   */
  environment?: Ref<VolumeEnvironment>;
  /**
   * Path in the container to mount the volume. Updates in place via
   * `volumeInstanceUpdate`.
   */
  mountPath: string;
  /**
   * Region for the volume instance (`us-west2`, `us-east4`, …). If
   * omitted, Railway picks the default. Changing it replaces the Volume.
   */
  region?: string;
  /**
   * Service to attach the volume to. If omitted, the volume is
   * disconnected — attach later with MountVolume. Accepts a
   * `Railway.Service` or `{ serviceId }`. Updating it attaches or moves
   * the volume in place.
   */
  service?: Ref<VolumeService>;
}

export type Volume = Resource<
  "Railway.Volume",
  VolumeProps,
  {
    /** Railway volume id. */
    volumeId: string;
    /** Volume instance id in the target environment. */
    volumeInstanceId: string;
    /** Physical volume name (unique per project). */
    name: string;
    /** Parent Railway project id. */
    projectId: string;
    /** Environment the instance is deployed in. */
    environmentId: string;
    /** Mount path in the container. */
    mountPath: string;
    /** Region the instance lives in, if Railway reported one. */
    region: string | undefined;
    /** Attached service id, if any. */
    serviceId: string | undefined;
    /** Observed instance state (`READY`, `UPDATING`, …). */
    state: VolumeState | undefined;
    /** Provisioned size in MB. */
    sizeMB: number;
    /** RFC3339 creation timestamp. */
    createdAt: string;
  },
  never,
  Providers
>;

const resolveVolumeProps = (
  props: VolumeProps | Effect.Effect<VolumeProps, never, Providers>,
): Effect.Effect<VolumeProps, never, Providers> =>
  Effect.gen(function* () {
    const resolved = Effect.isEffect(props) ? yield* props : props;
    if (globalThis.__ALCHEMY_RUNTIME__) return resolved;
    const project = Effect.isEffect(resolved.project)
      ? yield* resolved.project as Effect.Effect<Project, never, Providers>
      : resolved.project;
    const environment =
      resolved.environment === undefined
        ? undefined
        : Effect.isEffect(resolved.environment)
          ? yield* resolved.environment as Effect.Effect<
              VolumeEnvironment,
              never,
              Providers
            >
          : resolved.environment;
    const service =
      resolved.service === undefined
        ? undefined
        : Effect.isEffect(resolved.service)
          ? yield* resolved.service as Effect.Effect<
              VolumeService,
              never,
              Providers
            >
          : resolved.service;
    return { ...resolved, project, environment, service };
  });

const VolumeResource = Resource<Volume>("Railway.Volume");

/**
 * A Railway.Volume is block disk in a Project. Create it disconnected
 * (no `service`) and attach later with `MountVolume`, or pass `service`
 * to attach at create time.
 *
 * Railway has no labels. Ownership is stamped into the volume name via
 * `createPhysicalName`. `mountPath` updates in place. Changing `project`,
 * `environment`, or `region` replaces the Volume.
 *
 * @resource
 * @see https://docs.railway.com/guides/volumes
 * @see https://docs.railway.com/integrations/api/manage-volumes
 *
 * @section Create a Volume
 * Pass a Project and a mount path. Alchemy generates a unique name.
 * The volume is disconnected until you attach a Service.
 *
 * @example Disconnected volume
 * ```typescript
 * const site = yield* Railway.Project("Site");
 * const data = yield* Railway.Volume("Data", {
 *   project: site,
 *   mountPath: "/data",
 * });
 * ```
 *
 * :::caution[Changing `project` replaces the Volume]
 * The Volume is created in the new Project. The old Volume is deleted.
 * :::
 *
 * @section Mount path
 * `mountPath` is the path in the container. Updating it is in place.
 *
 * @example Update the mount path
 * ```typescript
 * const data = yield* Railway.Volume("Data", {
 *   project: site,
 *   mountPath: "/app/data",
 * });
 * ```
 *
 * @section Environment
 * Defaults to the Project's primary environment. Pass a
 * `Railway.Environment` (or `{ environmentId }`) to target another one.
 *
 * @example Extra environment
 * ```typescript
 * const staging = yield* Railway.Environment("Staging", { project: site });
 * const data = yield* Railway.Volume("StagingData", {
 *   project: site,
 *   environment: staging,
 *   mountPath: "/data",
 * });
 * ```
 *
 * :::caution[Changing `environment` replaces the Volume]
 * The Volume is created in the new environment. The old Volume is deleted.
 * :::
 *
 * @section Region
 * Omit `region` to use Railway's default. Changing it replaces the Volume.
 *
 * @example Pin a region
 * ```typescript
 * const data = yield* Railway.Volume("Data", {
 *   project: site,
 *   mountPath: "/data",
 *   region: "us-west2",
 * });
 * ```
 *
 * :::caution[Changing `region` replaces the Volume]
 * Volumes cannot move region. A new Volume is created, then the old one
 * is deleted.
 * :::
 *
 * @section Attach to a Service
 * Pass `service` to attach at create time. Omit it and attach later with
 * `MountVolume`.
 *
 * @example Create-time attach
 * ```typescript
 * const api = yield* Railway.Service("Api", {
 *   project: site,
 *   image: "hashicorp/http-echo",
 * });
 * const data = yield* Railway.Volume("Data", {
 *   project: site,
 *   mountPath: "/data",
 *   service: api,
 * });
 * ```
 *
 * @section Module-scope declarations
 * Declare the Project once. Pass it into every child. Resource-valued
 * props accept the resource or an Effect producing it.
 *
 * @example Module-scope Volume
 * ```typescript
 * // src/data.ts
 * import * as Railway from "alchemy/Railway";
 *
 * export const Site = Railway.Project("Site");
 * export const Data = Railway.Volume("Data", {
 *   project: Site,
 *   mountPath: "/data",
 * });
 * ```
 */
export const Volume: typeof VolumeResource = Object.assign(
  (
    id: string,
    props: VolumeProps | Effect.Effect<VolumeProps, never, Providers>,
  ) => VolumeResource(id, resolveVolumeProps(props)),
  VolumeResource,
);

export class VolumeNotCreated extends Data.TaggedError(
  "Railway.VolumeNotCreated",
)<{
  name: string;
  projectId: string;
}> {}

export class VolumeProjectRequired extends Data.TaggedError(
  "Railway.VolumeProjectRequired",
)<{
  message: string;
}> {}

export class VolumeEnvironmentRequired extends Data.TaggedError(
  "Railway.VolumeEnvironmentRequired",
)<{
  message: string;
}> {}

class VolumePending extends Data.TaggedError("Railway.VolumePending")<{
  volumeId: string;
  state: string;
}> {}

type CloudInstance =
  | EnvironmentResponseVolumeInstancesEdgesItemNode
  | VolumeInstanceResponse;

const projectIdOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { projectId?: unknown };
  return typeof rec.projectId === "string" && rec.projectId.length > 0
    ? rec.projectId
    : undefined;
};

const environmentIdOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { environmentId?: unknown };
  return typeof rec.environmentId === "string" && rec.environmentId.length > 0
    ? rec.environmentId
    : undefined;
};

const serviceIdOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { serviceId?: unknown };
  return typeof rec.serviceId === "string" && rec.serviceId.length > 0
    ? rec.serviceId
    : undefined;
};

const goneState = (state: VolumeState | null | undefined) =>
  state === "DELETED" || state === "DELETING";

const transientState = (state: VolumeState | null | undefined) =>
  state === "UPDATING" ||
  state === "MIGRATING" ||
  state === "MIGRATION_PENDING" ||
  state === "RESTORING";

const isGone = (instance: CloudInstance | undefined) =>
  instance === undefined ||
  instance.deletedAt != null ||
  instance.isPendingDeletion ||
  goneState(instance.state);

const toAttrs = (
  instance: CloudInstance,
  fallback?: { name?: string },
): Volume["Attributes"] => ({
  volumeId: instance.volumeId || instance.volume.id,
  volumeInstanceId: instance.id,
  name: instance.volume.name || fallback?.name || "",
  projectId: instance.volume.projectId,
  environmentId: instance.environmentId,
  mountPath: instance.mountPath,
  region: instance.region ?? undefined,
  serviceId: instance.serviceId ?? undefined,
  state: instance.state ?? undefined,
  sizeMB: instance.sizeMB,
  createdAt: instance.createdAt,
});

const resolveName = (id: string, existing?: string) =>
  Effect.gen(function* () {
    if (existing !== undefined) return existing;
    return yield* createRailwayName(id);
  });

const getByInstanceId = (volumeInstanceId: string) =>
  railway.volumeInstance({ id: volumeInstanceId }).pipe(
    Effect.map((instance) => (isGone(instance) ? undefined : instance)),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed(undefined),
    ),
  );

const listVolumeInstances = (environmentId: string, projectId: string) =>
  railway.environment({ id: environmentId, projectId }).pipe(
    Effect.map((env) =>
      env.volumeInstances.edges
        .map((edge) => edge.node)
        .filter((node) => !isGone(node)),
    ),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed([] as EnvironmentResponseVolumeInstancesEdgesItemNode[]),
    ),
  );

const findInEnvironment = (
  environmentId: string,
  projectId: string,
  match: (instance: CloudInstance) => boolean,
) =>
  listVolumeInstances(environmentId, projectId).pipe(
    Effect.map((instances) => instances.find(match)),
  );

const listEnvironmentIds = (project: {
  projectId: string;
  environmentId: string;
}) =>
  railway.environments.items({ projectId: project.projectId, first: 50 }).pipe(
    Stream.filter((env) => env.deletedAt == null),
    Stream.map((env) => env.id),
    Stream.runCollect,
    Effect.map((ids) => {
      const set = new Set(Array.from(ids));
      if (project.environmentId.length > 0) {
        set.add(project.environmentId);
      }
      return Array.from(set);
    }),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed(
        project.environmentId.length > 0 ? [project.environmentId] : [],
      ),
    ),
  );

const waitUntilSynced = (
  volumeInstanceId: string,
  volumeId: string,
  desired: { mountPath?: string; serviceId?: string },
) =>
  getByInstanceId(volumeInstanceId).pipe(
    Effect.flatMap((instance) => {
      const mountPending =
        desired.mountPath !== undefined &&
        instance?.mountPath !== desired.mountPath;
      const servicePending =
        desired.serviceId !== undefined &&
        (instance?.serviceId ?? undefined) !== desired.serviceId;
      if (
        instance === undefined ||
        transientState(instance.state) ||
        mountPending ||
        servicePending
      ) {
        return Effect.fail(
          new VolumePending({
            volumeId,
            state: instance?.state ?? "creating",
          }),
        );
      }
      return Effect.succeed(instance);
    }),
    Effect.retry({
      while: (e) => e._tag === "Railway.VolumePending",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
    Effect.catchTag("Railway.VolumePending", () =>
      getByInstanceId(volumeInstanceId),
    ),
  );

const waitForInstance = (
  environmentId: string,
  projectId: string,
  volumeId: string,
) =>
  findInEnvironment(
    environmentId,
    projectId,
    (instance) => instance.volumeId === volumeId,
  ).pipe(
    Effect.flatMap((instance) => {
      if (instance === undefined || transientState(instance.state)) {
        return Effect.fail(
          new VolumePending({
            volumeId,
            state: instance?.state ?? "creating",
          }),
        );
      }
      return Effect.succeed(instance);
    }),
    Effect.retry({
      while: (e) => e._tag === "Railway.VolumePending",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
    Effect.catchTag("Railway.VolumePending", () =>
      findInEnvironment(
        environmentId,
        projectId,
        (instance) => instance.volumeId === volumeId,
      ),
    ),
  );

const waitUntilGone = (input: {
  volumeInstanceId?: string;
  volumeId: string;
  environmentId: string;
  projectId: string;
}) => {
  const check =
    input.volumeInstanceId !== undefined && input.volumeInstanceId.length > 0
      ? getByInstanceId(input.volumeInstanceId).pipe(
          Effect.map((instance) => instance === undefined),
        )
      : findInEnvironment(
          input.environmentId,
          input.projectId,
          (instance) => instance.volumeId === input.volumeId,
        ).pipe(Effect.map((instance) => instance === undefined));
  return check.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (gone) => gone,
      times: 8,
    }),
  );
};

const stampName = (volumeId: string, name: string) =>
  railway.volumeUpdate({
    volumeId,
    input: { name },
  });

export const VolumeProvider = () =>
  Provider.succeed(Volume, {
    stables: [
      "volumeId",
      "volumeInstanceId",
      "projectId",
      "environmentId",
      "createdAt",
    ],
    nuke: { dependsOn: ["Railway.Project"] },

    diff: Effect.fn(function* ({ news, output }) {
      if (news === undefined || !isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      const nextProject = projectIdOf(news.project);
      const projectChanged =
        nextProject !== undefined && nextProject !== output.projectId;
      const nextEnv = environmentIdOf(news.environment);
      const environmentChanged =
        nextEnv !== undefined && nextEnv !== output.environmentId;
      const regionChanged =
        news.region !== undefined && news.region !== output.region;
      if (projectChanged || environmentChanged || regionChanged) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const projectId =
        output?.projectId ??
        (olds !== undefined ? projectIdOf(olds.project) : undefined);
      const environmentId =
        output?.environmentId ??
        (olds !== undefined
          ? (environmentIdOf(olds.environment) ?? environmentIdOf(olds.project))
          : undefined);
      const name = yield* resolveName(id, output?.name);

      const byInstance =
        output?.volumeInstanceId !== undefined &&
        output.volumeInstanceId.length > 0
          ? yield* getByInstanceId(output.volumeInstanceId)
          : undefined;
      const found =
        byInstance ??
        (projectId !== undefined && environmentId !== undefined
          ? ((output?.volumeId !== undefined
              ? yield* findInEnvironment(
                  environmentId,
                  projectId,
                  (instance) => instance.volumeId === output.volumeId,
                )
              : undefined) ??
            (yield* findInEnvironment(
              environmentId,
              projectId,
              (instance) => instance.volume.name === name,
            )))
          : undefined);
      if (found === undefined) return undefined;
      const attrs = toAttrs(found, { name });
      if (output !== undefined) return attrs;
      return matchesAlchemyPhysicalName(found.volume.name)
        ? attrs
        : Unowned(attrs);
    }),

    list: Effect.fn(function* () {
      const projects = yield* listOwnedProjects();
      const rows = yield* Effect.forEach(
        projects,
        (project) =>
          listEnvironmentIds(project).pipe(
            Effect.flatMap((environmentIds) =>
              Effect.forEach(
                environmentIds,
                (environmentId) =>
                  listVolumeInstances(environmentId, project.projectId).pipe(
                    Effect.map((instances) =>
                      instances
                        .filter((instance) =>
                          matchesAlchemyPhysicalName(instance.volume.name),
                        )
                        .map((instance) => toAttrs(instance)),
                    ),
                  ),
                { concurrency: 4 },
              ).pipe(Effect.map((nested) => nested.flat())),
            ),
          ),
        { concurrency: 8 },
      );
      const seen = new Set<string>();
      const unique: Volume["Attributes"][] = [];
      for (const row of rows.flat()) {
        if (seen.has(row.volumeId)) continue;
        seen.add(row.volumeId);
        unique.push(row);
      }
      return unique;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const props = news ?? ({} as VolumeProps);
      const projectId = projectIdOf(props.project) ?? output?.projectId;
      if (projectId === undefined) {
        return yield* new VolumeProjectRequired({
          message: "Volume requires a resolved Railway.Project",
        });
      }
      const environmentId =
        environmentIdOf(props.environment) ??
        environmentIdOf(props.project) ??
        output?.environmentId;
      if (environmentId === undefined) {
        return yield* new VolumeEnvironmentRequired({
          message:
            "Volume requires a Railway environment (pass environment or a Project with environmentId)",
        });
      }
      const name = yield* resolveName(id, output?.name);
      const desiredServiceId =
        props.service !== undefined ? serviceIdOf(props.service) : undefined;

      let current =
        output?.volumeInstanceId !== undefined &&
        output.volumeInstanceId.length > 0
          ? yield* getByInstanceId(output.volumeInstanceId)
          : undefined;
      if (current === undefined && output?.volumeId !== undefined) {
        current = yield* findInEnvironment(
          environmentId,
          projectId,
          (instance) => instance.volumeId === output.volumeId,
        );
      }
      if (current === undefined) {
        current = yield* findInEnvironment(
          environmentId,
          projectId,
          (instance) => instance.volume.name === name,
        );
      }

      if (current === undefined) {
        const created = yield* railway
          .volumeCreate({
            input: {
              projectId,
              environmentId,
              mountPath: props.mountPath,
              ...(props.region !== undefined ? { region: props.region } : {}),
              ...(desiredServiceId !== undefined
                ? { serviceId: desiredServiceId }
                : {}),
            },
          })
          .pipe(
            RailwayRetry.none,
            Effect.retry({
              while: (e) => e._tag === "RailwayRateLimited",
              schedule: Schedule.spaced("30 seconds"),
              times: 1,
            }),
          );
        if (created.name !== name) {
          yield* stampName(created.id, name);
        }
        current = yield* waitForInstance(environmentId, projectId, created.id);
      }

      if (current === undefined || isGone(current)) {
        return yield* new VolumeNotCreated({ name, projectId });
      }

      if (current.volume.name !== name) {
        yield* stampName(current.volumeId, name);
        current =
          (yield* getByInstanceId(current.id)) ??
          (yield* findInEnvironment(
            environmentId,
            projectId,
            (instance) => instance.volumeId === current!.volumeId,
          )) ??
          current;
      }

      const mountChanged = current.mountPath !== props.mountPath;
      const observedServiceId = current.serviceId ?? undefined;
      const serviceChanged =
        desiredServiceId !== undefined &&
        desiredServiceId !== observedServiceId;
      if (mountChanged || serviceChanged) {
        yield* railway.volumeInstanceUpdate({
          volumeId: current.volumeId,
          environmentId,
          input: {
            ...(mountChanged ? { mountPath: props.mountPath } : {}),
            ...(serviceChanged ? { serviceId: desiredServiceId } : {}),
          },
        });
        current =
          (yield* waitUntilSynced(current.id, current.volumeId, {
            ...(mountChanged ? { mountPath: props.mountPath } : {}),
            ...(serviceChanged ? { serviceId: desiredServiceId } : {}),
          })) ?? current;
      }

      return toAttrs(current, { name });
    }),

    delete: Effect.fn(function* ({ output }) {
      const volumeId = output.volumeId;
      if (volumeId.length === 0) return;
      yield* railway
        .volumeDelete({ volumeId })
        .pipe(
          Effect.catchTag(["RailwayNotFound", "NotFound"], () => Effect.void),
        );
      yield* waitUntilGone({
        volumeInstanceId: output.volumeInstanceId,
        volumeId,
        environmentId: output.environmentId,
        projectId: output.projectId,
      });
    }),
  });
