import { loadInternalWorker } from "../../internal/internal-worker.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
const AnalyticsEngineWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/bindings/analytics-engine/AnalyticsEngineStore.worker",
    ),
};
import * as Storage from "../../globals/Storage.ts";
import { DEFAULT_COMPATIBILITY_DATE } from "../../internal/constants.ts";
import {
  formatInternalWorkerModules,
  formatExtensionModule,
} from "../../internal/internal-modules.ts";
import * as Plugin from "../../Plugin.ts";
import type { BindingHook } from "../../PluginContext.ts";
import { ConfigError } from "../../RuntimeError.shared.ts";
import type * as WorkerdConfig from "../../workerd/Config.ts";
import type { AnalyticsEngineServiceProps } from "./AnalyticsEngineOptions.shared.ts";
const SERVICE_ANALYTICS = "analytics-engine";
const SERVICE_ANALYTICS_STORAGE = "analytics-engine:storage";
const ANALYTICS_OBJECT_CLASS_NAME = "AnalyticsEngineObject";
const BINDING_ANALYTICS_OBJECT = "OBJECT";

const AnalyticsEngineBindingWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/bindings/analytics-engine/analytics-engine.worker",
    ),
};

export class AnalyticsEngine extends Plugin.Service<
  AnalyticsEngine,
  {
    /**
     * Record that a dataset is in use (so the AnalyticsEngine services are only emitted
     * when at least one binding exists) and resolve the service designator
     * the binding should target: the shared `analytics-engine` service, with the dataset
     * name carried via designator props.
     */
    readonly register: (
      props: AnalyticsEngineServiceProps,
    ) => Effect.Effect<WorkerdConfig.ServiceDesignator>;
  }
>()("cloudflare-runtime/plugin/AnalyticsEngine") {}

export const AnalyticsEngineLive = Layer.effect(
  AnalyticsEngine,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const storage = yield* Storage.Storage;

    const makeStorageService = Effect.gen(function* () {
      const storageDiskPath =
        "disk" in storage ? storage.disk?.path : undefined;
      if (!storageDiskPath) {
        return yield* new ConfigError({
          subtag: "AnalyticsEngine",
          message:
            "Cannot configure AnalyticsEngine persistence: the Storage service has no disk path.",
          hint: "Configure a disk-backed storage layer (`Storage.layerDisk` or `Storage.layerTemp`).",
        });
      }
      const persistPath = path.join(storageDiskPath, "analytics-engine");
      yield* fs.makeDirectory(persistPath, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new ConfigError({
              subtag: "AnalyticsEngine",
              message: `Failed to create AnalyticsEngine persistence directory "${persistPath}": ${cause.message}`,
              hint: "Ensure the storage directory is writable.",
              detail: { persistPath },
              cause,
            }),
        ),
      );
      return {
        name: SERVICE_ANALYTICS_STORAGE,
        disk: { path: persistPath, writable: true },
      } satisfies WorkerdConfig.Service;
    });

    return AnalyticsEngine.of(
      Effect.sync(() => {
        let used = false;

        return {
          api: {
            register: (props) =>
              Effect.sync(() => {
                used = true;
                return {
                  name: SERVICE_ANALYTICS,
                  props: { json: JSON.stringify(props) },
                };
              }),
          },
          defer: Effect.gen(function* () {
            if (!used) return {};
            const storageService = yield* makeStorageService;
            const analyticsEngineService: WorkerdConfig.Service = {
              name: SERVICE_ANALYTICS,
              worker: {
                compatibilityDate: DEFAULT_COMPATIBILITY_DATE,
                modules: formatInternalWorkerModules(
                  yield* Effect.promise(AnalyticsEngineWorker.worker),
                ),
                durableObjectNamespaces: [
                  {
                    className: ANALYTICS_OBJECT_CLASS_NAME,
                    enableSql: true,
                    uniqueKey: `cloudflare-runtime-${ANALYTICS_OBJECT_CLASS_NAME}`,
                    preventEviction: true,
                  },
                ],
                durableObjectStorage: { localDisk: SERVICE_ANALYTICS_STORAGE },
                bindings: [
                  {
                    name: BINDING_ANALYTICS_OBJECT,
                    durableObjectNamespace: {
                      className: ANALYTICS_OBJECT_CLASS_NAME,
                    },
                  },
                ],
              },
            };
            return {
              services: [storageService, analyticsEngineService],
              extensions: [
                {
                  modules: [
                    {
                      name: "cloudflare-runtime:analytics-engine",
                      internal: true,
                      esModule: yield* formatExtensionModule(
                        AnalyticsEngineBindingWorker,
                      ),
                    },
                  ],
                },
              ],
            };
          }),
        };
      }),
    );
  }),
);

/**
 * Persist local Analytics Engine points. In addition to writeDataPoint, local
 * bindings expose getDataPoints() and query(sql) for development inspection.
 * Queries use SQLite's SELECT dialect, without production adaptive sampling.
 */
export const local = (
  binding: string,
  dataset: string,
): BindingHook<AnalyticsEngine> =>
  Plugin.use(AnalyticsEngine, (analyticsEngine) =>
    Effect.map(
      analyticsEngine.api.register({ dataset }),
      (service): WorkerdConfig.Worker_Binding => ({
        name: binding,
        wrapped: {
          moduleName: "cloudflare-runtime:analytics-engine",
          innerBindings: [
            { name: "dataset", text: dataset },
            { name: "store", service },
          ],
        },
      }),
    ),
  );
