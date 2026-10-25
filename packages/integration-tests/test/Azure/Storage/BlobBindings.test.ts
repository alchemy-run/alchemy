import * as Azure from "@alchemy.run/azure";
import { Credentials } from "@distilled.cloud/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import type * as Output from "alchemy/Output";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import BlobBindingsFunction, {
  BlobAccount,
  BlobService,
  Containers,
  ServiceAccount,
  ServiceAccountSettings,
} from "./fixtures/blob-function.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

/** Object ID of the deployer's service principal (the `oid` claim of its ARM token). */
const deployerObjectId = Effect.gen(function* () {
  const credentials = yield* Credentials;
  const config = yield* credentials;
  const token = Redacted.value(config.bearerToken);
  return yield* Effect.sync(
    () =>
      JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"))
        .oid as string,
  );
});

const Stack = Alchemy.Stack(
  "AzureStorageBlobBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* BlobBindingsFunction;
    const account = yield* BlobAccount;
    yield* BlobService;
    const serviceAccount = yield* ServiceAccount;
    yield* ServiceAccountSettings;
    // The deployer verifies every binding's effect out of band.
    const deployer = yield* deployerObjectId.pipe(Effect.orDie);
    const names: Record<string, Output.Output<string, never>> = {};
    const ids: Record<string, Output.Output<string, never>> = {};
    const accounts: Record<string, Output.Output<string, never>> = {};
    for (const [key, make] of Object.entries(Containers)) {
      const container = yield* make;
      names[key] = container.containerName;
      ids[key] = container.containerId;
      accounts[key] = container.storageAccount;
      yield* Azure.Authorization.RoleAssignment(`BlobBindingsDeployer${key}`, {
        scope: container.containerId,
        roleDefinitionId: Azure.Authorization.BuiltInRole.StorageBlobDataOwner,
        principalId: deployer,
        principalType: "ServicePrincipal",
      });
    }
    return {
      url: fn.url,
      principalId: fn.principalId,
      account: account.storageAccountName,
      serviceAccount: serviceAccount.storageAccountName,
      serviceAccountId: serviceAccount.storageAccountId,
      names,
      ids,
      accounts,
    };
  }),
);

// ~$0.02/run (Flex Consumption Function, two Standard_LRS accounts, a few MB); ~6 min deploy.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

/** Azure credentials and environment for hooks and out-of-band checks. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

type ContainerKey = keyof typeof Containers;
type Body = { ok: boolean; result?: any; tag?: string; error?: string };

/** Typed tags Azure Storage answers while a new role assignment propagates. */
const ACCESS_PENDING = new Set([
  "SchemaRegistryStorageAccessDenied",
  "StorageAuthorizationFailure",
  "ContainerNotFound",
]);

const outputs = Effect.gen(function* () {
  const out = yield* stack;
  return {
    url: out.url as string,
    principalId: out.principalId as string,
    account: out.account as string,
    serviceAccount: out.serviceAccount as string,
    serviceAccountId: out.serviceAccountId as string,
    names: out.names as Record<ContainerKey, string>,
    ids: out.ids as Record<ContainerKey, string>,
    accounts: out.accounts as Record<ContainerKey, string>,
  };
});

/**
 * GET a fixture route until it answers 200 and is not waiting on role
 * propagation (up to 9 minutes, through the Flex Consumption cold start),
 * then return the answer so a typed failure can be asserted.
 */
const get = (path: string) =>
  Effect.gen(function* () {
    const { url } = yield* outputs;
    return yield* HttpClient.get(`${url}${path}`).pipe(
      Effect.timeout("60 seconds"),
      Effect.filterOrFail(
        (response) => response.status === 200,
        (response) => `status ${response.status}`,
      ),
      Effect.flatMap((response) => response.json),
      Effect.map((body) => body as Body),
      Effect.flatMap((body) =>
        !body.ok && ACCESS_PENDING.has(body.tag ?? "") ? Effect.fail(body) : Effect.succeed(body),
      ),
      // Azure documents up to 10 minutes for a role assignment to take effect.
      Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 54 }),
    );
  });

/** Call a per-operation binding through the fixture. */
const op = (name: string, request: Record<string, unknown> = {}) =>
  get(`/op/${name}?req=${encodeURIComponent(JSON.stringify(request))}`);

/** Call a BlobContainerRead / Write / ReadWrite client method through the fixture. */
const client = (kind: "read" | "write" | "readWrite", method: string, ...args: unknown[]) =>
  get(`/client/${kind}/${method}?args=${encodeURIComponent(JSON.stringify(args))}`);

const expectOk = (body: Body) =>
  expect({ ok: body.ok, tag: body.tag, error: body.error }).toEqual({
    ok: true,
    tag: undefined,
    error: undefined,
  });

const expectTag = (body: Body, tag: string) =>
  expect({ ok: body.ok, tag: body.tag }).toEqual({ ok: false, tag });

/**
 * Run a distilled call as the deployer (Storage Blob Data Owner on every
 * test container), retrying while that role propagates.
 */
const asDeployer = <A, E extends { _tag: string }>(
  effect: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
) =>
  effect.pipe(
    Effect.retry({
      while: (e) => ACCESS_PENDING.has(e._tag),
      schedule: Schedule.spaced("10 seconds"),
      times: 18,
    }),
    Effect.provide(azure),
  );

/** `url` + `containerName` of a test container, for out-of-band calls. */
const where = (key: ContainerKey) =>
  Effect.map(outputs, (out) => ({
    url: `https://${out.accounts[key]}.blob.core.windows.net`,
    containerName: out.names[key],
  }));

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (body: Uint8Array) => new TextDecoder().decode(body);
const page = (char: string) => char.repeat(512);
const blockId = (n: number) => Buffer.from(`block-${n}`).toString("base64");

const upload = (key: ContainerKey, name: string, content: string, contentType = "text/plain") =>
  Effect.gen(function* () {
    const at = yield* where(key);
    return yield* asDeployer(
      blob.UploadBlockBlob({
        ...at,
        blob: name,
        body: bytes(content),
        xMsBlobContentType: contentType,
      }),
    );
  });

const download = (key: ContainerKey, name: string) =>
  Effect.gen(function* () {
    const at = yield* where(key);
    const res = yield* asDeployer(blob.DownloadBlob({ ...at, blob: name }));
    return text(res.body);
  });

const properties = (key: ContainerKey, name: string, snapshot?: string) =>
  Effect.gen(function* () {
    const at = yield* where(key);
    return yield* asDeployer(blob.GetBlobProperties({ ...at, blob: name, snapshot }));
  });

const createPageBlob = (key: ContainerKey, name: string, size: number) =>
  Effect.gen(function* () {
    const at = yield* where(key);
    yield* asDeployer(blob.CreatePageBlob({ ...at, blob: name, xMsBlobContentLength: size }));
  });

const writePage = (key: ContainerKey, name: string, index: number, char: string) =>
  Effect.gen(function* () {
    const at = yield* where(key);
    yield* asDeployer(
      blob.UploadPageBlobPages({
        ...at,
        blob: name,
        xMsRange: `bytes=${index * 512}-${index * 512 + 511}`,
        body: bytes(page(char)),
      }),
    );
  });

const snapshotOf = (key: ContainerKey, name: string) =>
  Effect.gen(function* () {
    const at = yield* where(key);
    const res = yield* asDeployer(blob.CreateBlobSnapshot({ ...at, blob: name }));
    return res.xMsSnapshot!;
  });

const createAppendBlob = (key: ContainerKey, name: string) =>
  Effect.gen(function* () {
    const at = yield* where(key);
    yield* asDeployer(blob.CreateAppendBlob({ ...at, blob: name }));
  });

const blobUrl = (key: ContainerKey, name: string) =>
  Effect.map(where(key), (at) => `${at.url}/${at.containerName}/${name}`);

/** Upload a public source blob (the `…FromUrl` operations read it anonymously). */
const publicSource = (name: string, content: string) =>
  Effect.gen(function* () {
    yield* upload("sources", name, content);
    return yield* blobUrl("sources", name);
  });

const acquireBlobLease = (key: ContainerKey, name: string, duration = -1) =>
  Effect.gen(function* () {
    const at = yield* where(key);
    const res = yield* asDeployer(
      blob.BlobAcquireLease({ ...at, blob: name, xMsLeaseDuration: duration }),
    );
    return res.xMsLeaseId!;
  });

const containerProperties = (key: ContainerKey) =>
  Effect.gen(function* () {
    const at = yield* where(key);
    return yield* asDeployer(blob.GetContainerProperties(at));
  });

const acquireContainerLease = (duration = -1) =>
  Effect.gen(function* () {
    const at = yield* where("leases");
    const res = yield* asDeployer(
      blob.ContainerAcquireLease({ ...at, xMsLeaseDuration: duration }),
    );
    return res.xMsLeaseId!;
  });

/** End any container lease so the container can be deleted. */
const breakContainerLease = Effect.gen(function* () {
  const at = yield* where("leases");
  yield* asDeployer(blob.ContainerBreakLease({ ...at, xMsLeaseBreakPeriod: 0 })).pipe(
    Effect.catchTag("StorageLeaseConflict", () => Effect.void),
  );
});

/** The account-level bindings' account endpoint, for out-of-band calls. */
const serviceUrl = Effect.map(
  outputs,
  (out) => `https://${out.serviceAccount}.blob.core.windows.net`,
);

/** Containers of the service account, including soft-deleted ones. */
const serviceContainers = Effect.gen(function* () {
  const url = yield* serviceUrl;
  const page = yield* asDeployer(
    blob.ListServiceContainersSegment({ url, prefix: "runtime-", include: ["deleted"] }),
  );
  return page.ContainerItems.map((c) => ({
    name: c.Name,
    deleted: c.Deleted === true,
    version: c.Version,
  }));
});

const createServiceContainer = (containerName: string) =>
  Effect.gen(function* () {
    const url = yield* serviceUrl;
    yield* asDeployer(blob.CreateContainer({ url, containerName }));
  });

const names = (items: { Name: { content?: string } }[] | undefined) =>
  (items ?? []).map((item) => item.Name.content).sort();

/** Built-in Storage Blob Data roles also hold this account-level action. */
const DELEGATION_KEY =
  "Microsoft.Storage/storageAccounts/blobServices/generateUserDelegationKey/action";

const LIVE = { tags: ["provider:azure", "live"] };
const T = { timeout: 660_000 };

describe("Storage blob bindings on an Azure Function", LIVE, () => {
  // Reads: Storage Blob Data Reader on the `reads` container.

  describe("DownloadBlob", () => {
    test(
      "downloads the blob's content",
      Effect.gen(function* () {
        yield* upload("reads", "download.txt", "hello download");
        const body = yield* op("DownloadBlob", { blob: "download.txt" });
        expectOk(body);
        expect(body.result.body).toEqual({ $text: "hello download" });
      }),
      T,
    );
  });

  describe("GetBlobProperties", () => {
    test(
      "reads size and content type",
      Effect.gen(function* () {
        yield* upload("reads", "props.json", "{}", "application/json");
        const body = yield* op("GetBlobProperties", { blob: "props.json" });
        expectOk(body);
        expect({
          contentLength: body.result.contentLength,
          contentType: body.result.contentType,
        }).toEqual({ contentLength: 2, contentType: "application/json" });
      }),
      T,
    );
  });

  describe("ListBlobs", () => {
    test(
      "lists blobs under a prefix",
      Effect.gen(function* () {
        yield* upload("reads", "list/a.txt", "a");
        yield* upload("reads", "list/b.txt", "b");
        const body = yield* op("ListBlobs", { prefix: "list/" });
        expectOk(body);
        expect(names(body.result.Segment.BlobItems)).toEqual(["list/a.txt", "list/b.txt"]);
      }),
      T,
    );
  });

  describe("ListBlobsByHierarchy", () => {
    test(
      "groups blobs into virtual directories",
      Effect.gen(function* () {
        yield* upload("reads", "tree/x/1.txt", "1");
        yield* upload("reads", "tree/y/2.txt", "2");
        yield* upload("reads", "tree/top.txt", "t");
        const body = yield* op("ListBlobsByHierarchy", { prefix: "tree/", delimiter: "/" });
        expectOk(body);
        expect({
          prefixes: names(body.result.Segment.BlobPrefixes),
          blobs: names(body.result.Segment.BlobItems),
        }).toEqual({ prefixes: ["tree/x/", "tree/y/"], blobs: ["tree/top.txt"] });
      }),
      T,
    );
  });

  describe("GetBlockList", () => {
    test(
      "lists a block blob's committed blocks",
      Effect.gen(function* () {
        const at = yield* where("reads");
        yield* asDeployer(
          blob.BlockBlobStageBlock({
            ...at,
            blob: "blocks.bin",
            blockid: blockId(0),
            body: bytes("ab"),
          }),
        );
        yield* asDeployer(
          blob.BlockBlobStageBlock({
            ...at,
            blob: "blocks.bin",
            blockid: blockId(1),
            body: bytes("cde"),
          }),
        );
        yield* asDeployer(
          blob.ListBlockBlobCommitBlock({
            ...at,
            blob: "blocks.bin",
            Latest: [blockId(0), blockId(1)],
          }),
        );
        const body = yield* op("GetBlockList", { blob: "blocks.bin", blocklisttype: "committed" });
        expectOk(body);
        expect(body.result.CommittedBlocks).toEqual([
          { Name: blockId(0), Size: 2 },
          { Name: blockId(1), Size: 3 },
        ]);
      }),
      T,
    );
  });

  describe("GetPageRanges", () => {
    test(
      "lists a page blob's written ranges",
      Effect.gen(function* () {
        yield* createPageBlob("reads", "ranges.bin", 2048);
        yield* writePage("reads", "ranges.bin", 1, "r");
        const body = yield* op("GetPageRanges", { blob: "ranges.bin" });
        expectOk(body);
        expect(body.result.PageRange).toEqual([{ Start: 512, End: 1023 }]);
      }),
      T,
    );
  });

  describe("GetPageRangesDiff", () => {
    test(
      "lists only the pages written since a snapshot",
      Effect.gen(function* () {
        yield* createPageBlob("reads", "diff.bin", 2048);
        yield* writePage("reads", "diff.bin", 0, "a");
        const snapshot = yield* snapshotOf("reads", "diff.bin");
        yield* writePage("reads", "diff.bin", 2, "b");
        const body = yield* op("GetPageRangesDiff", { blob: "diff.bin", prevsnapshot: snapshot });
        expectOk(body);
        expect(body.result.PageRange).toEqual([{ Start: 1024, End: 1535 }]);
      }),
      T,
    );
  });

  describe("QueryBlob", () => {
    test(
      "selects rows from a CSV blob",
      Effect.gen(function* () {
        yield* upload("reads", "query.csv", "alpha,1\nbeta,2\n", "text/csv");
        const body = yield* op("QueryBlob", {
          blob: "query.csv",
          QueryType: "SQL",
          Expression: "SELECT _1 FROM BlobStorage WHERE _2 = '2'",
        });
        expectOk(body);
        // The response is an Avro stream; the selected record is plain text in it.
        const records: string = body.result.body.$text;
        expect({ beta: records.includes("beta"), alpha: records.includes("alpha") }).toEqual({
          beta: true,
          alpha: false,
        });
      }),
      T,
    );
  });

  // Writes: custom `blobs/write` role on the `writes` container.

  describe("UploadBlockBlob", () => {
    test(
      "uploads a block blob",
      Effect.gen(function* () {
        const body = yield* op("UploadBlockBlob", {
          blob: "upload.txt",
          body: { $text: "uploaded" },
          xMsBlobContentType: "text/plain",
        });
        expectOk(body);
        expect(yield* download("writes", "upload.txt")).toBe("uploaded");
      }),
      T,
    );
  });

  describe("StageBlock", () => {
    test(
      "stages an uncommitted block",
      Effect.gen(function* () {
        const body = yield* op("StageBlock", {
          blob: "staged.bin",
          blockid: blockId(7),
          body: { $text: "seven" },
        });
        expectOk(body);
        const at = yield* where("writes");
        const list = yield* asDeployer(
          blob.BlockBlobGetBlockList({ ...at, blob: "staged.bin", blocklisttype: "uncommitted" }),
        );
        expect(list.UncommittedBlocks).toEqual([{ Name: blockId(7), Size: 5 }]);
      }),
      T,
    );
  });

  describe("CommitBlockList", () => {
    test(
      "commits staged blocks as the blob's content",
      Effect.gen(function* () {
        const at = yield* where("writes");
        yield* asDeployer(
          blob.BlockBlobStageBlock({
            ...at,
            blob: "commit.txt",
            blockid: blockId(0),
            body: bytes("hello "),
          }),
        );
        yield* asDeployer(
          blob.BlockBlobStageBlock({
            ...at,
            blob: "commit.txt",
            blockid: blockId(1),
            body: bytes("blocks"),
          }),
        );
        const body = yield* op("CommitBlockList", {
          blob: "commit.txt",
          Latest: [blockId(0), blockId(1)],
        });
        expectOk(body);
        expect(yield* download("writes", "commit.txt")).toBe("hello blocks");
      }),
      T,
    );
  });

  describe("CreateAppendBlob", () => {
    test(
      "creates an empty append blob",
      Effect.gen(function* () {
        expectOk(yield* op("CreateAppendBlob", { blob: "created.log" }));
        const props = yield* properties("writes", "created.log");
        expect({ type: props.xMsBlobType, length: props.contentLength }).toEqual({
          type: "AppendBlob",
          length: 0,
        });
      }),
      T,
    );
  });

  describe("AppendBlock", () => {
    test(
      "appends blocks in order",
      Effect.gen(function* () {
        yield* createAppendBlob("writes", "append.log");
        expectOk(yield* op("AppendBlock", { blob: "append.log", body: { $text: "one;" } }));
        expectOk(yield* op("AppendBlock", { blob: "append.log", body: { $text: "two;" } }));
        expect(yield* download("writes", "append.log")).toBe("one;two;");
      }),
      T,
    );
  });

  describe("SealAppendBlob", () => {
    test(
      "seals an append blob",
      Effect.gen(function* () {
        yield* createAppendBlob("writes", "sealed.log");
        expectOk(yield* op("SealAppendBlob", { blob: "sealed.log" }));
        expect((yield* properties("writes", "sealed.log")).xMsBlobSealed).toBe(true);
      }),
      T,
    );
  });

  describe("CreatePageBlob", () => {
    test(
      "creates a page blob of the given size",
      Effect.gen(function* () {
        expectOk(yield* op("CreatePageBlob", { blob: "created.vhd", xMsBlobContentLength: 1024 }));
        const props = yield* properties("writes", "created.vhd");
        expect({ type: props.xMsBlobType, length: props.contentLength }).toEqual({
          type: "PageBlob",
          length: 1024,
        });
      }),
      T,
    );
  });

  describe("UploadPages", () => {
    test(
      "writes a page",
      Effect.gen(function* () {
        yield* createPageBlob("writes", "upload.vhd", 512);
        const body = yield* op("UploadPages", {
          blob: "upload.vhd",
          xMsRange: "bytes=0-511",
          body: { $text: page("u") },
        });
        expectOk(body);
        expect(yield* download("writes", "upload.vhd")).toBe(page("u"));
      }),
      T,
    );
  });

  describe("ClearPages", () => {
    test(
      "clears a written page",
      Effect.gen(function* () {
        yield* createPageBlob("writes", "clear.vhd", 1024);
        yield* writePage("writes", "clear.vhd", 0, "c");
        expectOk(yield* op("ClearPages", { blob: "clear.vhd", xMsRange: "bytes=0-511" }));
        const at = yield* where("writes");
        const ranges = yield* asDeployer(blob.GetPageBlobPageRanges({ ...at, blob: "clear.vhd" }));
        expect(ranges.PageRange ?? []).toEqual([]);
      }),
      T,
    );
  });

  describe("ResizePageBlob", () => {
    test(
      "grows a page blob",
      Effect.gen(function* () {
        yield* createPageBlob("writes", "resize.vhd", 512);
        expectOk(yield* op("ResizePageBlob", { blob: "resize.vhd", xMsBlobContentLength: 2048 }));
        expect((yield* properties("writes", "resize.vhd")).contentLength).toBe(2048);
      }),
      T,
    );
  });

  describe("UpdatePageBlobSequenceNumber", () => {
    test(
      "sets the sequence number",
      Effect.gen(function* () {
        yield* createPageBlob("writes", "sequence.vhd", 512);
        const body = yield* op("UpdatePageBlobSequenceNumber", {
          blob: "sequence.vhd",
          xMsSequenceNumberAction: "update",
          xMsBlobSequenceNumber: 7,
        });
        expectOk(body);
        expect((yield* properties("writes", "sequence.vhd")).xMsBlobSequenceNumber).toBe(7);
      }),
      T,
    );
  });

  describe("SetBlobHTTPHeaders", () => {
    test(
      "sets content type and cache control",
      Effect.gen(function* () {
        yield* upload("writes", "headers.html", "<p>hi</p>");
        const body = yield* op("SetBlobHTTPHeaders", {
          blob: "headers.html",
          xMsBlobContentType: "text/html",
          xMsBlobCacheControl: "max-age=60",
        });
        expectOk(body);
        const props = yield* properties("writes", "headers.html");
        expect({ type: props.contentType, cache: props.cacheControl }).toEqual({
          type: "text/html",
          cache: "max-age=60",
        });
      }),
      T,
    );
  });

  describe("SetBlobMetadata", () => {
    test(
      "replaces the blob's metadata",
      Effect.gen(function* () {
        yield* upload("writes", "metadata.txt", "m");
        expectOk(yield* op("SetBlobMetadata", { blob: "metadata.txt", metadata: { owner: "fn" } }));
        expect((yield* properties("writes", "metadata.txt")).metadata).toEqual({ owner: "fn" });
      }),
      T,
    );
  });

  describe("SetBlobTier", () => {
    test(
      "moves a blob to the Cool tier",
      Effect.gen(function* () {
        yield* upload("writes", "tier.txt", "t");
        expectOk(yield* op("SetBlobTier", { blob: "tier.txt", xMsAccessTier: "Cool" }));
        expect((yield* properties("writes", "tier.txt")).xMsAccessTier).toBe("Cool");
      }),
      T,
    );
  });

  describe("SetBlobExpiry", () => {
    test(
      "is rejected on an account without a hierarchical namespace",
      Effect.gen(function* () {
        yield* upload("writes", "expiry.txt", "e");
        const body = yield* op("SetBlobExpiry", {
          blob: "expiry.txt",
          xMsExpiryOption: "RelativeToNow",
          xMsExpiryTime: "3600000",
        });
        expectTag(body, "StorageHierarchicalNamespaceNotEnabled");
      }),
      T,
    );
  });

  describe("CreateBlobSnapshot", () => {
    test(
      "creates a readable snapshot",
      Effect.gen(function* () {
        yield* upload("writes", "snap.txt", "before");
        const body = yield* op("CreateBlobSnapshot", { blob: "snap.txt" });
        expectOk(body);
        yield* upload("writes", "snap.txt", "after");
        const at = yield* where("writes");
        const old = yield* asDeployer(
          blob.DownloadBlob({ ...at, blob: "snap.txt", snapshot: body.result.xMsSnapshot }),
        );
        expect(text(old.body)).toBe("before");
      }),
      T,
    );
  });

  describe("AcquireBlobLease", () => {
    test(
      "leases a blob",
      Effect.gen(function* () {
        yield* upload("writes", "lease-acquire.txt", "l");
        const leaseId = "11111111-1111-4111-8111-111111111111";
        const body = yield* op("AcquireBlobLease", {
          blob: "lease-acquire.txt",
          xMsLeaseDuration: -1,
          xMsProposedLeaseId: leaseId,
        });
        expectOk(body);
        expect(body.result.xMsLeaseId).toBe(leaseId);
        expect((yield* properties("writes", "lease-acquire.txt")).xMsLeaseState).toBe("leased");
      }),
      T,
    );
  });

  describe("ReleaseBlobLease", () => {
    test(
      "releases a blob lease",
      Effect.gen(function* () {
        yield* upload("writes", "lease-release.txt", "l");
        const leaseId = yield* acquireBlobLease("writes", "lease-release.txt");
        expectOk(yield* op("ReleaseBlobLease", { blob: "lease-release.txt", xMsLeaseId: leaseId }));
        expect((yield* properties("writes", "lease-release.txt")).xMsLeaseState).toBe("available");
      }),
      T,
    );
  });

  describe("RenewBlobLease", () => {
    test(
      "renews a blob lease",
      Effect.gen(function* () {
        yield* upload("writes", "lease-renew.txt", "l");
        const leaseId = yield* acquireBlobLease("writes", "lease-renew.txt", 15);
        const body = yield* op("RenewBlobLease", { blob: "lease-renew.txt", xMsLeaseId: leaseId });
        expectOk(body);
        expect(body.result.xMsLeaseId).toBe(leaseId);
      }),
      T,
    );
  });

  describe("ChangeBlobLease", () => {
    test(
      "changes a blob lease's ID",
      Effect.gen(function* () {
        yield* upload("writes", "lease-change.txt", "l");
        const leaseId = yield* acquireBlobLease("writes", "lease-change.txt");
        const proposed = "22222222-2222-4222-8222-222222222222";
        const body = yield* op("ChangeBlobLease", {
          blob: "lease-change.txt",
          xMsLeaseId: leaseId,
          xMsProposedLeaseId: proposed,
        });
        expectOk(body);
        expect(body.result.xMsLeaseId).toBe(proposed);
      }),
      T,
    );
  });

  describe("BreakBlobLease", () => {
    test(
      "breaks a blob lease",
      Effect.gen(function* () {
        yield* upload("writes", "lease-break.txt", "l");
        yield* acquireBlobLease("writes", "lease-break.txt");
        expectOk(yield* op("BreakBlobLease", { blob: "lease-break.txt", xMsLeaseBreakPeriod: 0 }));
        expect((yield* properties("writes", "lease-break.txt")).xMsLeaseState).toBe("broken");
      }),
      T,
    );
  });

  describe("AbortCopyBlob", () => {
    test(
      "reports that a finished copy has nothing to abort",
      Effect.gen(function* () {
        yield* upload("writes", "abort.txt", "a");
        const body = yield* op("AbortCopyBlob", {
          blob: "abort.txt",
          copyid: "33333333-3333-4333-8333-333333333333",
        });
        expectTag(body, "StorageNoPendingCopyOperation");
      }),
      T,
    );
  });

  describe("CopyBlobFromUrl", () => {
    test(
      "copies a public blob synchronously",
      Effect.gen(function* () {
        const source = yield* publicSource("copy-from-url.txt", "copied sync");
        const body = yield* op("CopyBlobFromUrl", {
          blob: "copy-from-url.txt",
          xMsCopySource: source,
        });
        expectOk(body);
        expect(body.result.xMsCopyStatus).toBe("success");
        expect(yield* download("writes", "copy-from-url.txt")).toBe("copied sync");
      }),
      T,
    );
  });

  describe("PutBlobFromUrl", () => {
    test(
      "creates a block blob from a URL",
      Effect.gen(function* () {
        const source = yield* publicSource("put-from-url.txt", "put from url");
        const body = yield* op("PutBlobFromUrl", {
          blob: "put-from-url.txt",
          xMsCopySource: source,
        });
        expectOk(body);
        expect(yield* download("writes", "put-from-url.txt")).toBe("put from url");
      }),
      T,
    );
  });

  describe("StageBlockFromUrl", () => {
    test(
      "stages a block read from a URL",
      Effect.gen(function* () {
        const source = yield* publicSource("stage-from-url.txt", "staged");
        const body = yield* op("StageBlockFromUrl", {
          blob: "stage-from-url.bin",
          blockid: blockId(3),
          xMsCopySource: source,
        });
        expectOk(body);
        const at = yield* where("writes");
        const list = yield* asDeployer(
          blob.BlockBlobGetBlockList({
            ...at,
            blob: "stage-from-url.bin",
            blocklisttype: "uncommitted",
          }),
        );
        expect(list.UncommittedBlocks).toEqual([{ Name: blockId(3), Size: 6 }]);
      }),
      T,
    );
  });

  describe("AppendBlockFromUrl", () => {
    test(
      "appends a block read from a URL",
      Effect.gen(function* () {
        const source = yield* publicSource("append-from-url.txt", "appended");
        yield* createAppendBlob("writes", "append-from-url.log");
        const body = yield* op("AppendBlockFromUrl", {
          blob: "append-from-url.log",
          xMsCopySource: source,
        });
        expectOk(body);
        expect(yield* download("writes", "append-from-url.log")).toBe("appended");
      }),
      T,
    );
  });

  describe("UploadPagesFromUrl", () => {
    test(
      "writes a page read from a URL",
      Effect.gen(function* () {
        const source = yield* publicSource("pages-from-url.bin", page("s"));
        yield* createPageBlob("writes", "pages-from-url.vhd", 512);
        const body = yield* op("UploadPagesFromUrl", {
          blob: "pages-from-url.vhd",
          xMsCopySource: source,
          xMsSourceRange: "bytes=0-511",
          xMsRange: "bytes=0-511",
        });
        expectOk(body);
        expect(yield* download("writes", "pages-from-url.vhd")).toBe(page("s"));
      }),
      T,
    );
  });

  // Copies: custom `blobs/read` + `blobs/write` role on the `copies` container.

  describe("StartCopyBlob", () => {
    test(
      "copies a blob within the container",
      Effect.gen(function* () {
        yield* upload("copies", "copy-source.txt", "copied async");
        const source = yield* blobUrl("copies", "copy-source.txt");
        const body = yield* op("StartCopyBlob", { blob: "copy-target.txt", xMsCopySource: source });
        expectOk(body);
        const props = yield* properties("copies", "copy-target.txt").pipe(
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (p) => p.xMsCopyStatus !== "pending",
            times: 15,
          }),
        );
        expect(props.xMsCopyStatus).toBe("success");
        expect(yield* download("copies", "copy-target.txt")).toBe("copied async");
      }),
      T,
    );
  });

  describe("CopyPageBlobIncremental", () => {
    test(
      "copies a page blob snapshot incrementally",
      Effect.gen(function* () {
        // Azure reads an incremental copy's source anonymously (or by SAS).
        yield* createPageBlob("sources", "incremental-source.vhd", 512);
        yield* writePage("sources", "incremental-source.vhd", 0, "i");
        const snapshot = yield* snapshotOf("sources", "incremental-source.vhd");
        const source = yield* blobUrl("sources", "incremental-source.vhd");
        const body = yield* op("CopyPageBlobIncremental", {
          blob: "incremental-target.vhd",
          xMsCopySource: `${source}?snapshot=${encodeURIComponent(snapshot)}`,
        });
        expectOk(body);
        const props = yield* properties("writes", "incremental-target.vhd").pipe(
          Effect.repeat({
            schedule: Schedule.spaced("3 seconds"),
            until: (p) => p.xMsCopyStatus !== "pending",
            times: 20,
          }),
        );
        expect({ status: props.xMsCopyStatus, incremental: props.xMsIncrementalCopy }).toEqual({
          status: "success",
          incremental: true,
        });
      }),
      T,
    );
  });

  // Deletes: custom `blobs/delete` role on the `deletes` container.

  describe("DeleteBlob", () => {
    test(
      "deletes a blob",
      Effect.gen(function* () {
        yield* upload("deletes", "doomed.txt", "d");
        expectOk(yield* op("DeleteBlob", { blob: "doomed.txt" }));
        const at = yield* where("deletes");
        const gone = yield* Effect.result(
          asDeployer(blob.GetBlobProperties({ ...at, blob: "doomed.txt" })),
        );
        expect(Result.isFailure(gone) ? gone.failure._tag : "found").toBe("BlobNotFound");
      }),
      T,
    );
  });

  // Tags: custom tag roles on the `tags` container.

  describe("SetBlobTags", () => {
    test(
      "replaces a blob's index tags",
      Effect.gen(function* () {
        yield* upload("tags", "set-tags.txt", "t");
        const body = yield* op("SetBlobTags", {
          blob: "set-tags.txt",
          BlobTagSet: [{ Key: "status", Value: "done" }],
        });
        expectOk(body);
        const at = yield* where("tags");
        const tags = yield* asDeployer(blob.GetBlobTags({ ...at, blob: "set-tags.txt" }));
        expect(tags.BlobTagSet).toEqual([{ Key: "status", Value: "done" }]);
      }),
      T,
    );
  });

  describe("GetBlobTags", () => {
    test(
      "reads a blob's index tags",
      Effect.gen(function* () {
        yield* upload("tags", "get-tags.txt", "t");
        const at = yield* where("tags");
        yield* asDeployer(
          blob.SetBlobTags({
            ...at,
            blob: "get-tags.txt",
            BlobTagSet: [{ Key: "team", Value: "blob" }],
          }),
        );
        const body = yield* op("GetBlobTags", { blob: "get-tags.txt" });
        expectOk(body);
        expect(body.result.BlobTagSet).toEqual([{ Key: "team", Value: "blob" }]);
      }),
      T,
    );
  });

  describe("FindBlobsByTags", () => {
    test(
      "finds blobs by an index tag",
      Effect.gen(function* () {
        yield* upload("tags", "find-tags.txt", "t");
        const at = yield* where("tags");
        yield* asDeployer(
          blob.SetBlobTags({
            ...at,
            blob: "find-tags.txt",
            BlobTagSet: [{ Key: "find", Value: "me" }],
          }),
        );
        // The tag index trails tag writes by seconds.
        const body = yield* op("FindBlobsByTags", { where: `"find"='me'` }).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (b) => b.ok && (b.result.Blobs ?? []).length > 0,
            times: 12,
          }),
        );
        expectOk(body);
        expect(body.result.Blobs.map((b: { Name: string }) => b.Name)).toEqual(["find-tags.txt"]);
      }),
      T,
    );
  });

  // Container metadata, ACLs, undelete, immutability on the `meta` container.

  describe("GetContainerProperties", () => {
    test(
      "reads the container's metadata",
      Effect.gen(function* () {
        const body = yield* op("GetContainerProperties");
        expectOk(body);
        expect(body.result.metadata.alchemy_id).toBe("BlobMeta");
      }),
      T,
    );
  });

  describe("SetContainerMetadata", () => {
    test(
      "replaces the container's metadata",
      Effect.gen(function* () {
        const before = yield* containerProperties("meta");
        // Keep Alchemy's ownership markers so destroy still owns the container.
        const metadata = { ...before.metadata, purpose: "bindings" };
        expectOk(yield* op("SetContainerMetadata", { metadata }));
        expect((yield* containerProperties("meta")).metadata).toEqual(metadata);
      }),
      T,
    );
  });

  describe("SetContainerAccessPolicy", () => {
    test(
      "stores an access policy",
      Effect.gen(function* () {
        const body = yield* op("SetContainerAccessPolicy", {
          body: [
            {
              Id: "readers",
              AccessPolicy: {
                Start: "2026-01-01T00:00:00.0000000Z",
                Expiry: "2027-01-01T00:00:00.0000000Z",
                Permission: "r",
              },
            },
          ],
        });
        expectOk(body);
        const at = yield* where("meta");
        const acl = yield* asDeployer(blob.GetContainerAccessPolicy(at));
        expect(
          acl.map((identifier) => [identifier.Id, identifier.AccessPolicy.Permission]),
        ).toEqual([["readers", "r"]]);
      }),
      T,
    );
  });

  describe("GetContainerAccessPolicy", () => {
    test(
      "reads the container's access policies",
      Effect.gen(function* () {
        const body = yield* op("GetContainerAccessPolicy");
        expectOk(body);
        expect(Array.isArray(body.result)).toBe(true);
      }),
      T,
    );
  });

  describe("UndeleteBlob", () => {
    test(
      "restores a soft-deleted blob",
      Effect.gen(function* () {
        yield* upload("writes", "undelete.txt", "back again");
        const at = yield* where("writes");
        yield* asDeployer(blob.DeleteBlob({ ...at, blob: "undelete.txt" }));
        expectOk(yield* op("UndeleteBlob", { blob: "undelete.txt" }));
        expect(yield* download("writes", "undelete.txt")).toBe("back again");
      }),
      T,
    );
  });

  describe("SetBlobLegalHold", () => {
    test(
      "is rejected on a container without version-level immutability",
      Effect.gen(function* () {
        yield* upload("meta", "hold.txt", "h");
        const body = yield* op("SetBlobLegalHold", { blob: "hold.txt", xMsLegalHold: true });
        expectTag(body, "StorageImmutabilityNotEnabled");
      }),
      T,
    );
  });

  describe("SetBlobImmutabilityPolicy", () => {
    test(
      "is rejected on a container without version-level immutability",
      Effect.gen(function* () {
        yield* upload("meta", "policy.txt", "p");
        const body = yield* op("SetBlobImmutabilityPolicy", {
          blob: "policy.txt",
          xMsImmutabilityPolicyUntilDate: "Fri, 01 Jan 2100 00:00:00 GMT",
          xMsImmutabilityPolicyMode: "Unlocked",
        });
        expectTag(body, "StorageImmutabilityNotEnabled");
      }),
      T,
    );
  });

  describe("DeleteBlobImmutabilityPolicy", () => {
    test(
      "is rejected on a container without version-level immutability",
      Effect.gen(function* () {
        yield* upload("meta", "unpolicy.txt", "p");
        const body = yield* op("DeleteBlobImmutabilityPolicy", { blob: "unpolicy.txt" });
        expectTag(body, "StorageImmutabilityNotEnabled");
      }),
      T,
    );
  });

  // Container leases (custom `containers/write`), one at a time on the `leases` container.

  describe.sequential("container leases", () => {
    describe("AcquireContainerLease", () => {
      test(
        "leases the container",
        Effect.gen(function* () {
          const leaseId = "44444444-4444-4444-8444-444444444444";
          const body = yield* op("AcquireContainerLease", {
            xMsLeaseDuration: -1,
            xMsProposedLeaseId: leaseId,
          });
          expectOk(body);
          expect(body.result.xMsLeaseId).toBe(leaseId);
          expect((yield* containerProperties("leases")).xMsLeaseState).toBe("leased");
          yield* breakContainerLease;
        }),
        T,
      );
    });

    describe("ReleaseContainerLease", () => {
      test(
        "releases the container lease",
        Effect.gen(function* () {
          const leaseId = yield* acquireContainerLease();
          expectOk(yield* op("ReleaseContainerLease", { xMsLeaseId: leaseId }));
          expect((yield* containerProperties("leases")).xMsLeaseState).toBe("available");
        }),
        T,
      );
    });

    describe("RenewContainerLease", () => {
      test(
        "renews the container lease",
        Effect.gen(function* () {
          const leaseId = yield* acquireContainerLease(15);
          const body = yield* op("RenewContainerLease", { xMsLeaseId: leaseId });
          expectOk(body);
          expect(body.result.xMsLeaseId).toBe(leaseId);
          yield* breakContainerLease;
        }),
        T,
      );
    });

    describe("ChangeContainerLease", () => {
      test(
        "changes the container lease's ID",
        Effect.gen(function* () {
          const leaseId = yield* acquireContainerLease();
          const proposed = "55555555-5555-4555-8555-555555555555";
          const body = yield* op("ChangeContainerLease", {
            xMsLeaseId: leaseId,
            xMsProposedLeaseId: proposed,
          });
          expectOk(body);
          expect(body.result.xMsLeaseId).toBe(proposed);
          yield* breakContainerLease;
        }),
        T,
      );
    });

    describe("BreakContainerLease", () => {
      test(
        "breaks the container lease",
        Effect.gen(function* () {
          yield* acquireContainerLease();
          expectOk(yield* op("BreakContainerLease", { xMsLeaseBreakPeriod: 0 }));
          expect((yield* containerProperties("leases")).xMsLeaseState).toBe("broken");
        }),
        T,
      );
    });
  });

  // BlobContainerRead / Write / ReadWrite clients on the `clients` container.

  describe("Storage.BlobContainerRead", () => {
    test(
      "reads blobs, block lists, page ranges, and container properties",
      Effect.gen(function* () {
        yield* upload("clients", "read/a.txt", "client read");
        yield* upload("clients", "read/dir/b.txt", "b");
        yield* createPageBlob("clients", "read/disk.vhd", 1024);
        yield* writePage("clients", "read/disk.vhd", 1, "d");

        const got = yield* client("read", "get", "read/a.txt");
        expectOk(got);
        expect(got.result.body).toEqual({ $text: "client read" });

        const tree = yield* client("read", "listByHierarchy", { prefix: "read/", delimiter: "/" });
        expectOk(tree);
        expect({
          prefixes: names(tree.result.Segment.BlobPrefixes),
          blobs: names(tree.result.Segment.BlobItems),
        }).toEqual({ prefixes: ["read/dir/"], blobs: ["read/a.txt", "read/disk.vhd"] });

        const ranges = yield* client("read", "getPageRanges", "read/disk.vhd");
        expectOk(ranges);
        expect(ranges.result.PageRange).toEqual([{ Start: 512, End: 1023 }]);

        const container = yield* client("read", "getContainerProperties");
        expectOk(container);
        expect(container.result.metadata.alchemy_id).toBe("BlobClients");
      }),
      T,
    );
  });

  describe("Storage.BlobContainerWrite", () => {
    test(
      "writes block, append, and page blobs, metadata, tiers, and leases",
      Effect.gen(function* () {
        expectOk(
          yield* client("write", "stageBlock", "write/blocks.txt", {
            blockid: blockId(0),
            body: { $text: "ab" },
          }),
        );
        expectOk(
          yield* client("write", "stageBlock", "write/blocks.txt", {
            blockid: blockId(1),
            body: { $text: "cd" },
          }),
        );
        expectOk(
          yield* client("write", "commitBlockList", "write/blocks.txt", {
            Latest: [blockId(0), blockId(1)],
          }),
        );
        expect(yield* download("clients", "write/blocks.txt")).toBe("abcd");

        expectOk(yield* client("write", "createAppendBlob", "write/log.txt"));
        expectOk(
          yield* client("write", "appendBlock", "write/log.txt", { body: { $text: "line" } }),
        );
        expectOk(yield* client("write", "sealAppendBlob", "write/log.txt"));
        expect((yield* properties("clients", "write/log.txt")).xMsBlobSealed).toBe(true);

        expectOk(
          yield* client("write", "createPageBlob", "write/disk.vhd", { xMsBlobContentLength: 512 }),
        );
        expectOk(
          yield* client("write", "uploadPages", "write/disk.vhd", {
            xMsRange: "bytes=0-511",
            body: { $text: page("w") },
          }),
        );
        expectOk(
          yield* client("write", "resizePageBlob", "write/disk.vhd", {
            xMsBlobContentLength: 1024,
          }),
        );
        expect((yield* properties("clients", "write/disk.vhd")).contentLength).toBe(1024);

        expectOk(yield* client("write", "put", "write/meta.txt", "m"));
        expectOk(
          yield* client("write", "setMetadata", "write/meta.txt", { metadata: { by: "client" } }),
        );
        expectOk(yield* client("write", "setTier", "write/meta.txt", { xMsAccessTier: "Cool" }));
        const meta = yield* properties("clients", "write/meta.txt");
        expect({ metadata: meta.metadata, tier: meta.xMsAccessTier }).toEqual({
          metadata: { by: "client" },
          tier: "Cool",
        });

        const lease = yield* client("write", "acquireLease", "write/meta.txt", {
          xMsLeaseDuration: 15,
        });
        expectOk(lease);
        expectOk(
          yield* client("write", "releaseLease", "write/meta.txt", {
            xMsLeaseId: lease.result.xMsLeaseId,
          }),
        );
        expect((yield* properties("clients", "write/meta.txt")).xMsLeaseState).toBe("available");

        expectOk(yield* client("write", "delete", "write/meta.txt"));
        expectOk(yield* client("write", "undelete", "write/meta.txt"));
        expect(yield* download("clients", "write/meta.txt")).toBe("m");
      }),
      T,
    );
  });

  describe("Storage.BlobContainerReadWrite", () => {
    test(
      "copies a blob and reads the copy back",
      Effect.gen(function* () {
        expectOk(yield* client("readWrite", "put", "rw/source.txt", "read write"));
        const source = yield* blobUrl("clients", "rw/source.txt");
        expectOk(yield* client("readWrite", "startCopy", "rw/copy.txt", { xMsCopySource: source }));
        const copied = yield* client("readWrite", "get", "rw/copy.txt").pipe(
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (b) => b.ok && b.result !== undefined,
            times: 10,
          }),
        );
        expectOk(copied);
        expect(copied.result.body).toEqual({ $text: "read write" });
      }),
      T,
    );
  });

  // Account-level bindings on the service account.

  describe("ListBlobContainers", () => {
    test(
      "lists the account's containers",
      Effect.gen(function* () {
        const { names: containerNames } = yield* outputs;
        const body = yield* op("ListBlobContainers", { prefix: containerNames.svcTags });
        expectOk(body);
        expect(body.result.ContainerItems.map((c: { Name: string }) => c.Name)).toEqual([
          containerNames.svcTags,
        ]);
      }),
      T,
    );
  });

  describe("CreateBlobContainer", () => {
    test(
      "creates a container at runtime",
      Effect.gen(function* () {
        expectOk(yield* op("CreateBlobContainer", { containerName: "runtime-created" }));
        const found = (yield* serviceContainers).find((c) => c.name === "runtime-created");
        expect(found?.deleted).toBe(false);
      }),
      T,
    );
  });

  describe("DeleteBlobContainer", () => {
    test(
      "deletes a container",
      Effect.gen(function* () {
        yield* createServiceContainer("runtime-doomed");
        expectOk(yield* op("DeleteBlobContainer", { containerName: "runtime-doomed" }));
        const found = (yield* serviceContainers).filter((c) => c.name === "runtime-doomed");
        expect(found.map((c) => c.deleted)).toEqual([true]);
      }),
      T,
    );
  });

  describe("RestoreBlobContainer", () => {
    test(
      "restores a soft-deleted container",
      Effect.gen(function* () {
        yield* createServiceContainer("runtime-restore");
        const url = yield* serviceUrl;
        yield* asDeployer(blob.DeleteContainer({ url, containerName: "runtime-restore" }));
        const deleted = (yield* serviceContainers).find(
          (c) => c.name === "runtime-restore" && c.deleted,
        );
        expect(deleted?.version).toMatch(/^[0-9A-F]+$/);
        // The name stays reserved while the delete finishes.
        const body = yield* op("RestoreBlobContainer", {
          containerName: "runtime-restore",
          xMsDeletedContainerName: "runtime-restore",
          xMsDeletedContainerVersion: deleted?.version,
        }).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("10 seconds"),
            until: (b) => b.tag !== "StorageBeingDeleted",
            times: 12,
          }),
        );
        expectOk(body);
        const live = (yield* serviceContainers).filter(
          (c) => c.name === "runtime-restore" && !c.deleted,
        );
        expect(live.length).toBe(1);
      }),
      T,
    );
  });

  describe("GetBlobServiceProperties", () => {
    test(
      "reads the soft delete policy",
      Effect.gen(function* () {
        const body = yield* op("GetBlobServiceProperties");
        expectOk(body);
        const { Enabled, Days } = body.result.DeleteRetentionPolicy;
        expect({ Enabled, Days }).toEqual({ Enabled: true, Days: 2 });
      }),
      T,
    );
  });

  describe("SetBlobServiceProperties", () => {
    test(
      "enables hourly metrics",
      Effect.gen(function* () {
        const body = yield* op("SetBlobServiceProperties", {
          HourMetrics: {
            Version: "1.0",
            Enabled: true,
            IncludeAPIs: true,
            RetentionPolicy: { Enabled: true, Days: 3 },
          },
        });
        expectOk(body);
        const url = yield* serviceUrl;
        const props = yield* asDeployer(blob.GetServiceProperties({ url }));
        expect({
          enabled: props.HourMetrics?.Enabled,
          days: props.HourMetrics?.RetentionPolicy?.Days,
          softDelete: props.DeleteRetentionPolicy?.Days,
        }).toEqual({ enabled: true, days: 3, softDelete: 2 });
      }),
      T,
    );
  });

  describe("GetBlobServiceStatistics", () => {
    test(
      "reads geo-replication status from the secondary endpoint",
      Effect.gen(function* () {
        const body = yield* op("GetBlobServiceStatistics");
        expectOk(body);
        expect(body.result.GeoReplication.Status).toMatch(/^(live|bootstrap|unavailable)$/);
      }),
      T,
    );
  });

  describe("FindBlobsByTagsInAccount", () => {
    test(
      "finds tagged blobs across containers",
      Effect.gen(function* () {
        const at = yield* where("svcTags");
        yield* asDeployer(blob.UploadBlockBlob({ ...at, blob: "tenant.txt", body: bytes("t") }));
        yield* asDeployer(
          blob.SetBlobTags({
            ...at,
            blob: "tenant.txt",
            BlobTagSet: [{ Key: "tenant", Value: "acme" }],
          }),
        );
        // The tag index trails tag writes by seconds.
        const body = yield* op("FindBlobsByTagsInAccount", { where: `"tenant"='acme'` }).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (b) => b.ok && (b.result.Blobs ?? []).length > 0,
            times: 12,
          }),
        );
        expectOk(body);
        expect(
          body.result.Blobs.map((b: { ContainerName: string; Name: string }) => [
            b.ContainerName,
            b.Name,
          ]),
        ).toEqual([[at.containerName, "tenant.txt"]]);
      }),
      T,
    );
  });

  describe("least privilege", () => {
    test.provider(
      "assigns one role per container, each custom role holding only its permissions",
      (_stack) =>
        Effect.gen(function* () {
          const out = yield* outputs;
          const { subscriptionId } = yield* Azure.AzureEnvironment.current;
          const page = yield* authorization.ListRoleAssignmentForSubscription({
            subscriptionId,
            _filter: `principalId eq '${out.principalId}'`,
          });
          const byScope = new Map<string, string[]>();
          for (const a of page.value) {
            const scope = a.properties?.scope?.toLowerCase() ?? "";
            const list = byScope.get(scope) ?? [];
            list.push(a.properties?.roleDefinitionId ?? "");
            byScope.set(scope, list);
          }
          const permissionsOf = (roleDefinitionId: string) =>
            authorization
              .GetRoleDefinition({
                scope: `/subscriptions/${subscriptionId}`,
                roleDefinitionId: roleDefinitionId.split("/").pop() ?? roleDefinitionId,
              })
              .pipe(
                Effect.map((d) =>
                  (d.properties?.permissions ?? []).flatMap((p) => [
                    ...(p.actions ?? []),
                    ...(p.dataActions ?? []),
                  ]),
                ),
              );
          const granted: Record<string, string[]> = {};
          for (const key of Object.keys(out.ids) as ContainerKey[]) {
            const roles = byScope.get(out.ids[key].toLowerCase()) ?? [];
            const perms: string[] = [];
            for (const role of roles) perms.push(...(yield* permissionsOf(role)));
            granted[key] = [...new Set(perms.map((p) => p.split("/containers/")[1] ?? p))].sort();
          }
          expect(granted).toEqual({
            reads: [DELEGATION_KEY, "blobs/read", "read"],
            writes: ["blobs/write"],
            copies: ["blobs/read", "blobs/write"],
            deletes: ["blobs/delete"],
            tags: ["blobs/filter/action", "blobs/tags/read", "blobs/tags/write"],
            meta: [
              "blobs/immutableStorage/runAsSuperUser/action",
              "getAcl/action",
              "read",
              "setAcl/action",
              "write",
            ],
            leases: ["write"],
            clients: [
              DELEGATION_KEY,
              "blobs/add/action",
              "blobs/delete",
              "blobs/move/action",
              "blobs/read",
              "blobs/write",
              "delete",
              "read",
              "write",
            ],
            sources: [],
            svcTags: [],
          });
          const accountRoles = byScope.get(out.serviceAccountId.toLowerCase()) ?? [];
          const accountPerms: string[] = [];
          for (const role of accountRoles) accountPerms.push(...(yield* permissionsOf(role)));
          expect(
            [...new Set(accountPerms.map((p) => p.split("/containers/")[1] ?? p))].sort(),
          ).toEqual([
            "Microsoft.Storage/storageAccounts/blobServices/read",
            "Microsoft.Storage/storageAccounts/blobServices/write",
            "blobs/filter/action",
            "delete",
            "read",
            "write",
          ]);
        }),
      { timeout: 120_000 },
    );
  });
});

// Destroy, then prove the Function's role assignments and the custom roles are gone.
afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const { principalId } = yield* outputs;
    yield* destroy(Stack);
    expect(principalId).toMatch(/^[0-9a-f-]{36}$/);
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const remaining = yield* authorization
      .ListRoleAssignmentForSubscription({
        subscriptionId,
        _filter: `principalId eq '${principalId}'`,
      })
      .pipe(
        Effect.map((page) => page.value.length),
        // The subscription-wide list trails deletes by a minute or more.
        Effect.repeat({
          schedule: Schedule.spaced("10 seconds"),
          until: (n) => n === 0,
          times: 24,
        }),
      );
    expect(remaining).toBe(0);
    const roles = yield* authorization
      .ListRoleDefinitions({
        scope: `/subscriptions/${subscriptionId}`,
        _filter: "type eq 'CustomRole'",
      })
      .pipe(
        Effect.map((page) =>
          page.value.filter((d) =>
            (d.properties?.description ?? "").includes("AzureStorageBlobBindings"),
          ),
        ),
        // Custom-role lists trail deletes by a few minutes.
        Effect.repeat({
          schedule: Schedule.spaced("10 seconds"),
          until: (left) => left.length === 0,
          times: 24,
        }),
      );
    expect(roles.map((d) => d.properties?.roleName)).toEqual([]);
  }).pipe(Effect.provide(azure)),
  { timeout: 900_000 },
);
