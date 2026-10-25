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
    for (const [key, make] of Object.entries(Shares)) {
      const share = yield* make;
      names[key] = share.shareName;
      ids[key] = share.shareId;
    }
    return {
      url: fn.url,
      principalId: fn.principalId,
      account: account.storageAccountName,
      resourceGroup: account.resourceGroup,
      names,
      ids,
    };
  }),
);

// ~$0.02/run (Flex Consumption Function, two Standard_LRS accounts, five 1 GiB shares); ~6 min deploy.
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
    const signedExpiry = yield* Effect.sync(() => new Date(Date.now() + 3_600_000).toISOString());
    const sas = yield* storage.ListStorageAccountServiceSAS({
      subscriptionId,
      resourceGroupName: out.resourceGroup,
      accountName: out.account,
      canonicalizedResource: `/file/${out.account}/${shareName}`,
      signedResource: "s",
      signedPermission: "rcwdl",
      signedProtocol: "https",
      signedExpiry,
    });
    return {
      url: `https://${out.account}.file.core.windows.net?${sas.serviceSasToken}`,
      shareName,
    };
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
    const dataActions = (definition?.properties?.permissions ?? [])
      .flatMap((p) => p.dataActions ?? [])
      .map((action) => action.replace("Microsoft.Storage/storageAccounts/fileServices/", ""))
      .sort();
    return `${marker?.[1] ?? roleDefinitionId}(${dataActions.join(",")})`;
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
            until: (found) => found.length >= 8,
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
        until: (ids) => ids.length === 2,
        times: 6,
      }),
    );
    yield* destroy(Stack);
    expect(customRoleIds.length).toBe(2);
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
