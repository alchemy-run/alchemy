/**
 * The `Celld.Worker` provider: bundles the Worker and stages its immutable
 * deployment in the fleet's bucket. Deploy-time only — kept apart from
 * `Worker.ts` so runtime callers (`bindWorker`) never bundle the bundler.
 */
import { DockerLive } from "@alchemy.run/docker/Docker";
import * as Artifacts from "alchemy/Artifacts";
import { deepEqual, isResolved, stripEffects } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import type { ResourceBinding } from "alchemy/Resource";
import { packEnvValue } from "alchemy/RuntimeContext";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Redacted from "effect/Redacted";
import { readAssets } from "./Assets.ts";
import { CelldWorkerBundle, workerBuildOptions } from "./Build.ts";
import {
  assertContainerUpdateSafe,
  prepareContainerImages,
  validateContainerHost,
} from "./Containers/Images.ts";
import {
  prepareDeployment,
  stageAssetBlobs,
  stageContainerArtifacts,
  stageDeployment,
  DeploymentError,
} from "./Deployment.ts";
import { digest, encode } from "./Deployment/Objects.ts";
import {
  deploymentMetadata,
  type CelldBinding,
  type CelldContainerConfig,
  type CelldQueueConsumer,
} from "./DeploymentConfig.ts";
import { FleetStorage } from "./FleetStorage.ts";
import { validateStorageBindings, type StorageBinding } from "./KV/StorageBinding.ts";
import {
  CELLD_RUNTIME_SERIES,
  DEFAULT_CELLD_VERSION,
  isSupportedCelldVersion,
} from "./RuntimeVersion.ts";
// `CurrentFleet` is also a requirement of the Worker resource itself, so an
// impl that declares fleet-scoped storage still surfaces it on the Layer.
import {
  Worker,
  WorkerNotConnected,
  type CelldWorkerBindingContract,
  type CelldWorkerResourceProps,
} from "./Worker.ts";
import { FLEET_DEPLOYMENT_VAR, FLEET_SECRET_VAR } from "./WorkerBridge.ts";
import { computeFleetMigrations, type FleetDurableObjectBinding } from "./Wrangler.ts";

const DEFAULT_COMPATIBILITY_DATE = "2025-06-01";
const DEFAULT_COMPATIBILITY_FLAGS = ["nodejs_compat"];

/** Render a wrangler `vars` value: strings verbatim, everything else packed
 * so the runtime `get` accessor round-trips it (Redacted markers included). */
const renderVar = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Redacted.isRedacted(value)
      ? Redacted.value(value as Redacted.Redacted<any>)
      : packEnvValue(value);

const collectBindings = (bindings: readonly ResourceBinding<CelldWorkerBindingContract>[]) => {
  const durableObjects: FleetDurableObjectBinding[] = [];
  const env: Record<string, unknown> = {};
  const nativeBindings: CelldBinding[] = [];
  const storageBindings: StorageBinding[] = [];
  const queueConsumers: CelldQueueConsumer[] = [];
  const crons: string[] = [];
  const containers: CelldContainerConfig[] = [];
  for (const binding of bindings) {
    durableObjects.push(...(binding.data?.durableObjects ?? []));
    nativeBindings.push(...(binding.data?.bindings ?? []));
    storageBindings.push(...(binding.data?.storageBindings ?? []));
    queueConsumers.push(...(binding.data?.queueConsumers ?? []));
    crons.push(...(binding.data?.crons ?? []));
    containers.push(...(binding.data?.containers ?? []));
    Object.assign(env, binding.data?.env ?? {});
  }
  const unique = <T>(values: T[]) =>
    values.filter(
      (value, index) => !values.slice(0, index).some((previous) => deepEqual(previous, value)),
    );
  return {
    durableObjects: unique(durableObjects),
    env,
    nativeBindings: unique(nativeBindings),
    storageBindings: unique(storageBindings),
    queueConsumers,
    crons: [...new Set(crons)],
    containers: unique(containers),
  };
};

const buildBundle = (id: string, news: CelldWorkerResourceProps) =>
  Effect.gen(function* () {
    const stack = yield* Stack;
    const bundler = yield* CelldWorkerBundle;
    return yield* bundler.build({
      id,
      main: news.main,
      compatibility: {
        date: news.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
        flags: news.compatibilityFlags ?? DEFAULT_COMPATIBILITY_FLAGS,
      },
      entry: news.isExternal
        ? { kind: "external" }
        : { kind: "effect", exports: news.exports ?? {} },
      stack: { name: stack.name, stage: stack.stage },
      extraOptions: yield* workerBuildOptions(news.build),
    });
  }).pipe(Artifacts.cached("build"));

/**
 * The `Celld.Worker` provider: the deployment lifecycle for workers
 * targeted at a celld fleet. Registered by `Celld.providers()`.
 */
export const CelldWorkerProvider = () =>
  Provider.succeed(Worker, {
    read: ({ output }) => Effect.succeed(output),

    // Source changes are not prop-visible; compare the bundle and asset hashes.
    diff: Effect.fn(function* ({ id, news: desired, output, newBindings }) {
      if (output === undefined) {
        return;
      }
      // Image tags, Dockerfile contexts, and generated programs can change outside Worker props.
      if (
        output.preparedContainers?.length ||
        (isResolved(newBindings) && collectBindings(newBindings).containers.length)
      ) {
        return { action: "update" } as const;
      }
      // Export constructors are runtime Effects, not unresolved deployment inputs.
      // Keep their class metadata for the virtual entry, as persisted props do.
      const news = stripEffects(desired);
      if (!isResolved(news)) return;
      const bundle = yield* buildBundle(id, news);
      const assets = news.assets
        ? yield* readAssets(news.main, news.assets, {
            date: news.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
            flags: news.compatibilityFlags ?? DEFAULT_COMPATIBILITY_FLAGS,
          })
        : undefined;
      const assetsHash = assets ? yield* digest(yield* encode(assets.index)) : undefined;
      if (bundle.hash !== output.code.hash || assetsHash !== output.code.assetsHash) {
        return { action: "update" } as const;
      }
    }),

    reconcile: Effect.fn(function* ({ id, news, output, session, bindings }) {
      if (!news.bucket || !news.fleetUrl || !news.fleetSecret || !news.fleetId) {
        return yield* new WorkerNotConnected({
          message: `Celld.Worker '${id}' requires Celld.Fleet.layer(Cells) on its implementation layer.`,
        });
      }
      if (!isSupportedCelldVersion(news.celldVersion ?? DEFAULT_CELLD_VERSION)) {
        return yield* new DeploymentError({
          reason: "unsupported",
          message: `Celld.Worker deploys to Celld ${CELLD_RUNTIME_SERIES}.x fleets; got ${news.celldVersion}.`,
        });
      }
      const collected = collectBindings(bindings);
      yield* validateStorageBindings(news, [
        ...(news.storageBindings ?? []),
        ...collected.storageBindings,
      ]);
      const { migrations, classes } = yield* computeFleetMigrations({
        history: output?.migrations,
        oldClasses: output?.durableObjectClasses,
        current: collected.durableObjects,
      });
      yield* session.note("bundling worker");
      const bundle = yield* buildBundle(id, news);
      const deploymentId = bundle.hash.slice(0, 16);
      const scriptName =
        output?.workerName ?? (yield* createPhysicalName({ id, maxLength: 63, lowercase: true }));
      const vars: Record<string, string> = {};
      for (const [key, value] of Object.entries({
        ...news.env,
        ...collected.env,
      })) {
        if (value !== undefined) vars[key] = renderVar(value);
      }
      vars[FLEET_SECRET_VAR] = Redacted.value(news.fleetSecret);
      vars[FLEET_DEPLOYMENT_VAR] = deploymentId;
      const compatibility = {
        date: news.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
        flags: news.compatibilityFlags ?? DEFAULT_COMPATIBILITY_FLAGS,
      };
      const native = yield* deploymentMetadata({
        scriptName,
        mainModule: bundle.files[0].path,
        compatibilityDate: compatibility.date,
        compatibilityFlags: compatibility.flags,
        bindings: [...(news.bindings ?? []), ...collected.nativeBindings],
        durableObjects: collected.durableObjects,
        vars,
        queueConsumers: collected.queueConsumers,
        assets: news.assets,
      });
      const containerHost = yield* validateContainerHost({
        declarations: collected.containers,
        doClasses: native.doClasses,
        sqliteClasses: native.sqliteClasses,
        hostState: news.hostState,
      });
      const platform = containerHost.platform;
      const fs = yield* FileSystem.FileSystem;
      const containerImages =
        platform === undefined
          ? { containers: [], images: [], fenceImage: undefined }
          : yield* prepareContainerImages({
              declarations: containerHost.declarations,
              platform,
              archiveDirectory: yield* fs.makeTempDirectoryScoped({
                prefix: "alchemy-celld-images-",
              }),
            }).pipe(Effect.provide(DockerLive));
      yield* assertContainerUpdateSafe(
        output?.preparedContainers ?? [],
        containerImages.containers,
      );
      const localContainerArtifacts = yield* Effect.forEach(containerImages.images, (image) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const body = yield* fs.readFile(image.path);
          return {
            image: image.image,
            key: image.key,
            sha256: yield* digest(body),
            bytes: body.length,
            body,
          };
        }),
      );
      const assets = news.assets
        ? yield* readAssets(news.main, news.assets, compatibility)
        : undefined;
      const assetsHash = assets ? yield* digest(yield* encode(assets.index)) : undefined;
      const storage = yield* FleetStorage;
      const store = yield* storage(news);
      yield* session.note("staging immutable worker deployment");
      const containerArtifacts = yield* stageContainerArtifacts(store, localContainerArtifacts);
      const prepared = yield* prepareDeployment({
        scriptName,
        mainModule: bundle.files[0].path,
        modules: bundle.files.map((file) => ({
          name: file.path,
          content: file.content,
        })),
        ...native,
        crons: collected.crons,
        assets,
        containers: containerImages.containers,
        fenceImage: containerImages.fenceImage,
        containerArtifacts,
      });
      yield* stageAssetBlobs(store, prepared);
      yield* stageDeployment(store, prepared);
      return {
        workerName: scriptName,
        url: news.fleetUrl,
        fleetUrl: news.fleetUrl,
        hostState: news.hostState,
        deploymentId,
        versionId: prepared.version,
        fleetId: news.fleetId,
        prefix: prepared.prefix,
        stagedManifestKey: prepared.candidate.key,
        preparedContainers: containerImages.containers,
        durableObjectClasses: classes,
        migrations,
        code: { hash: bundle.hash, assetsHash },
      };
    }, Effect.scoped),

    // Retain immutable artifacts and data; Application owns live publication.
    delete: () => Effect.void,

    list: () => Effect.succeed([]),
  });
