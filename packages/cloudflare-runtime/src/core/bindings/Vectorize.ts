import { loadInternalWorker } from "../internal/internal-worker.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
const VectorizeWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/bindings/Vectorize.worker",
    ),
};
import * as Storage from "../globals/Storage.ts";
import { DEFAULT_COMPATIBILITY_DATE } from "../internal/constants.ts";
import { formatInternalWorkerModules } from "../internal/internal-modules.ts";
import * as Plugin from "../Plugin.ts";
import type { BindingHook } from "../PluginContext.ts";
import { makeRemoteBinding } from "../remote-bindings/RemoteBindings.ts";
import { ConfigError } from "../RuntimeError.shared.ts";
import type * as WorkerdConfig from "../workerd/Config.ts";
import type { VectorizeProps } from "./VectorizeOptions.shared.ts";
const SERVICE_VECTORIZE = "vectorize";
const SERVICE_VECTORIZE_STORAGE = "vectorize:storage";
const VECTORIZE_OBJECT_CLASS_NAME = "VectorizeObject";
const BINDING_VECTORIZE_OBJECT = "OBJECT";

export class Vectorize extends Plugin.Service<
  Vectorize,
  {
    /**
     * Record that an index is in use (so the Vectorize services are only emitted
     * when at least one binding exists) and resolve the service designator
     * the binding should target: the shared `vectorize` service, with the index
     * id carried via designator props.
     */
    readonly register: (
      props: VectorizeProps,
    ) => Effect.Effect<WorkerdConfig.ServiceDesignator>;
  }
>()("cloudflare-runtime/plugin/Vectorize") {}

export const VectorizeLive = Layer.effect(
  Vectorize,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const storage = yield* Storage.Storage;

    const makeStorageService = Effect.gen(function* () {
      const storageDiskPath =
        "disk" in storage ? storage.disk?.path : undefined;
      if (!storageDiskPath) {
        return yield* new ConfigError({
          subtag: "Vectorize",
          message:
            "Cannot configure Vectorize persistence: the Storage service has no disk path.",
          hint: "Configure a disk-backed storage layer (`Storage.layerDisk` or `Storage.layerTemp`).",
        });
      }
      const persistPath = path.join(storageDiskPath, "vectorize");
      yield* fs.makeDirectory(persistPath, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new ConfigError({
              subtag: "Vectorize",
              message: `Failed to create Vectorize persistence directory "${persistPath}": ${cause.message}`,
              hint: "Ensure the storage directory is writable.",
              detail: { persistPath },
              cause,
            }),
        ),
      );
      return {
        name: SERVICE_VECTORIZE_STORAGE,
        disk: { path: persistPath, writable: true },
      } satisfies WorkerdConfig.Service;
    });

    return Vectorize.of(
      Effect.sync(() => {
        let used = false;

        return {
          api: {
            register: (props) =>
              Effect.sync(() => {
                used = true;
                return {
                  name: SERVICE_VECTORIZE,
                  props: { json: JSON.stringify(props) },
                };
              }),
          },
          defer: Effect.gen(function* () {
            if (!used) return {};
            const storageService = yield* makeStorageService;
            const vectorizeService: WorkerdConfig.Service = {
              name: SERVICE_VECTORIZE,
              worker: {
                compatibilityDate: DEFAULT_COMPATIBILITY_DATE,
                modules: formatInternalWorkerModules(
                  yield* Effect.promise(VectorizeWorker.worker),
                ),
                durableObjectNamespaces: [
                  {
                    className: VECTORIZE_OBJECT_CLASS_NAME,
                    enableSql: true,
                    uniqueKey: `cloudflare-runtime-${VECTORIZE_OBJECT_CLASS_NAME}`,
                    preventEviction: true,
                  },
                ],
                durableObjectStorage: { localDisk: SERVICE_VECTORIZE_STORAGE },
                bindings: [
                  {
                    name: BINDING_VECTORIZE_OBJECT,
                    durableObjectNamespace: {
                      className: VECTORIZE_OBJECT_CLASS_NAME,
                    },
                  },
                ],
              },
            };
            return { services: [storageService, vectorizeService] };
          }),
        };
      }),
    );
  }),
);

/**
 * Persistent local Vectorize V2 binding using exact nearest-neighbor search.
 * Mutations become visible immediately; cloud indexing latency and ANN recall
 * are deliberately not simulated. Metadatan indexes are declared in props.
 */
export const local = (props: VectorizeProps): BindingHook<Vectorize> =>
  Plugin.use(Vectorize, (vectorize) =>
    Effect.map(
      vectorize.api.register(props),
      (service): WorkerdConfig.Worker_Binding => ({
        name: props.binding,
        wrapped: {
          moduleName: "cloudflare-internal:vectorize-api",
          innerBindings: [
            { name: "fetcher", service },
            { name: "indexId", text: props.indexName },
            { name: "indexVersion", text: "v2" },
            { name: "useNdJson", json: "true" },
          ],
        },
      }),
    ),
  );

export const remote = (binding: string, indexName: string) =>
  makeRemoteBinding(
    {
      name: binding,
      type: "vectorize",
      indexName,
      raw: true,
    },
    (service) => ({
      name: binding,
      wrapped: {
        moduleName: "cloudflare-internal:vectorize-api",
        innerBindings: [
          {
            name: "fetcher",
            service,
          },
          {
            name: "indexId",
            text: indexName,
          },
          {
            name: "indexVersion",
            text: "v2",
          },
          {
            name: "useNdJson",
            json: "true",
          },
        ],
      },
    }),
  );
