import * as Azure from "@alchemy.run/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as storage from "@distilled.cloud/azure/storage";
import * as files from "@distilled.cloud/azure/storage-file";
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
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import FileShareBindingsFunction, { FileAccount, Shares } from "./fixtures/file-share-function.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

type ShareKey = keyof typeof Shares;

const Stack = Alchemy.Stack(
  "AzureStorageFileShareBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* FileShareBindingsFunction;
    const account = yield* FileAccount;
    const names: Record<string, Output.Output<string, never>> = {};
    const ids: Record<string, Output.Output<string, never>> = {};
    const accounts: Record<string, Output.Output<string, never>> = {};
    for (const [key, make] of Object.entries(Shares)) {
      const share = yield* make;
      names[key] = share.shareName;
      ids[key] = share.shareId;
      accounts[key] = share.storageAccount;
    }
    return {
      url: fn.url,
      principalId: fn.principalId,
      account: account.storageAccountName,
      resourceGroup: account.resourceGroup,
      names,
      ids,
      accounts,
    };
  }),
);

// ~$0.05/run (Flex Consumption Function, two Standard_LRS accounts, nine 1 GiB shares, one
// Premium_LRS FileStorage account with a 100 GiB NFS share for ~15 min); ~6 min deploy.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

/** Azure credentials and environment for hooks and out-of-band checks. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

type Body = { ok: boolean; result?: any; tag?: string; error?: string };

/** Typed tags Azure Files answers while a new role assignment propagates. */
const ACCESS_PENDING = new Set([
  "SchemaRegistryStorageAccessDenied",
  "StorageAuthorizationFailure",
]);

const outputs = Effect.gen(function* () {
  const out = yield* stack;
  return {
    url: out.url as string,
    principalId: out.principalId as string,
    account: out.account as string,
    resourceGroup: out.resourceGroup as string,
    names: out.names as Record<ShareKey, string>,
    ids: out.ids as Record<ShareKey, string>,
    accounts: out.accounts as Record<ShareKey, string>,
  };
});

/**
 * GET a fixture route until it answers 200 and is not waiting on role
 * propagation (about 4 minutes, through the Flex Consumption cold start),
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
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 48 }),
    );
  });

/** Call a per-operation binding through the fixture. */
const op = (name: string, request: Record<string, unknown> = {}) =>
  get(`/op/${name}?req=${encodeURIComponent(JSON.stringify(request))}`);

/** Call a FileShareRead / Write / ReadWrite client method through the fixture. */
const client = (kind: "read" | "write" | "readWrite", method: string, ...args: unknown[]) =>
  get(`/client/${kind}/${method}?args=${encodeURIComponent(JSON.stringify(args))}`);

const expectOk = (body: Body) =>
  expect({ ok: body.ok, tag: body.tag, error: body.error }).toEqual({
    ok: true,
    tag: undefined,
    error: undefined,
  });

/**
 * The deployer's own access to a share, out of band: a one-hour service SAS
 * signed with the account key (ARM `listServiceSas`), so checks never wait
 * on a role assignment.
 */
const deployerShare = (key: ShareKey) =>
  Effect.gen(function* () {
    const out = yield* outputs;
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const shareName = out.names[key];
    const account = out.accounts[key];
    const signedExpiry = yield* Effect.sync(() => new Date(Date.now() + 3_600_000).toISOString());
    const sas = yield* storage.ListStorageAccountServiceSAS({
      subscriptionId,
      resourceGroupName: out.resourceGroup,
      accountName: account,
      canonicalizedResource: `/file/${account}/${shareName}`,
      signedResource: "s",
      signedPermission: "rcwdl",
      signedProtocol: "https",
      signedExpiry,
    });
    return {
      url: `https://${account}.file.core.windows.net?${sas.serviceSasToken}`,
      shareName,
    };
  });

/** A URL for `path` in the share that carries the deployer's SAS, for copy sources. */
const sasFileUrl = (key: ShareKey, path: string) =>
  Effect.map(deployerShare(key), ({ url, shareName }) => {
    const [endpoint, query] = url.split("?");
    return `${endpoint}/${shareName}/${path}?${query}`;
  });

/** The plain (unsigned) URL of `path` in the share. */
const plainFileUrl = (key: ShareKey, path: string) =>
  Effect.map(
    outputs,
    (out) => `https://${out.accounts[key]}.file.core.windows.net/${out.names[key]}/${path}`,
  );

/** The ARM identifiers of a share, for out-of-band share-level checks. */
const armShare = (key: ShareKey) =>
  Effect.gen(function* () {
    const out = yield* outputs;
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return {
      subscriptionId,
      resourceGroupName: out.resourceGroup,
      accountName: out.accounts[key],
      shareName: out.names[key],
    };
  });

/** A share's ARM view (quota, metadata, access policies, lease state). */
const shareOf = (key: ShareKey) =>
  Effect.flatMap(armShare(key), (where) => storage.GetFileShare(where));

/** Lease a share out of band through ARM. */
const leaseShare = (key: ShareKey, request: Omit<storage.FileSharesLeaseRequest, keyof ArmShare>) =>
  Effect.flatMap(armShare(key), (where) => storage.FileSharesLease({ ...where, ...request }));

type ArmShare = Effect.Success<ReturnType<typeof armShare>>;

/** Delete `fileName` out of band if it exists. */
const removeFile = (key: ShareKey, fileName: string) =>
  Effect.gen(function* () {
    const where = yield* deployerShare(key);
    yield* files
      .DeleteFile({ ...where, fileName })
      .pipe(Effect.catchTag(["ResourceNotFound", "ParentNotFound"], () => Effect.void));
  });

/** Delete an empty `directory` out of band if it exists. */
const removeDirectory = (key: ShareKey, directory: string) =>
  Effect.gen(function* () {
    const where = yield* deployerShare(key);
    yield* files
      .DeleteDirectory({ ...where, directory })
      .pipe(Effect.catchTag(["ResourceNotFound", "ParentNotFound"], () => Effect.void));
  });

/** Write `text` to `fileName` out of band. */
const seedFile = (key: ShareKey, fileName: string, text: string) =>
  Effect.gen(function* () {
    const where = yield* deployerShare(key);
    const body = new TextEncoder().encode(text);
    yield* files.CreateFile({ ...where, fileName, xMsContentLength: body.byteLength });
    if (body.byteLength > 0) {
      yield* files.UploadFileRange({
        ...where,
        fileName,
        xMsRange: `bytes=0-${body.byteLength - 1}`,
        xMsWrite: "update",
        body,
      });
    }
  });

/** Create `directory` out of band (its parent must exist). */
const seedDirectory = (key: ShareKey, directory: string) =>
  Effect.gen(function* () {
    const where = yield* deployerShare(key);
    yield* files
      .CreateDirectory({ ...where, directory })
      .pipe(Effect.catchTag("StorageResourceAlreadyExists", () => Effect.void));
  });

/** Read a file out of band as text. */
const readFile = (key: ShareKey, fileName: string) =>
  Effect.gen(function* () {
    const where = yield* deployerShare(key);
    const res = yield* files.DownloadFile({ ...where, fileName });
    return new TextDecoder().decode(res.body);
  });

const fileProperties = (key: ShareKey, fileName: string) =>
  Effect.gen(function* () {
    const where = yield* deployerShare(key);
    return yield* files.GetFileProperties({ ...where, fileName });
  });

const directoryProperties = (key: ShareKey, directory: string) =>
  Effect.gen(function* () {
    const where = yield* deployerShare(key);
    return yield* files.GetDirectoryProperties({ ...where, directory });
  });

/** The tag a failed out-of-band call ended with, or `"found"`. */
const tagOf = <A, E extends { _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.result(effect).pipe(
    Effect.map((result) => (Result.isSuccess(result) ? "found" : result.failure._tag)),
  );

const assignmentsOf = (principalId: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    // Every page: a filtered list can answer an empty first page with a nextLink.
    const assignments = yield* authorization.ListRoleAssignmentForSubscription.items({
      subscriptionId,
      _filter: `principalId eq '${principalId}'`,
    }).pipe(Stream.runCollect);
    return Array.from(assignments).map(
      (a) =>
        `${a.properties?.roleDefinitionId?.split("/").pop()} ${a.properties?.scope?.toLowerCase()}`,
    );
  });

/** A role definition by GUID, or `undefined` once it is gone. */
const roleDefinition = (roleDefinitionId: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* authorization
      .GetRoleDefinition({ scope: `/subscriptions/${subscriptionId}`, roleDefinitionId })
      .pipe(Effect.catchTag("RoleDefinitionNotFound", () => Effect.succeed(undefined)));
  });

/**
 * Name a role the way the assertions read it: the built-in reader, or the
 * logical ID in a custom role's ownership marker, with its data actions.
 */
const describeRole = (roleDefinitionId: string) =>
  Effect.gen(function* () {
    if (roleDefinitionId === Azure.Authorization.BuiltInRole.StorageFileDataPrivilegedReader) {
      return "PrivilegedReader";
    }
    const definition = yield* roleDefinition(roleDefinitionId);
    const marker = /\[alchemy AzureStorageFileShareBindings\/[^/]+\/([^\]]+)\]$/.exec(
      definition?.properties?.description ?? "",
    );
    const permissions = (definition?.properties?.permissions ?? [])
      .flatMap((p) => [...(p.actions ?? []), ...(p.dataActions ?? [])])
      .map((action) => action.replace("Microsoft.Storage/storageAccounts/fileServices/", ""))
      .sort();
    return `${marker?.[1] ?? roleDefinitionId}(${permissions.join(",")})`;
  });

/**
 * A security descriptor in SDDL: owner and group SYSTEM, full access for
 * SYSTEM, in the canonical form Azure Files stores and answers (it appends
 * the empty SACL `S:NO_ACCESS_CONTROL`).
 */
const SDDL = "O:SYG:SYD:(A;;FA;;;SY)S:NO_ACCESS_CONTROL";

/** Fixed lease IDs (the lease tests run one at a time). */
const LEASE_A = "6a1d3f0e-8c1b-4f43-9d55-1e0a9c2b7f10";
const LEASE_B = "b4e7c2a9-3f58-4d0e-8a61-7c9d2e1f0b35";

/** Break any lease an interrupted run left on the leases share. */
const breakLeftoverShareLease = Effect.gen(function* () {
  const arm = yield* shareOf("leases");
  // ARM answers the lease state in lower case.
  if (arm.properties?.leaseState?.toLowerCase() === "leased") {
    yield* leaseShare("leases", { action: "Break", breakPeriod: 0 });
  }
});

const fileShareScope = (shareId: string) =>
  shareId.replace(/\/shares\/([^/]+)$/i, "/fileshares/$1").toLowerCase();

describe("Azure Files bindings on an Azure Function", { tags: ["provider:azure", "live"] }, () => {
  describe("Storage.DownloadFile", () => {
    test(
      "downloads a file the deployer wrote",
      Effect.gen(function* () {
        yield* seedFile("reads", "op-download.txt", "download-body");
        const body = yield* op("DownloadFile", { fileName: "op-download.txt" });
        expectOk(body);
        expect(body.result.body).toEqual({ $text: "download-body" });
        expect(body.result.contentLength).toBe("download-body".length);
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.GetFileProperties", () => {
    test(
      "reads a file's size",
      Effect.gen(function* () {
        yield* seedFile("reads", "op-props.txt", "12345678");
        const body = yield* op("GetFileProperties", { fileName: "op-props.txt" });
        expectOk(body);
        expect(body.result.contentLength).toBe(8);
        const missing = yield* op("GetFileProperties", { fileName: "op-props-missing.txt" });
        expect({ ok: missing.ok, tag: missing.tag }).toEqual({
          ok: false,
          tag: "ResourceNotFound",
        });
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.ListFilesAndDirectories", () => {
    test(
      "lists a directory",
      Effect.gen(function* () {
        yield* seedDirectory("reads", "op-list");
        yield* seedDirectory("reads", "op-list/sub");
        yield* seedFile("reads", "op-list/a.txt", "a");
        const body = yield* op("ListFilesAndDirectories", { directory: "op-list" });
        expectOk(body);
        expect({
          files: body.result.Segment.FileItems.map((i: any) => i.Name.content),
          directories: body.result.Segment.DirectoryItems.map((i: any) => i.Name.content),
        }).toEqual({ files: ["a.txt"], directories: ["sub"] });
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.GetDirectoryProperties", () => {
    test(
      "reads a directory's metadata",
      Effect.gen(function* () {
        yield* seedDirectory("reads", "op-dir");
        const where = yield* deployerShare("reads");
        yield* files.SetDirectoryMetadata({
          ...where,
          directory: "op-dir",
          metadata: { purpose: "probe" },
        });
        const body = yield* op("GetDirectoryProperties", { directory: "op-dir" });
        expectOk(body);
        expect(body.result.metadata).toEqual({ purpose: "probe" });
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.GetFileRangeList", () => {
    test(
      "lists the written ranges of a file",
      Effect.gen(function* () {
        yield* seedFile("reads", "op-ranges.txt", "hello");
        const body = yield* op("GetFileRangeList", { fileName: "op-ranges.txt" });
        expectOk(body);
        expect(body.result.Ranges).toEqual([{ Start: 0, End: 4 }]);
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.CreateFile", () => {
    test(
      "creates a sized file at the share root",
      Effect.gen(function* () {
        const body = yield* op("CreateFile", { fileName: "op-create.txt", xMsContentLength: 7 });
        expectOk(body);
        const props = yield* fileProperties("writes", "op-create.txt");
        expect(props.contentLength).toBe(7);
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.UploadFileRange", () => {
    test(
      "writes bytes into a file",
      Effect.gen(function* () {
        yield* seedFile("writes", "op-upload.txt", "-----");
        const body = yield* op("UploadFileRange", {
          fileName: "op-upload.txt",
          xMsRange: "bytes=0-4",
          xMsWrite: "update",
          body: { $text: "hello" },
        });
        expectOk(body);
        expect(yield* readFile("writes", "op-upload.txt")).toBe("hello");
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.CreateDirectory", () => {
    test(
      "creates nested directories one level at a time",
      Effect.gen(function* () {
        // Start empty even when an interrupted run left the directories behind.
        const where = yield* deployerShare("writes");
        for (const directory of ["op-mkdir/inner", "op-mkdir"]) {
          yield* files
            .DeleteDirectory({ ...where, directory })
            .pipe(Effect.catchTag(["ResourceNotFound", "ParentNotFound"], () => Effect.void));
        }
        expectOk(yield* op("CreateDirectory", { directory: "op-mkdir" }));
        expectOk(yield* op("CreateDirectory", { directory: "op-mkdir/inner" }));
        expect(yield* tagOf(directoryProperties("writes", "op-mkdir/inner"))).toBe("found");
        const again = yield* op("CreateDirectory", { directory: "op-mkdir" });
        expect({ ok: again.ok, tag: again.tag }).toEqual({
          ok: false,
          tag: "StorageResourceAlreadyExists",
        });
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.SetFileMetadata", () => {
    test(
      "replaces a file's metadata",
      Effect.gen(function* () {
        yield* seedFile("writes", "op-meta.txt", "m");
        expectOk(
          yield* op("SetFileMetadata", { fileName: "op-meta.txt", metadata: { owner: "fn" } }),
        );
        const props = yield* fileProperties("writes", "op-meta.txt");
        expect(props.metadata).toEqual({ owner: "fn" });
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.SetFileHTTPHeaders", () => {
    test(
      "sets a file's content type",
      Effect.gen(function* () {
        yield* seedFile("writes", "op-headers.html", "<p>hi</p>");
        expectOk(
          yield* op("SetFileHTTPHeaders", {
            fileName: "op-headers.html",
            xMsContentType: "text/html",
          }),
        );
        const props = yield* fileProperties("writes", "op-headers.html");
        expect(props.contentType).toBe("text/html");
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.SetDirectoryMetadata", () => {
    test(
      "replaces a directory's metadata",
      Effect.gen(function* () {
        yield* seedDirectory("writes", "op-dirmeta");
        expectOk(
          yield* op("SetDirectoryMetadata", { directory: "op-dirmeta", metadata: { team: "fn" } }),
        );
        const props = yield* directoryProperties("writes", "op-dirmeta");
        expect(props.metadata).toEqual({ team: "fn" });
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.DeleteFile", () => {
    test(
      "deletes a file the deployer wrote",
      Effect.gen(function* () {
        yield* seedFile("deletes", "op-delete.txt", "bye");
        expectOk(yield* op("DeleteFile", { fileName: "op-delete.txt" }));
        expect(yield* tagOf(fileProperties("deletes", "op-delete.txt"))).toBe("ResourceNotFound");
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.DeleteDirectory", () => {
    test(
      "deletes an empty directory and refuses a non-empty one",
      Effect.gen(function* () {
        yield* seedDirectory("deletes", "op-rmdir");
        yield* seedDirectory("deletes", "op-full");
        yield* seedFile("deletes", "op-full/keep.txt", "k");
        expectOk(yield* op("DeleteDirectory", { directory: "op-rmdir" }));
        expect(yield* tagOf(directoryProperties("deletes", "op-rmdir"))).toBe("ResourceNotFound");
        const full = yield* op("DeleteDirectory", { directory: "op-full" });
        expect({ ok: full.ok, tag: full.tag }).toEqual({ ok: false, tag: "DirectoryNotEmpty" });
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.FileShareRead", () => {
    test(
      "gets, heads, and lists files the deployer wrote",
      Effect.gen(function* () {
        yield* seedDirectory("reads", "client");
        yield* seedFile("reads", "client/read.txt", "read-body");
        const got = yield* client("read", "get", "client/read.txt");
        expectOk(got);
        expect({ path: got.result.path, text: got.result.text, size: got.result.size }).toEqual({
          path: "client/read.txt",
          text: "read-body",
          size: 9,
        });
        const head = yield* client("read", "head", "client/read.txt");
        expectOk(head);
        expect(head.result.size).toBe(9);
        const listed = yield* client("read", "list", { directory: "client" });
        expectOk(listed);
        expect(listed.result).toEqual({
          files: [{ path: "client/read.txt", size: 9 }],
          directories: [],
        });
        // Missing files and directories read as absent, not as errors.
        const missing = yield* client("read", "get", "nowhere/missing.txt");
        expect(missing).toEqual({ ok: true });
        const missingHead = yield* client("read", "head", "client/missing.txt");
        expect(missingHead).toEqual({ ok: true });
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.FileShareWrite", () => {
    test(
      "puts into new directories, deletes files, and manages directories",
      Effect.gen(function* () {
        const put = yield* client("write", "put", "w/deep/x.txt", "write-body");
        expectOk(put);
        expect(put.result.etag).toMatch(/^"?0x[0-9A-F]+"?$/);
        expect(yield* readFile("writeClient", "w/deep/x.txt")).toBe("write-body");

        expectOk(yield* client("write", "delete", "w/deep/x.txt"));
        // Deleting a missing file succeeds.
        expectOk(yield* client("write", "delete", "w/deep/x.txt"));
        expect(yield* tagOf(fileProperties("writeClient", "w/deep/x.txt"))).toBe(
          "ResourceNotFound",
        );

        const notEmpty = yield* client("write", "deleteDirectory", "w");
        expect({ ok: notEmpty.ok, tag: notEmpty.tag }).toEqual({
          ok: false,
          tag: "DirectoryNotEmpty",
        });
        expectOk(yield* client("write", "createDirectory", "w2/a/b"));
        expect(yield* tagOf(directoryProperties("writeClient", "w2/a/b"))).toBe("found");
        expectOk(yield* client("write", "deleteDirectory", "w2/a/b"));
        expect(yield* tagOf(directoryProperties("writeClient", "w2/a/b"))).toBe("ResourceNotFound");
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.FileShareReadWrite", () => {
    test(
      "puts, gets, heads, lists, and deletes a file",
      Effect.gen(function* () {
        expectOk(
          yield* client("readWrite", "put", "rw/data.json", '{"a":1}', {
            contentType: "application/json",
          }),
        );
        const got = yield* client("readWrite", "get", "rw/data.json");
        expectOk(got);
        expect({ text: got.result.text, contentType: got.result.contentType }).toEqual({
          text: '{"a":1}',
          contentType: "application/json",
        });
        const listed = yield* client("readWrite", "list", { directory: "rw" });
        expect(listed.result.files).toEqual([{ path: "rw/data.json", size: 7 }]);
        expectOk(yield* client("readWrite", "delete", "rw/data.json"));
        expect(yield* client("readWrite", "head", "rw/data.json")).toEqual({ ok: true });
        expect(yield* tagOf(fileProperties("clients", "rw/data.json"))).toBe("ResourceNotFound");
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.ListFileHandles", () => {
    test(
      "lists a file's open handles",
      Effect.gen(function* () {
        yield* seedFile("reads", "op-handles.txt", "h");
        const body = yield* op("ListFileHandles", { fileName: "op-handles.txt" });
        expectOk(body);
        // REST callers hold no SMB handles.
        expect(body.result.HandleList ?? []).toEqual([]);
        const missing = yield* op("ListFileHandles", { fileName: "op-handles-missing.txt" });
        expect({ ok: missing.ok, tag: missing.tag }).toEqual({ ok: false, tag: "ResourceNotFound" });
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.ListDirectoryHandles", () => {
    test(
      "lists a directory's open handles recursively",
      Effect.gen(function* () {
        yield* seedDirectory("reads", "op-dir-handles");
        const body = yield* op("ListDirectoryHandles", {
          directory: "op-dir-handles",
          xMsRecursive: true,
        });
        expectOk(body);
        expect(body.result.HandleList ?? []).toEqual([]);
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.GetSharePermission", () => {
    test(
      "reads a security descriptor the deployer stored",
      Effect.gen(function* () {
        const where = yield* deployerShare("reads");
        const created = yield* files.CreateSharePermission({
          ...where,
          sharePermission: { permission: SDDL, format: "Sddl" },
        });
        const body = yield* op("GetSharePermission", {
          xMsFilePermissionKey: created.xMsFilePermissionKey,
          xMsFilePermissionFormat: "Sddl",
        });
        expectOk(body);
        expect(body.result.permission).toBe(SDDL);
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.StartCopyFile", () => {
    test(
      "copies a file within the share",
      Effect.gen(function* () {
        yield* seedFile("copies", "op-copy-src.txt", "copy-body");
        yield* removeFile("copies", "op-copy-dst.txt");
        const source = yield* plainFileUrl("copies", "op-copy-src.txt");
        const body = yield* op("StartCopyFile", {
          fileName: "op-copy-dst.txt",
          xMsCopySource: source,
        });
        expectOk(body);
        expect(body.result.xMsCopyStatus).toBe("success");
        expect(yield* readFile("copies", "op-copy-dst.txt")).toBe("copy-body");
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.AbortCopyFile", () => {
    test(
      "reaches the copy of a file and reports no pending copy once it finished",
      Effect.gen(function* () {
        yield* seedFile("writes", "op-abort-src.txt", "abort-body");
        const where = yield* deployerShare("writes");
        const source = yield* sasFileUrl("writes", "op-abort-src.txt");
        const copy = yield* files.FileStartCopy({
          ...where,
          fileName: "op-abort-dst.txt",
          xMsCopySource: source,
        });
        const body = yield* op("AbortCopyFile", {
          fileName: "op-abort-dst.txt",
          copyid: copy.xMsCopyId,
        });
        expect({ ok: body.ok, tag: body.tag }).toEqual({
          ok: false,
          tag: "StorageNoPendingCopyOperation",
        });
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.UploadFileRangeFromUrl", () => {
    test(
      "writes a range of a file from another file's URL",
      Effect.gen(function* () {
        yield* seedFile("writes", "op-range-src.txt", "hello");
        yield* seedFile("writes", "op-range-dst.txt", "-----");
        const source = yield* sasFileUrl("writes", "op-range-src.txt");
        const body = yield* op("UploadFileRangeFromUrl", {
          fileName: "op-range-dst.txt",
          xMsRange: "bytes=0-4",
          xMsSourceRange: "bytes=0-4",
          xMsCopySource: source,
        });
        expectOk(body);
        expect(yield* readFile("writes", "op-range-dst.txt")).toBe("hello");
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.AcquireFileLease", () => {
    test(
      "leases a file",
      Effect.gen(function* () {
        yield* seedFile("writes", "op-lease-acquire.txt", "l");
        const body = yield* op("AcquireFileLease", {
          fileName: "op-lease-acquire.txt",
          xMsLeaseDuration: -1,
        });
        expectOk(body);
        const props = yield* fileProperties("writes", "op-lease-acquire.txt");
        expect(props.xMsLeaseState).toBe("leased");
        const where = yield* deployerShare("writes");
        yield* files.FileReleaseLease({
          ...where,
          fileName: "op-lease-acquire.txt",
          xMsLeaseId: body.result.xMsLeaseId,
        });
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.ChangeFileLease", () => {
    test(
      "moves a file lease to a new ID",
      Effect.gen(function* () {
        yield* seedFile("writes", "op-lease-change.txt", "l");
        const where = yield* deployerShare("writes");
        const lease = yield* files.FileAcquireLease({
          ...where,
          fileName: "op-lease-change.txt",
          xMsLeaseDuration: -1,
          xMsProposedLeaseId: LEASE_A,
        });
        const body = yield* op("ChangeFileLease", {
          fileName: "op-lease-change.txt",
          xMsLeaseId: lease.xMsLeaseId,
          xMsProposedLeaseId: LEASE_B,
        });
        expectOk(body);
        expect(body.result.xMsLeaseId).toBe(LEASE_B);
        // Releasing with the new ID succeeds only if the change took.
        yield* files.FileReleaseLease({
          ...where,
          fileName: "op-lease-change.txt",
          xMsLeaseId: LEASE_B,
        });
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.ReleaseFileLease", () => {
    test(
      "releases a file lease",
      Effect.gen(function* () {
        yield* seedFile("writes", "op-lease-release.txt", "l");
        const where = yield* deployerShare("writes");
        const lease = yield* files.FileAcquireLease({
          ...where,
          fileName: "op-lease-release.txt",
          xMsLeaseDuration: -1,
        });
        const body = yield* op("ReleaseFileLease", {
          fileName: "op-lease-release.txt",
          xMsLeaseId: lease.xMsLeaseId,
        });
        expectOk(body);
        const props = yield* fileProperties("writes", "op-lease-release.txt");
        expect(props.xMsLeaseState).toBe("available");
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.BreakFileLease", () => {
    test(
      "breaks a file lease without its ID",
      Effect.gen(function* () {
        yield* seedFile("writes", "op-lease-break.txt", "l");
        const where = yield* deployerShare("writes");
        yield* files.FileAcquireLease({
          ...where,
          fileName: "op-lease-break.txt",
          xMsLeaseDuration: -1,
        });
        const body = yield* op("BreakFileLease", { fileName: "op-lease-break.txt" });
        expectOk(body);
        const props = yield* fileProperties("writes", "op-lease-break.txt");
        expect(props.xMsLeaseState).toBe("broken");
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.ForceCloseFileHandles", () => {
    test(
      "closes every handle on a file",
      Effect.gen(function* () {
        yield* seedFile("writes", "op-close.txt", "c");
        const body = yield* op("ForceCloseFileHandles", {
          fileName: "op-close.txt",
          xMsHandleId: "*",
        });
        expectOk(body);
        expect(body.result.xMsNumberOfHandlesClosed).toBe(0);
        const missing = yield* op("ForceCloseFileHandles", {
          fileName: "op-close-missing.txt",
          xMsHandleId: "*",
        });
        expect({ ok: missing.ok, tag: missing.tag }).toEqual({ ok: false, tag: "ResourceNotFound" });
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.ForceCloseDirectoryHandles", () => {
    test(
      "closes every handle under a directory",
      Effect.gen(function* () {
        yield* seedDirectory("writes", "op-close-dir");
        const body = yield* op("ForceCloseDirectoryHandles", {
          directory: "op-close-dir",
          xMsHandleId: "*",
          xMsRecursive: true,
        });
        expectOk(body);
        expect(body.result.xMsNumberOfHandlesClosed).toBe(0);
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.RenameFile", () => {
    test(
      "moves a file to a new name",
      Effect.gen(function* () {
        yield* seedFile("writes", "op-rename-src.txt", "rename-body");
        const source = yield* plainFileUrl("writes", "op-rename-src.txt");
        const body = yield* op("RenameFile", {
          fileName: "op-renamed.txt",
          xMsFileRenameSource: source,
          xMsFileRenameReplaceIfExists: true,
        });
        expectOk(body);
        expect(yield* readFile("writes", "op-renamed.txt")).toBe("rename-body");
        expect(yield* tagOf(fileProperties("writes", "op-rename-src.txt"))).toBe(
          "ResourceNotFound",
        );
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.RenameDirectory", () => {
    test(
      "moves a directory to a new name",
      Effect.gen(function* () {
        // Start clean even when an interrupted run left the target behind.
        yield* removeDirectory("writes", "op-rendir-dst");
        yield* seedDirectory("writes", "op-rendir-src");
        const source = yield* plainFileUrl("writes", "op-rendir-src");
        const body = yield* op("RenameDirectory", {
          directory: "op-rendir-dst",
          xMsFileRenameSource: source,
        });
        expectOk(body);
        expect(yield* tagOf(directoryProperties("writes", "op-rendir-dst"))).toBe("found");
        expect(yield* tagOf(directoryProperties("writes", "op-rendir-src"))).toBe(
          "ResourceNotFound",
        );
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.SetDirectoryProperties", () => {
    test(
      "sets a directory's SMB attributes",
      Effect.gen(function* () {
        yield* seedDirectory("writes", "op-dirprops");
        const body = yield* op("SetDirectoryProperties", {
          directory: "op-dirprops",
          // A directory's attribute list must name `Directory`.
          xMsFileAttributes: "Directory|Hidden",
        });
        expectOk(body);
        const props = yield* directoryProperties("writes", "op-dirprops");
        expect(props.xMsFileAttributes?.split(" | ").sort()).toEqual(["Directory", "Hidden"]);
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.CreateSharePermission", () => {
    test(
      "stores a security descriptor and returns its key",
      Effect.gen(function* () {
        const body = yield* op("CreateSharePermission", {
          sharePermission: { permission: SDDL, format: "Sddl" },
        });
        expectOk(body);
        const where = yield* deployerShare("permissions");
        const stored = yield* files.GetSharePermission({
          ...where,
          xMsFilePermissionKey: body.result.xMsFilePermissionKey,
          xMsFilePermissionFormat: "Sddl",
        });
        expect(stored.permission).toBe(SDDL);
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.GetShareProperties", () => {
    test(
      "reads the share's quota, protocol and ownership metadata",
      Effect.gen(function* () {
        const body = yield* op("GetShareProperties");
        expectOk(body);
        const arm = yield* shareOf("shareReads");
        expect({
          quota: body.result.xMsShareQuota,
          protocols: body.result.xMsEnabledProtocols,
          id: body.result.metadata?.alchemy_id,
        }).toEqual({ quota: 1, protocols: "SMB", id: arm.properties?.metadata?.alchemy_id });
        expect(body.result.metadata?.alchemy_id).toBe("FileShareReads");
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.GetShareAccessPolicy", () => {
    test(
      "reads the share's stored access policies",
      Effect.gen(function* () {
        const body = yield* op("GetShareAccessPolicy");
        expectOk(body);
        expect(
          (body.result as any[]).map((p) => ({ id: p.Id, permission: p.AccessPolicy?.Permission })),
        ).toEqual([{ id: "readers", permission: "rl" }]);
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.GetShareStatistics", () => {
    test(
      "reads the share's usage",
      Effect.gen(function* () {
        const body = yield* op("GetShareStatistics");
        expectOk(body);
        expect(typeof body.result.ShareUsageBytes).toBe("number");
        expect(body.result.ShareUsageBytes).toBeGreaterThanOrEqual(0);
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.SetShareProperties", () => {
    test(
      "changes the share's quota",
      Effect.gen(function* () {
        expectOk(yield* op("SetShareProperties", { xMsShareQuota: 2 }));
        const arm = yield* shareOf("shareWrites");
        expect(arm.properties?.shareQuota).toBe(2);
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.SetShareMetadata", () => {
    test(
      "replaces the share's metadata",
      Effect.gen(function* () {
        // Keep the ownership markers so the stack still owns the share.
        const before = yield* shareOf("shareWrites");
        const metadata = { ...before.properties?.metadata, probe: "fn" };
        expectOk(yield* op("SetShareMetadata", { metadata }));
        const arm = yield* shareOf("shareWrites");
        expect(arm.properties?.metadata).toEqual(metadata);
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.SetShareAccessPolicy", () => {
    test(
      "replaces the share's stored access policies",
      Effect.gen(function* () {
        expectOk(
          yield* op("SetShareAccessPolicy", {
            body: [
              {
                Id: "writers",
                AccessPolicy: {
                  Start: "2026-01-01T00:00:00.0000000Z",
                  Expiry: "2030-01-01T00:00:00.0000000Z",
                  Permission: "rw",
                },
              },
            ],
          }),
        );
        const arm = yield* shareOf("shareWrites");
        expect(
          (arm.properties?.signedIdentifiers ?? []).map((i) => ({
            id: i.id,
            permission: i.accessPolicy?.permission,
          })),
        ).toEqual([{ id: "writers", permission: "rw" }]);
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.CreateShareSnapshot", () => {
    test(
      "snapshots the share",
      Effect.gen(function* () {
        const body = yield* op("CreateShareSnapshot", { metadata: { reason: "probe" } });
        expectOk(body);
        expect(body.result.xMsSnapshot).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        const where = yield* armShare("shareWrites");
        const listed = yield* storage.ListFileShares.items({
          subscriptionId: where.subscriptionId,
          resourceGroupName: where.resourceGroupName,
          accountName: where.accountName,
          _expand: "snapshots",
        }).pipe(Stream.runCollect);
        const snapshots = Array.from(listed)
          .filter((s) => s.name === where.shareName && s.properties?.snapshotTime !== undefined)
          .map((s) => s.properties?.snapshotTime);
        expect(snapshots).toContain(body.result.xMsSnapshot);
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.AcquireShareLease", () => {
    test(
      "leases the share",
      Effect.gen(function* () {
        // A timed lease, so a failed run never blocks the share's delete for long.
        yield* breakLeftoverShareLease;
        const body = yield* op("AcquireShareLease", { xMsLeaseDuration: 60 });
        expectOk(body);
        const arm = yield* shareOf("leases");
        yield* leaseShare("leases", { action: "Release", leaseId: body.result.xMsLeaseId });
        expect(arm.properties?.leaseState).toBe("leased");
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.RenewShareLease", () => {
    test(
      "renews the share's lease",
      Effect.gen(function* () {
        yield* breakLeftoverShareLease;
        const lease = yield* leaseShare("leases", { action: "Acquire", leaseDuration: 30 });
        const body = yield* op("RenewShareLease", { xMsLeaseId: lease.leaseId });
        expectOk(body);
        expect(body.result.xMsLeaseId).toBe(lease.leaseId);
        yield* leaseShare("leases", { action: "Release", leaseId: lease.leaseId });
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.ChangeShareLease", () => {
    test(
      "moves the share's lease to a new ID",
      Effect.gen(function* () {
        yield* breakLeftoverShareLease;
        const lease = yield* leaseShare("leases", {
          action: "Acquire",
          leaseDuration: 30,
          proposedLeaseId: LEASE_A,
        });
        const body = yield* op("ChangeShareLease", {
          xMsLeaseId: lease.leaseId,
          xMsProposedLeaseId: LEASE_B,
        });
        expectOk(body);
        expect(body.result.xMsLeaseId).toBe(LEASE_B);
        // Releasing with the new ID succeeds only if the change took.
        yield* leaseShare("leases", { action: "Release", leaseId: LEASE_B });
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.ReleaseShareLease", () => {
    test(
      "releases the share's lease",
      Effect.gen(function* () {
        yield* breakLeftoverShareLease;
        const lease = yield* leaseShare("leases", { action: "Acquire", leaseDuration: 30 });
        expectOk(yield* op("ReleaseShareLease", { xMsLeaseId: lease.leaseId }));
        const arm = yield* shareOf("leases");
        expect(arm.properties?.leaseState).toBe("available");
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.BreakShareLease", () => {
    test(
      "breaks the share's lease without its ID",
      Effect.gen(function* () {
        yield* breakLeftoverShareLease;
        yield* leaseShare("leases", { action: "Acquire", leaseDuration: 30 });
        expectOk(yield* op("BreakShareLease", { xMsLeaseBreakPeriod: 0 }));
        const arm = yield* shareOf("leases");
        expect(arm.properties?.leaseState).toBe("broken");
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.CreateFileHardLink", () => {
    test(
      "links a second name to a file on an NFS share",
      Effect.gen(function* () {
        yield* removeFile("links", "op-hardlink.bin");
        yield* seedFile("links", "op-target.bin", "linked-body");
        const body = yield* op("CreateFileHardLink", {
          fileName: "op-hardlink.bin",
          xMsFileTargetFile: "op-target.bin",
        });
        expectOk(body);
        expect(body.result.xMsLinkCount).toBe(2);
        expect(yield* readFile("links", "op-hardlink.bin")).toBe("linked-body");
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.CreateFileSymbolicLink", () => {
    test(
      "creates a symbolic link on an NFS share",
      Effect.gen(function* () {
        yield* removeFile("links", "op-symlink");
        expectOk(
          yield* op("CreateFileSymbolicLink", {
            fileName: "op-symlink",
            xMsLinkText: "op-target.bin",
          }),
        );
        const where = yield* deployerShare("links");
        const link = yield* files.GetFileSymbolicLink({ ...where, fileName: "op-symlink" });
        expect(link.xMsLinkText).toBe("op-target.bin");
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("Storage.GetFileSymbolicLink", () => {
    test(
      "reads a symbolic link the deployer created",
      Effect.gen(function* () {
        yield* removeFile("links", "op-symlink-read");
        const where = yield* deployerShare("links");
        yield* files.CreateFileSymbolicLink({
          ...where,
          fileName: "op-symlink-read",
          xMsLinkText: "some/target",
        });
        const body = yield* op("GetFileSymbolicLink", { fileName: "op-symlink-read" });
        expectOk(body);
        // Azure Files answers the link text percent-encoded.
        expect(decodeURIComponent(body.result.xMsLinkText)).toBe("some/target");
      }).pipe(Effect.provide(azure)),
      { timeout: 360_000 },
    );
  });

  describe("FileShare binding roles", () => {
    test(
      "grants one least-privilege role per access level, scoped to each share",
      Effect.gen(function* () {
        const out = yield* outputs;
        // The assignment list trails role-assignment writes on some ARM replicas.
        const assignments = yield* assignmentsOf(out.principalId).pipe(
          Effect.map((all) => all.filter((a) => a.includes("/fileshares/"))),
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (found) => found.length >= 16,
            times: 12,
          }),
        );
        const described: string[] = [];
        for (const assignment of assignments) {
          const [roleId = "", scope = ""] = assignment.split(" ");
          const role = yield* describeRole(roleId);
          described.push(`${role} ${scope}`);
        }
        const reader = "PrivilegedReader";
        const writer =
          "AzureStorageFileShareWriter(fileshares/files/write,writeFileBackupSemantics/action)";
        const deleter =
          "AzureStorageFileShareDeleter(fileshares/files/delete,writeFileBackupSemantics/action)";
        const permissionWriter =
          "AzureStorageFileSharePermissionWriter(fileshares/files/modifypermissions/action,writeFileBackupSemantics/action)";
        const propertiesReader = "AzureStorageFileSharePropertiesReader(shares/read)";
        const propertiesWriter = "AzureStorageFileSharePropertiesWriter(shares/write)";
        const leaser = "AzureStorageFileShareLeaser(shares/lease/action)";
        const scope = (key: ShareKey) => fileShareScope(out.ids[key]);
        expect(described.sort()).toEqual(
          [
            `${reader} ${scope("reads")}`,
            `${writer} ${scope("writes")}`,
            `${deleter} ${scope("deletes")}`,
            `${writer} ${scope("writeClient")}`,
            `${deleter} ${scope("writeClient")}`,
            `${reader} ${scope("clients")}`,
            `${writer} ${scope("clients")}`,
            `${deleter} ${scope("clients")}`,
            `${reader} ${scope("copies")}`,
            `${writer} ${scope("copies")}`,
            `${permissionWriter} ${scope("permissions")}`,
            `${propertiesReader} ${scope("shareReads")}`,
            `${propertiesWriter} ${scope("shareWrites")}`,
            `${leaser} ${scope("leases")}`,
            `${reader} ${scope("links")}`,
            `${writer} ${scope("links")}`,
          ].sort(),
        );
      }).pipe(Effect.provide(azure)),
      { timeout: 120_000 },
    );
  });
});

/** Destroy, then prove the Function's role assignments and the custom roles are gone. */
const destroyAndVerify = (principalId: string) =>
  Effect.gen(function* () {
    const reader = Azure.Authorization.BuiltInRole.StorageFileDataPrivilegedReader;
    // The custom roles' GUIDs, read from the assignments before they go.
    const customRoleIds = yield* assignmentsOf(principalId).pipe(
      Effect.map((assignments) => [
        ...new Set(
          assignments
            .filter((a) => a.includes("/fileshares/"))
            .map((a) => a.split(" ")[0] ?? "")
            .filter((id) => id !== reader),
        ),
      ]),
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (ids) => ids.length === 6,
        times: 6,
      }),
    );
    yield* destroy(Stack);
    expect(customRoleIds.length).toBe(6);
    // The list trails deletes too (seen at over a minute).
    const remaining = yield* assignmentsOf(principalId).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (assignments) => assignments.length === 0,
        times: 30,
      }),
    );
    expect(remaining).toEqual([]);
    for (const roleId of customRoleIds) {
      const definition = yield* roleDefinition(roleId).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (found) => found === undefined,
          times: 12,
        }),
      );
      expect(definition).toBeUndefined();
    }
  });

afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    // A failed deploy has no outputs: still destroy what it created.
    const deployed = (yield* stack) as { principalId?: string } | undefined;
    const principalId = deployed?.principalId;
    yield* principalId === undefined ? destroy(Stack) : destroyAndVerify(principalId);
  }).pipe(Effect.provide(azure)),
  { timeout: 900_000 },
);
