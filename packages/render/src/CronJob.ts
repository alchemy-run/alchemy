import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Client from "./internal/Client.ts";
import { renderResourceLogs, renderResourceTail } from "./internal/Logs.ts";
import {
  buildEnvSpecificDetailsCreate,
  buildEnvSpecificDetailsUpdate,
  buildSourceFieldsCreate,
  envVarsToWire,
  findServiceByLookup,
  hydrateService,
  listServicesByType,
  mapBaseServiceAttrs,
  mergeBoundEnvVars,
  readServiceForProvider,
  runtimeOfSource,
  secretFilesToWire,
  syncNotificationOverride,
  syncResourceLogStream,
  syncServiceSuspension,
  validateRuntimeSource,
  waitForServiceLive,
  type BaseServiceProps,
  type HydratedServiceData,
  type ServiceAttributes,
} from "./internal/ServiceBase.ts";
import type { Providers } from "./Providers.ts";
import type { RenderServiceBinding } from "./RenderBindings.ts";
import type { PaidPlan, Region } from "./Types.ts";

export interface CronJobProps extends BaseServiceProps {
  /** Paid instance plan (`"starter"`, `"standard"`, `"pro"`, etc.). */
  plan?: PaidPlan;
  /** Deployment region (`oregon`, `ohio`, `virginia`, `frankfurt`, `singapore`). Changing it replaces the cron job. */
  region?: Region;
  /** Standard 5-field cron schedule expression (for example `"0 * * * *"`). */
  schedule: string;
}

export interface CronJobAttributes extends ServiceAttributes {
  /** Active cron schedule expression. */
  schedule: string;
  /** Timestamp of the most recent successful cron run, if any. */
  lastSuccessfulRunAt?: string;
}

export interface CronJobLookup {
  /** Look up an existing cron job by Render service ID (`srv-...`). */
  id?: string;
  /** Look up an existing cron job by exact name. */
  name?: string;
  /** Optional owner ID override for name lookup. */
  ownerId?: string;
}

/**
 * A Render Cron Job runs a scheduled task command or container on a standard
 * cron expression.
 *
 * **Example:** Hourly cleanup cron job
 * ```typescript
 * const cleanup = yield* Render.CronJob("Cleanup", {
 *   name: "hourly-cleanup",
 *   plan: "starter",
 *   region: "oregon",
 *   schedule: "0 * * * *",
 *   runtimeSource: {
 *     image: { imagePath: "ghcr.io/org/cleanup", tag: "latest" },
 *   },
 *   startCommand: "node dist/cleanup.js",
 * });
 * ```
 *
 * @resource
 * @product Compute
 * @category Compute
 */
export interface CronJob extends Resource<
  "Render.CronJob",
  CronJobProps,
  CronJobAttributes,
  RenderServiceBinding,
  Providers,
  CronJobLookup
> {}

export const CronJob = Resource<CronJob>("Render.CronJob");

const mapCronJob = (data: HydratedServiceData): CronJobAttributes => ({
  ...mapBaseServiceAttrs(data),
  schedule: data.service.serviceDetails.schedule ?? "",
  lastSuccessfulRunAt: data.service.serviceDetails.lastSuccessfulRunAt,
});

export const CronJobProvider = () =>
  Provider.effect(
    CronJob,
    Effect.succeed({
      stables: ["id", "slug"],
      nuke: {
        dependsOn: [
          "Render.Environment",
          "Render.Project",
          "Render.RegistryCredential",
          "Render.EnvGroup",
        ],
      },
      diff: Effect.fn(function* ({ news, olds, output }) {
        if (!isResolved(news)) return undefined;
        if (news.region !== undefined && olds.region !== undefined && news.region !== olds.region) {
          const deleteFirst =
            typeof news.name === "string" && news.name === (output?.name ?? olds.name);
          return { action: "replace", deleteFirst } as const;
        }
        return undefined;
      }),
      read: Effect.fn(function* ({ id, olds, output, previous }) {
        return yield* readServiceForProvider({
          serviceType: "cron_job",
          id,
          olds,
          output,
          previous,
          toAttributes: mapCronJob,
        });
      }),
      logs: Effect.fn(function* ({ output, options }) {
        return yield* renderResourceLogs({
          ownerId: output.ownerId,
          resourceId: output.id,
          options,
        });
      }),
      tail: ({ output }) =>
        renderResourceTail({
          ownerId: output.ownerId,
          resourceId: output.id,
        }),
      lookup: Effect.fn(function* (props) {
        const hydrated = yield* findServiceByLookup("cron_job", props);
        return hydrated ? mapCronJob(hydrated) : undefined;
      }),
      list: Effect.fn(function* () {
        const all = yield* listServicesByType("cron_job");
        return all.map(mapCronJob);
      }),
      reconcile: Effect.fn(function* ({ id, news, output, bindings }) {
        yield* validateRuntimeSource(news.runtimeSource, news.startCommand);
        const desiredName = news.name ?? (yield* createPhysicalName({ id, maxLength: 64 }));
        const existing = output?.id
          ? yield* Client.ignoreNotFound(Client.getService(output.id))
          : undefined;
        const mergedEnv = mergeBoundEnvVars(
          news.envVars,
          bindings.map((b) => b.data),
        );
        const runtime = runtimeOfSource(news.runtimeSource);

        if (!existing) {
          const ownerId = yield* Client.resolveOwnerId(news.ownerId);
          const envVarsWire = envVarsToWire(mergedEnv, [], false);
          const secretFilesWire = secretFilesToWire(news.secretFiles);
          const createdRes = yield* Client.createService({
            name: desiredName,
            ownerId,
            type: "cron_job",
            ...(news.rootDirectory !== undefined ? { rootDir: news.rootDirectory } : {}),
            ...(envVarsWire.length > 0 ? { envVars: envVarsWire } : {}),
            ...(secretFilesWire.length > 0 ? { secretFiles: secretFilesWire } : {}),
            serviceDetails: {
              runtime,
              plan: news.plan ?? "starter",
              ...(news.buildPlan !== undefined ? { buildPlan: news.buildPlan } : {}),
              ...(news.region !== undefined ? { region: news.region } : {}),
              schedule: news.schedule,
              envSpecificDetails: buildEnvSpecificDetailsCreate(
                news.runtimeSource,
                news.startCommand,
              ),
            },
            ...buildSourceFieldsCreate(news.runtimeSource, ownerId),
          });
          const service = createdRes.service
            ? createdRes.service
            : yield* Client.listServices({
                ownerId: [ownerId],
                name: [desiredName],
                type: ["cron_job"],
              }).pipe(Effect.map((rows) => rows[0]));

          if (news.environmentId !== undefined) {
            yield* Client.syncResourceEnvironment(
              service.id,
              service.environmentId,
              news.environmentId,
            );
          }
          if (news.notificationOverride) {
            yield* syncNotificationOverride(service.id, news.notificationOverride, false);
          }
          if (news.logStreamOverride) {
            yield* syncResourceLogStream(service.id, undefined, news.logStreamOverride);
          }
          yield* syncServiceSuspension(service.id, service.suspended, news.suspended);
          if (news.waitForDeployCompletion) {
            yield* waitForServiceLive("Render.CronJob", service.id);
          }
          const fresh = yield* Client.getService(service.id);
          return mapCronJob(yield* hydrateService(fresh));
        }

        const hydratedBefore = yield* hydrateService(existing);
        yield* Client.updateService(existing.id, {
          name: desiredName,
          ...(news.rootDirectory !== undefined ? { rootDir: news.rootDirectory } : {}),
          serviceDetails: {
            runtime,
            plan: news.plan ?? "starter",
            ...(news.buildPlan !== undefined ? { buildPlan: news.buildPlan } : {}),
            schedule: news.schedule,
            envSpecificDetails: buildEnvSpecificDetailsUpdate(
              news.runtimeSource,
              news.startCommand,
            ),
          },
          ...buildSourceFieldsCreate(news.runtimeSource, existing.ownerId),
        });

        yield* Client.putServiceEnvVars(
          existing.id,
          envVarsToWire(mergedEnv, hydratedBefore.envVars, true),
        );
        yield* Client.putServiceSecretFiles(existing.id, secretFilesToWire(news.secretFiles));
        yield* syncNotificationOverride(
          existing.id,
          news.notificationOverride,
          hydratedBefore.notificationOverride !== undefined,
        );
        yield* syncResourceLogStream(
          existing.id,
          hydratedBefore.logStreamOverride,
          news.logStreamOverride,
        );
        yield* Client.syncResourceEnvironment(
          existing.id,
          existing.environmentId,
          news.environmentId,
        );
        yield* syncServiceSuspension(existing.id, existing.suspended, news.suspended);

        if (!news.skipDeployAfterUpdate) {
          yield* Client.createDeploy(existing.id);
        }
        if (news.waitForDeployCompletion) {
          yield* waitForServiceLive("Render.CronJob", existing.id);
        }
        const refreshed = yield* Client.getService(existing.id);
        return mapCronJob(yield* hydrateService(refreshed));
      }),
      delete: Effect.fn(function* ({ output }) {
        if (!output?.id) return;
        yield* Client.deleteService(output.id);
      }),
    }),
  );
