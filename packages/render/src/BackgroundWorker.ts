import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { renderResourceLogs, renderResourceTail } from "./internal/Logs.ts";
import {
  deleteServiceById,
  findServiceByLookup,
  listServicesByType,
  mapBaseServiceAttrs,
  readServiceForProvider,
  reconcileLongRunningService,
  type HydratedServiceData,
  type LongRunningServiceProps,
  type ServiceAttributes,
} from "./internal/ServiceBase.ts";
import type { Providers } from "./Providers.ts";
import type { RenderServiceBinding } from "./RenderBindings.ts";
import type { PaidPlan } from "./Types.ts";

export interface BackgroundWorkerProps extends LongRunningServiceProps {
  /** Paid instance plan (`"starter"`, `"standard"`, `"pro"`, `"pro_plus"`, `"pro_max"`, `"pro_ultra"`, etc.). */
  plan?: PaidPlan;
}

export type BackgroundWorkerAttributes = ServiceAttributes;

export interface BackgroundWorkerLookup {
  /** Look up an existing background worker by Render service ID (`srv-...`). */
  id?: string;
  /** Look up an existing background worker by exact name. */
  name?: string;
  /** Optional owner ID override for name lookup. */
  ownerId?: string;
}

/**
 * A Render Background Worker runs long-lived queue consumers, job processors,
 * or non-HTTP daemons with optional persistent disks and autoscaling.
 *
 * **Example:** Python background worker
 * ```typescript
 * const worker = yield* Render.BackgroundWorker("QueueWorker", {
 *   name: "queue-worker",
 *   plan: "starter",
 *   region: "oregon",
 *   runtimeSource: {
 *     nativeRuntime: {
 *       runtime: "python",
 *       repo: "https://github.com/org/repo",
 *       branch: "main",
 *       buildCommand: "pip install -r requirements.txt",
 *     },
 *   },
 *   startCommand: "python worker.py",
 * });
 * ```
 *
 * @resource
 * @product Compute
 * @category Compute
 */
export interface BackgroundWorker extends Resource<
  "Render.BackgroundWorker",
  BackgroundWorkerProps,
  BackgroundWorkerAttributes,
  RenderServiceBinding,
  Providers,
  BackgroundWorkerLookup
> {}

export const BackgroundWorker = Resource<BackgroundWorker>("Render.BackgroundWorker");

export const BackgroundWorkerProvider = () =>
  Provider.effect(
    BackgroundWorker,
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
          serviceType: "background_worker",
          id,
          olds,
          output,
          previous,
          toAttributes: mapBaseServiceAttrs,
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
        const hydrated = yield* findServiceByLookup("background_worker", props);
        return hydrated ? mapBaseServiceAttrs(hydrated) : undefined;
      }),
      list: Effect.fn(function* () {
        const all = yield* listServicesByType("background_worker");
        return all.map(mapBaseServiceAttrs);
      }),
      reconcile: Effect.fn(function* ({ id, news, olds, output, bindings }) {
        const desiredName = news.name ?? (yield* createPhysicalName({ id, maxLength: 64 }));
        return yield* reconcileLongRunningService<
          BackgroundWorkerProps,
          BackgroundWorkerAttributes
        >({
          resourceType: "Render.BackgroundWorker",
          serviceType: "background_worker",
          id,
          news,
          olds,
          output,
          desiredName,
          bindings: bindings.map((b) => b.data),
          defaultPlan: "starter",
          extraCreateDetails: () => ({}),
          extraUpdateDetails: () => ({}),
          toAttributes: (data: HydratedServiceData) => mapBaseServiceAttrs(data),
        });
      }),
      delete: Effect.fn(function* ({ output }) {
        if (!output?.id) return;
        yield* deleteServiceById(output.id);
      }),
    }),
  );
