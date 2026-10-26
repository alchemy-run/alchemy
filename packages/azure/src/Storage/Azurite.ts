import * as crypto from "node:crypto";
/**
 * Local Azure Storage for `alchemy dev`: [Azurite](https://github.com/Azure/Azurite),
 * Microsoft's Storage emulator, run as a Docker container, plus the local
 * providers of `Azure.Storage.StorageAccount`, `BlobContainer`, and `Queue`
 * that create their containers and queues in it.
 *
 * Every local storage account is Azurite's one development account
 * (`devstoreaccount1`). Calls are signed with an account SAS made from
 * Azurite's documented, public development key, so no Azure credentials are
 * needed. A local `Azure.Functions.Function` gets the emulator endpoints in
 * its env and sends its Storage binding calls there (see
 * `Bootstrap/FunctionsLocalCore.ts`).
 *
 * The container is started detached with a stable name (`alchemy-azurite`):
 * Docker supervises it, so its data outlives `alchemy dev` sessions and the
 * next session reuses it.
 */
import { Credentials, fromStaticToken } from "@distilled.cloud/azure";
import * as blob from "@distilled.cloud/azure/storage-blob";
import * as queue from "@distilled.cloud/azure/storage-queue";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { LOCAL_ID_PREFIX } from "alchemy/ProviderMode";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { BlobContainer } from "./BlobContainer.ts";
import { Queue } from "./Queue.ts";
import { StorageAccount } from "./StorageAccount.ts";
import { createStorageChildName, ownershipMetadata } from "./StorageOwnership.ts";

/** The Azurite release the local providers run. */
export const AZURITE_IMAGE = "mcr.microsoft.com/azure-storage/azurite:3.35.0";

/** Name of the managed Azurite container. */
export const AZURITE_CONTAINER = "alchemy-azurite";

/** Azurite's development account: every local storage account maps to it. */
export const AZURITE_ACCOUNT = "devstoreaccount1";

/**
 * Azurite's development account key. Microsoft publishes it in the Azurite
 * docs; it only opens the local emulator.
 */
const AZURITE_KEY =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";

/**
 * Host ports of the Blob, Queue, and Table services. They differ from
 * Azurite's defaults (10000-10002), so an Azurite the developer runs
 * themselves keeps its ports.
 */
export const AZURITE_PORTS = { blob: 10100, queue: 10101, table: 10102 } as const;

/** Where the local emulator serves, and the SAS that signs every call. */
export interface AzuriteEndpoints {
  /** `http://127.0.0.1:10100/devstoreaccount1` */
  readonly blob: string;
  /** `http://127.0.0.1:10101/devstoreaccount1` */
  readonly queue: string;
  /** `http://127.0.0.1:10102/devstoreaccount1` */
  readonly table: string;
  /** Account SAS query (no leading `?`) for every service, resource type, and permission. */
  readonly sas: string;
}

/**
 * An account SAS over Blob, Queue, and Table with every permission, valid
 * until 2099, signed with the development key.
 * @see https://learn.microsoft.com/rest/api/storageservices/create-account-sas
 */
const accountSas = () => {
  const fields = {
    sv: "2021-08-06",
    ss: "bqt",
    srt: "sco",
    sp: "rwdxylacuptfi",
    se: "2099-12-31T00:00:00Z",
    spr: "http,https",
  };
  const stringToSign = [
    AZURITE_ACCOUNT,
    fields.sp,
    fields.ss,
    fields.srt,
    "", // signed start
    fields.se,
    "", // signed IP
    fields.spr,
    fields.sv,
    "", // encryption scope
    "",
  ].join("\n");
  const sig = crypto
    .createHmac("sha256", Buffer.from(AZURITE_KEY, "base64"))
    .update(stringToSign, "utf8")
    .digest("base64");
  return new URLSearchParams({ ...fields, sig }).toString();
};

/** The emulator's endpoints and SAS. Pure: it does not start anything. */
export const azuriteEndpoints: Effect.Effect<AzuriteEndpoints> = Effect.sync(() => ({
  blob: `http://127.0.0.1:${AZURITE_PORTS.blob}/${AZURITE_ACCOUNT}`,
  queue: `http://127.0.0.1:${AZURITE_PORTS.queue}/${AZURITE_ACCOUNT}`,
  table: `http://127.0.0.1:${AZURITE_PORTS.table}/${AZURITE_ACCOUNT}`,
  sas: accountSas(),
}));

/**
 * Env a local runtime reads to reach the emulator (see
 * `Bootstrap/FunctionsLocalCore.ts`).
 */
export const azuriteEnv = Effect.map(azuriteEndpoints, (endpoints) => ({
  ALCHEMY_AZURITE_ACCOUNT: AZURITE_ACCOUNT,
  ALCHEMY_AZURITE_BLOB: endpoints.blob,
  ALCHEMY_AZURITE_QUEUE: endpoints.queue,
  ALCHEMY_AZURITE_TABLE: endpoints.table,
  ALCHEMY_AZURITE_SAS: endpoints.sas,
}));

export class AzuriteError extends Data.TaggedError("Azure.Storage.AzuriteError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Run a distilled Storage operation against the emulator. A SAS-signed call
 * never asks for a token; the static token only satisfies the type.
 */
const onEmulator = <A, E>(effect: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        fromStaticToken({ bearerToken: "azurite", subscriptionId: "" }),
        FetchHttpClient.layer,
      ),
    ),
  );

const sasUrl = (endpoint: string, sas: string) => `${endpoint}?${sas}`;

/** Run `docker <args>` and return stdout; a non-zero exit fails. */
const docker = (args: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(ChildProcess.make("docker", [...args]));
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0) {
        return yield* new AzuriteError({
          message: `docker ${args[0]} failed (exit ${exitCode}): ${stderr.trim()}`,
        });
      }
      return stdout;
    }),
  ).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        new AzuriteError({
          message: `could not run docker (${cause.message}). Local Azure Storage needs Docker; start it, or pipe the resource through Alchemy.remote()`,
          cause,
        }),
      ),
    ),
  );

/** Whether the emulator answers a signed Blob service call. */
const isServing = (endpoints: AzuriteEndpoints) =>
  onEmulator(blob.GetServiceProperties({ url: sasUrl(endpoints.blob, endpoints.sas) })).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  );

const waitUntilServing = (endpoints: AzuriteEndpoints) =>
  isServing(endpoints).pipe(
    Effect.repeat({
      until: (serving) => serving,
      schedule: Schedule.spaced("1 second"),
      times: 60,
    }),
    Effect.flatMap((serving) =>
      serving
        ? Effect.void
        : Effect.fail(
            new AzuriteError({
              message: `Azurite did not answer at ${endpoints.blob}; check \`docker logs ${AZURITE_CONTAINER}\``,
            }),
          ),
    ),
  );

const runContainer = docker([
  "run",
  "-d",
  "--name",
  AZURITE_CONTAINER,
  "-p",
  `127.0.0.1:${AZURITE_PORTS.blob}:10000`,
  "-p",
  `127.0.0.1:${AZURITE_PORTS.queue}:10001`,
  "-p",
  `127.0.0.1:${AZURITE_PORTS.table}:10002`,
  AZURITE_IMAGE,
  "azurite",
  "--location",
  "/data",
  "--blobHost",
  "0.0.0.0",
  "--queueHost",
  "0.0.0.0",
  "--tableHost",
  "0.0.0.0",
  // Distilled sends the newest Storage API version.
  "--skipApiVersionCheck",
  "--loose",
  // Path-style URLs (`/devstoreaccount1/...`) only.
  "--disableProductStyleUrl",
  "--disableTelemetry",
]);

// One ensure at a time per process, so two resources never race `docker run`.
const ensureMutex = Semaphore.makeUnsafe(1);

/**
 * Make sure Azurite serves on {@link AZURITE_PORTS}: reuse whatever answers,
 * else start (or restart) the managed container. Cheap when it is up: one
 * signed call.
 */
export const ensureAzurite = ensureMutex.withPermits(1)(
  Effect.gen(function* () {
    const endpoints = yield* azuriteEndpoints;
    if (yield* isServing(endpoints)) return endpoints;
    const started = yield* docker(["start", AZURITE_CONTAINER]).pipe(
      Effect.as(true),
      Effect.catchTag("Azure.Storage.AzuriteError", () => Effect.succeed(false)),
    );
    if (!started) {
      yield* Effect.logInfo(`azurite: starting ${AZURITE_CONTAINER} (${AZURITE_IMAGE})`);
      // A concurrent process may have created it since `start` failed.
      yield* runContainer.pipe(
        Effect.catchTag("Azure.Storage.AzuriteError", (error) =>
          docker(["inspect", "--format", "{{.Id}}", AZURITE_CONTAINER]).pipe(
            Effect.flatMap((id) => (id.trim() === "" ? Effect.fail(error) : Effect.void)),
            Effect.mapError(() => error),
          ),
        ),
      );
    }
    yield* waitUntilServing(endpoints);
    return endpoints;
  }),
);

/** `dev:` identity of a local storage object (no ARM ID exists locally). */
const localId = (kind: string, name: string) =>
  `${LOCAL_ID_PREFIX}azurite/${AZURITE_ACCOUNT}/${kind}/${name}`;

/**
 * Local `Azure.Storage.StorageAccount`: Azurite's development account. It
 * starts the emulator; its endpoints point at it.
 */
export const StorageAccountProviderLocal = () =>
  Provider.effect(
    StorageAccount,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const ensure = ensureAzurite.pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      return StorageAccount.Provider.of({
        stables: ["storageAccountName", "storageAccountId", "resourceGroup", "location"],
        list: () => Effect.succeed([]),
        reconcile: Effect.fn(function* ({ news }) {
          const endpoints = yield* ensure;
          return {
            storageAccountName: AZURITE_ACCOUNT,
            storageAccountId: localId("account", AZURITE_ACCOUNT),
            resourceGroup: news.resourceGroup,
            location: "local",
            sku: news.sku ?? "Standard_LRS",
            kind: news.kind ?? "StorageV2",
            isHnsEnabled: false,
            primaryEndpoints: {
              blob: `${endpoints.blob}/`,
              queue: `${endpoints.queue}/`,
              table: `${endpoints.table}/`,
              file: undefined,
              dfs: undefined,
              web: undefined,
            },
            dataCollaborationPolicy: news.dataCollaborationPolicy ?? {},
            tags: news.tags ?? {},
          };
        }),
        // The account is shared by every local resource; its containers
        // and queues are deleted by their own resources.
        delete: () => Effect.void,
      });
    }),
  );

/** Local `Azure.Storage.BlobContainer`: a container in Azurite. */
export const BlobContainerProviderLocal = () =>
  Provider.effect(
    BlobContainer,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const ensure = ensureAzurite.pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      return BlobContainer.Provider.of({
        stables: ["containerName", "storageAccount", "resourceGroup", "containerId"],
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news) || output === undefined) return undefined;
          if (news.name !== undefined && news.name !== output.containerName) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          const endpoints = yield* ensure;
          const url = sasUrl(endpoints.blob, endpoints.sas);
          const name = news.name ?? output?.containerName ?? (yield* createStorageChildName(id));
          const metadata = { ...news.metadata, ...(yield* ownershipMetadata(id)) };
          const publicAccess = news.publicAccess ?? "None";
          yield* onEmulator(
            blob.CreateContainer({
              url,
              containerName: name,
              metadata,
              xMsBlobPublicAccess:
                publicAccess === "None"
                  ? undefined
                  : publicAccess === "Blob"
                    ? "blob"
                    : "container",
            }),
          ).pipe(
            Effect.catchTag("ContainerAlreadyExists", () =>
              onEmulator(blob.SetContainerMetadata({ url, containerName: name, metadata })),
            ),
          );
          return {
            containerName: name,
            storageAccount: news.storageAccount,
            resourceGroup: news.resourceGroup,
            containerId: localId("containers", name),
            publicAccess,
            metadata: news.metadata ?? {},
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          const endpoints = yield* ensure;
          yield* onEmulator(
            blob.DeleteContainer({
              url: sasUrl(endpoints.blob, endpoints.sas),
              containerName: output.containerName,
            }),
          ).pipe(Effect.catchTag("ContainerNotFound", () => Effect.void));
        }),
      });
    }),
  );

/** Local `Azure.Storage.Queue`: a queue in Azurite. */
export const QueueProviderLocal = () =>
  Provider.effect(
    Queue,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const ensure = ensureAzurite.pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      return Queue.Provider.of({
        stables: ["queueName", "storageAccount", "resourceGroup", "queueId"],
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news) || output === undefined) return undefined;
          if (news.name !== undefined && news.name !== output.queueName) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          const endpoints = yield* ensure;
          const url = sasUrl(endpoints.queue, endpoints.sas);
          const name = news.name ?? output?.queueName ?? (yield* createStorageChildName(id));
          const metadata = { ...news.metadata, ...(yield* ownershipMetadata(id)) };
          yield* onEmulator(queue.CreateQueue({ url, queueName: name, metadata })).pipe(
            // An existing queue with other metadata: sync the metadata.
            Effect.catchTag("QueueAlreadyExists", () =>
              onEmulator(queue.SetQueueMetadata({ url, queueName: name, metadata })),
            ),
          );
          return {
            queueName: name,
            storageAccount: news.storageAccount,
            resourceGroup: news.resourceGroup,
            queueId: localId("queues", name),
            metadata: news.metadata ?? {},
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          const endpoints = yield* ensure;
          yield* onEmulator(
            queue.DeleteQueue({
              url: sasUrl(endpoints.queue, endpoints.sas),
              queueName: output.queueName,
            }),
          ).pipe(Effect.catchTag("QueueNotFound", () => Effect.void));
        }),
      });
    }),
  );
