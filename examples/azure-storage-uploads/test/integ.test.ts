import { describe, expect } from "bun:test";
import { createHash } from "node:crypto";
import * as Azure from "@alchemy.run/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as eventgrid from "@distilled.cloud/azure/eventgrid";
import * as storage from "@distilled.cloud/azure/storage";
import * as web from "@distilled.cloud/azure/web";
import * as Alchemy from "alchemy";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Bun";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

/** The deployer's credentials, for out-of-band ARM reads. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

class NotIndexed extends Data.TaggedError("NotIndexed")<{ readonly missing: string[] }> {}

class UnexpectedStatus extends Data.TaggedError("UnexpectedStatus")<{
  readonly status: number;
  readonly body: string;
}> {}

interface FileRecord {
  name: string;
  blob: string;
  blobEtag: string;
  size: number;
  contentType: string;
  sha256: string;
  indexedAt: string;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A unique suffix per run for file names (payloads, not resource names). */
const RUN = crypto.randomUUID().slice(0, 8);

describe("azure-storage-uploads", () => {
  // Two Flex Consumption apps (billed per execution), a Standard_LRS storage
  // account, and Event Grid deliveries: a few cents per run, ~6 min deploy.
  const stack = beforeAll(deploy(Stack), { timeout: 1_200_000 });

  const baseUrl = Effect.map(stack, ({ url }) => String(url).replace(/\/+$/, ""));

  /**
   * Send a request and return the response once its status is `expected`.
   * Any other status (the Flex Consumption cold start, or a 500 while the
   * app's data roles propagate after the first deploy) is retried for
   * about 4 minutes.
   */
  const call = (request: HttpClientRequest.HttpClientRequest, expected: number) =>
    Effect.gen(function* () {
      const res = yield* HttpClient.execute(request);
      if (res.status !== expected) {
        const body = yield* res.text;
        return yield* new UnexpectedStatus({ status: res.status, body: body.slice(0, 300) });
      }
      return res;
    }).pipe(
      Effect.tapError((error) => Effect.logWarning(error)),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 48 }),
    );

  const listFiles = Effect.gen(function* () {
    const url = yield* baseUrl;
    const res = yield* call(HttpClientRequest.get(`${url}/files`), 200);
    return ((yield* res.json) as unknown as { files: FileRecord[] }).files;
  });

  /** Where the example's resources are, from the stack outputs. */
  const where = Effect.gen(function* () {
    const outputs = yield* stack;
    const { subscriptionId } = yield* Azure.AzureEnvironment.current.pipe(Effect.provide(azure));
    return { subscriptionId, ...outputs };
  });

  type Where = Effect.Success<typeof where>;

  const found = Effect.as("found" as const);
  const gone = () => Effect.succeed("gone" as const);

  const accountStatus = (ids: Where) =>
    storage
      .GetStorageAccountProperties({
        subscriptionId: ids.subscriptionId,
        resourceGroupName: ids.resourceGroup,
        accountName: ids.storageAccount,
      })
      .pipe(
        found,
        Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], gone),
        Effect.provide(azure),
      );

  const appStatus = (ids: Where, name: string) =>
    web
      .GetWebApp({ subscriptionId: ids.subscriptionId, resourceGroupName: ids.resourceGroup, name })
      .pipe(
        found,
        Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], gone),
        Effect.provide(azure),
      );

  /** Poll until a deleted resource reads as gone. */
  const untilGone = <E, R>(status: Effect.Effect<"found" | "gone", E, R>) =>
    status.pipe(
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (current) => current === "gone",
        times: 24,
      }),
    );

  afterAll.skipIf(!!process.env.NO_DESTROY)(
    Effect.gen(function* () {
      const ids = yield* where;
      yield* destroy(Stack);
      expect(yield* untilGone(accountStatus(ids))).toBe("gone");
      expect(yield* untilGone(appStatus(ids, ids.apiApp))).toBe("gone");
      expect(yield* untilGone(appStatus(ids, ids.indexerApp))).toBe("gone");
    }),
    { timeout: 900_000 },
  );

  test(
    "the container, table, and BlobCreated subscription exist",
    Effect.gen(function* () {
      const ids = yield* where;
      const account = {
        subscriptionId: ids.subscriptionId,
        resourceGroupName: ids.resourceGroup,
        accountName: ids.storageAccount,
      };

      const container = yield* storage
        .GetBlobContainer({ ...account, containerName: ids.containerName })
        .pipe(Effect.provide(azure));
      expect(container.name).toBe(ids.containerName);

      const table = yield* storage
        .GetTable({ ...account, tableName: ids.tableName })
        .pipe(Effect.provide(azure));
      expect(table.name).toBe(ids.tableName);

      // The Indexer's event source subscribed the account's system topic,
      // filtered to `uploads/` in this container.
      expect(ids.eventSubscriptions.length).toBe(1);
      const [subscription] = ids.eventSubscriptions;
      expect(subscription!.scope.toLowerCase()).toBe(
        `/subscriptions/${ids.subscriptionId}/resourceGroups/${ids.resourceGroup}/providers/Microsoft.Storage/storageAccounts/${ids.storageAccount}`.toLowerCase(),
      );
      const live = yield* eventgrid
        .GetEventSubscription({
          scope: subscription!.scope,
          eventSubscriptionName: subscription!.name,
        })
        .pipe(Effect.provide(azure));
      expect(live.properties?.provisioningState).toBe("Succeeded");
      expect(live.properties?.filter?.includedEventTypes).toEqual([
        "Microsoft.Storage.BlobCreated",
      ]);
      expect(live.properties?.filter?.subjectBeginsWith).toBe(
        `/blobServices/default/containers/${ids.containerName}/blobs/uploads/`,
      );
    }),
    { timeout: 120_000 },
  );

  test(
    "each app holds only its binding roles on the data account",
    Effect.gen(function* () {
      const ids = yield* where;
      const account = `/subscriptions/${ids.subscriptionId}/resourceGroups/${ids.resourceGroup}/providers/Microsoft.Storage/storageAccounts/${ids.storageAccount}`;
      const container = `${account}/blobServices/default/containers/${ids.containerName}`;
      const table = `${account}/tableServices/default/tables/${ids.tableName}`;

      /**
       * Role GUID per principal for the assignments made exactly at `scope`
       * (the listing also returns inherited ones from above). New
       * assignments can take a few seconds to show up in the listing.
       */
      const rolesAt = (scope: string) =>
        Stream.runCollect(authorization.ListRoleAssignmentForScope.items({ scope })).pipe(
          Effect.map((assignments) =>
            Object.fromEntries(
              [...assignments]
                .filter((a) => a.properties?.scope?.toLowerCase() === scope.toLowerCase())
                .map((a) => [
                  a.properties?.principalId ?? "",
                  a.properties?.roleDefinitionId?.split("/").pop() ?? "",
                ]),
            ),
          ),
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (roles) => Object.keys(roles).length >= 2,
            times: 12,
          }),
          Effect.provide(azure),
        );

      const onContainer = yield* rolesAt(container);
      expect(onContainer).toEqual({
        [ids.apiPrincipalId!]: Azure.Authorization.BuiltInRole.StorageBlobDataContributor,
        [ids.indexerPrincipalId!]: Azure.Authorization.BuiltInRole.StorageBlobDataReader,
      });

      // Custom roles with exactly the binding's data actions: read-write for
      // the Api, write-only for the Indexer.
      const onTable = yield* rolesAt(table);
      expect(Object.keys(onTable).sort()).toEqual(
        [ids.apiPrincipalId!, ids.indexerPrincipalId!].sort(),
      );
      expect(onTable[ids.apiPrincipalId!]).not.toBe(onTable[ids.indexerPrincipalId!]);
    }),
    { timeout: 120_000 },
  );

  test(
    "rejects a file name outside the safe alphabet",
    Effect.gen(function* () {
      const url = yield* baseUrl;
      yield* call(
        HttpClientRequest.put(`${url}/files/${encodeURIComponent("bad name")}`).pipe(
          HttpClientRequest.bodyText("nope"),
        ),
        400,
      );
    }),
    { timeout: 300_000 },
  );

  const textName = `notes-${RUN}.txt`;
  const textBody = new TextEncoder().encode("hello from azure blob storage\n");
  const binaryName = `random-${RUN}.bin`;
  const binaryBody = crypto.getRandomValues(new Uint8Array(64 * 1024));

  test(
    "indexes uploads through BlobCreated into Table storage",
    Effect.gen(function* () {
      const url = yield* baseUrl;
      const uploads = [
        { name: textName, body: textBody, contentType: "text/plain" },
        { name: binaryName, body: binaryBody, contentType: "application/octet-stream" },
      ];

      const upload = (file: (typeof uploads)[number]) =>
        call(
          HttpClientRequest.put(`${url}/files/${file.name}`).pipe(
            HttpClientRequest.bodyUint8Array(file.body, file.contentType),
          ),
          202,
        );

      for (const file of uploads) {
        const res = yield* upload(file);
        const stored = (yield* res.json) as unknown as { blob: string; size: number };
        expect(stored).toMatchObject({
          blob: `uploads/${file.name}`,
          size: file.body.byteLength,
        });

        // Read the bytes back through the Api.
        const read = yield* call(HttpClientRequest.get(`${url}/files/${file.name}`), 200);
        expect(read.headers["content-type"]).toBe(file.contentType);
        const bytes = new Uint8Array(yield* read.arrayBuffer);
        expect(sha256(bytes)).toBe(sha256(file.body));
      }

      const missing = (records: FileRecord[]) =>
        uploads.filter((file) => !records.some((record) => record.name === file.name));

      // Event Grid delivers each BlobCreated event to the Indexer within
      // seconds. On a fresh deploy the Indexer's data roles can take minutes
      // to propagate, and Event Grid backs off failed deliveries (10 s, 30 s,
      // 1 min, 5 min, 10 min, …). Wait 2 minutes at a time and re-upload
      // what is still missing, which raises a fresh event (12 minutes max).
      const files = yield* listFiles.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("10 seconds"),
          until: (records) => missing(records).length === 0,
          times: 12,
        }),
        Effect.flatMap((records) =>
          missing(records).length === 0
            ? Effect.succeed(records)
            : Effect.forEach(missing(records), upload).pipe(
                Effect.andThen(
                  Effect.fail(new NotIndexed({ missing: missing(records).map((f) => f.name) })),
                ),
              ),
        ),
        Effect.tapError((error) => Effect.logWarning(error)),
        Effect.retry({ while: (e) => e._tag === "NotIndexed", times: 5 }),
      );

      for (const file of uploads) {
        const record = files.find((candidate) => candidate.name === file.name);
        expect(record).toMatchObject({
          name: file.name,
          blob: `uploads/${file.name}`,
          size: file.body.byteLength,
          contentType: file.contentType,
          sha256: sha256(file.body),
        });
        expect(record!.blobEtag).toMatch(/^"?0x[0-9A-F]+"?$/);
      }
    }),
    { timeout: 1_200_000 },
  );

  test(
    "deletes a file and its metadata",
    Effect.gen(function* () {
      const url = yield* baseUrl;
      yield* call(HttpClientRequest.delete(`${url}/files/${textName}`), 204);
      yield* call(HttpClientRequest.get(`${url}/files/${textName}`), 404);
      const names = (yield* listFiles).map((record) => record.name);
      expect(names).not.toContain(textName);
      expect(names).toContain(binaryName);
    }),
    { timeout: 300_000 },
  );
});
