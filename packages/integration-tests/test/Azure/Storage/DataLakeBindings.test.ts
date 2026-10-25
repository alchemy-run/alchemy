import * as Azure from "@alchemy.run/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as storage from "@distilled.cloud/azure/storage";
import * as datalake from "@distilled.cloud/azure/storage-datalake";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import DataLakeFunction, {
  FileSystems,
  Lake,
  LakeAdmin,
  LakeBlobService,
  type FileSystemKey,
} from "./fixtures/datalake-function.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

const keys = Object.keys(FileSystems) as FileSystemKey[];

const Stack = Alchemy.Stack(
  "AzureStorageDataLakeBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* DataLakeFunction;
    const lake = yield* Lake;
    const admin = yield* LakeAdmin;
    yield* LakeBlobService;
    const names: Record<string, unknown> = {};
    const ids: Record<string, unknown> = {};
    for (const key of keys) {
      const container = yield* FileSystems[key];
      names[key] = container.containerName;
      ids[key] = container.containerId;
    }
    return {
      url: fn.url,
      principalId: fn.principalId,
      hostStorageAccount: fn.storageAccountName,
      accountName: lake.storageAccountName,
      resourceGroup: lake.resourceGroup,
      adminAccountName: admin.storageAccountName,
      adminAccountId: admin.storageAccountId,
      names: names as Record<FileSystemKey, string>,
      ids: ids as Record<FileSystemKey, string>,
    };
  }),
);

// ~$0.01/run (two HNS accounts, 20 filesystems, a Flex Consumption app); ~6 min deploy.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

/** Azure credentials and environment for hooks (tests get them from `test.provider`). */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

type Body = { ok: boolean; result?: any; error?: string };

/**
 * Call a binding route until it answers `ok`, through the Flex Consumption
 * cold start and role propagation (custom roles take a few minutes on the
 * data plane), then return the last answer so a real failure shows its
 * Azure error.
 */
const call = (route: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    return yield* HttpClient.get(`${url}${route}`).pipe(
      Effect.timeout("60 seconds"),
      Effect.flatMap((response) => response.json),
      Effect.map((body) => body as Body),
      Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 72 }),
      Effect.catch((body) => Effect.succeed(body as Body)),
    );
  });

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

/** `?<account SAS>` the deployer lists through ARM (not the Function's identity). */
const accountSas = Effect.gen(function* () {
  const { accountName, resourceGroup } = yield* stack;
  const { subscriptionId } = yield* Azure.AzureEnvironment.current;
  const { accountSasToken } = yield* storage.ListStorageAccountAccountSAS({
    subscriptionId,
    resourceGroupName: resourceGroup,
    accountName,
    signedServices: "b",
    signedResourceTypes: "sco",
    signedPermission: "rwdlacup",
    signedProtocol: "https",
    signedExpiry: new Date(Date.now() + 3_600_000).toISOString(),
  });
  return accountSasToken;
});

/** Out-of-band access to one filesystem with the account SAS. */
const oob = (key: FileSystemKey) =>
  Effect.gen(function* () {
    const { accountName, names } = yield* stack;
    const sas = yield* accountSas;
    const at = {
      url: `https://${accountName}.dfs.core.windows.net/?${sas}`,
      filesystem: names[key],
    };
    const put = (path: string, content: string) =>
      Effect.gen(function* () {
        const bytes = new TextEncoder().encode(content);
        yield* datalake.CreatePath({ ...at, path, resource: "file" });
        if (bytes.length > 0)
          yield* datalake.PathAppendData({ ...at, path, position: 0, body: bytes });
        yield* datalake.FlushPathData({ ...at, path, position: bytes.length });
      });
    return {
      filesystem: names[key],
      put,
      mkdir: (path: string) => datalake.CreatePath({ ...at, path, resource: "directory" }),
      read: (path: string) =>
        datalake.ReadPath({ ...at, path }).pipe(
          Effect.map((file) => new TextDecoder().decode(file.body)),
          Effect.catchTag("PathNotFound", () => Effect.succeed("missing" as const)),
        ),
      props: (path: string) =>
        datalake
          .GetPathProperties({ ...at, path })
          .pipe(Effect.catchTag("PathNotFound", () => Effect.succeed("missing" as const))),
      acl: (path: string) =>
        datalake
          .GetPathProperties({ ...at, path, action: "getAccessControl" })
          .pipe(Effect.map((props) => props.xMsAcl)),
      remove: (path: string) => datalake.DeletePath({ ...at, path }),
      fileSystemProperties: () => datalake.GetFileSystemProperties(at),
    };
  });

/** ARM view of a filesystem on the admin account. */
const adminFileSystem = (containerName: string) =>
  Effect.gen(function* () {
    const { adminAccountName, resourceGroup } = yield* stack;
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const where = {
      subscriptionId,
      resourceGroupName: resourceGroup,
      accountName: adminAccountName,
    };
    return {
      get: storage.GetBlobContainer({ ...where, containerName }).pipe(
        Effect.as("found" as const),
        Effect.catchTag("ContainerNotFound", () => Effect.succeed("missing" as const)),
      ),
      create: storage.CreateBlobContainer({ ...where, containerName, properties: {} }),
      remove: storage
        .DeleteBlobContainer({ ...where, containerName })
        .pipe(Effect.catchTag("ContainerNotFound", () => Effect.void)),
    };
  });

const B = "Microsoft.Storage/storageAccounts/blobServices/containers";

/** `<scope> <sorted actions and data actions>` for every binding role on the Function. */
const grantsOf = (principalId: string, hostStorageAccount: string | undefined) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const page = yield* authorization.ListRoleAssignmentForSubscription({
      subscriptionId,
      _filter: `principalId eq '${principalId}'`,
    });
    const grants: string[] = [];
    const customRoles: string[] = [];
    for (const assignment of page.value) {
      const scope = assignment.properties?.scope?.toLowerCase() ?? "";
      // Drop the app's own host-storage grants.
      if (hostStorageAccount && scope.endsWith(`/storageaccounts/${hostStorageAccount}`)) continue;
      const roleDefinitionId = assignment.properties?.roleDefinitionId?.split("/").pop() ?? "";
      const role = yield* authorization.GetRoleDefinition({
        scope: `/subscriptions/${subscriptionId}`,
        roleDefinitionId,
      });
      if (role.properties?.type === "CustomRole") customRoles.push(roleDefinitionId);
      const permissions = (role.properties?.permissions ?? []).flatMap((p) => [
        ...(p.actions ?? []),
        ...(p.dataActions ?? []),
      ]);
      grants.push(`${scope} ${[...permissions].sort().join(",")}`);
    }
    return { grants: grants.sort(), customRoles };
  });

describe(
  "Azure Data Lake Storage bindings on an Azure Function",
  { tags: ["provider:azure", "live"] },
  () => {
    describe("CreatePath", () => {
      test(
        "creates a directory and a file",
        Effect.gen(function* () {
          expectOk(yield* call("/create-path?path=made&resource=directory"));
          expectOk(yield* call("/create-path?path=made/file.txt&resource=file"));
          const fs = yield* oob("createPath");
          const dir = yield* fs.props("made");
          const file = yield* fs.props("made/file.txt");
          expect(dir !== "missing" && dir.xMsResourceType).toEqual("directory");
          expect(file !== "missing" && file.xMsResourceType).toEqual("file");
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("AppendPathData", () => {
      test(
        "stages bytes that stay invisible until a flush",
        Effect.gen(function* () {
          const fs = yield* oob("appendPathData");
          yield* fs.put("staged.txt", "");
          expectOk(yield* call("/append?path=staged.txt&position=0&text=staged"));
          // Appended data is uncommitted: the file is still empty.
          expect(yield* fs.read("staged.txt")).toEqual("");
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("FlushPathData", () => {
      test(
        "commits staged bytes",
        Effect.gen(function* () {
          const fs = yield* oob("flushPathData");
          const sas = yield* accountSas;
          const { accountName, names } = yield* stack;
          const at = {
            url: `https://${accountName}.dfs.core.windows.net/?${sas}`,
            filesystem: names.flushPathData,
            path: "flushed.txt",
          };
          yield* datalake.CreatePath({ ...at, resource: "file" });
          yield* datalake.PathAppendData({
            ...at,
            position: 0,
            body: new TextEncoder().encode("flushed"),
          });
          expect(yield* fs.read("flushed.txt")).toEqual("");
          expectOk(yield* call("/flush?path=flushed.txt&position=7"));
          expect(yield* fs.read("flushed.txt")).toEqual("flushed");
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("ReadPath", () => {
      test(
        "reads a file",
        Effect.gen(function* () {
          const fs = yield* oob("readPath");
          yield* fs.put("read/me.txt", "read-me");
          const body = yield* call("/read-path?path=read/me.txt");
          expectOk(body);
          expect(body.result).toEqual({ text: "read-me", contentLength: 7 });
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("GetPathProperties", () => {
      test(
        "reads a file's properties and access control list",
        Effect.gen(function* () {
          const fs = yield* oob("getPathProperties");
          yield* fs.put("props.txt", "props");
          const acl = yield* fs.acl("props.txt");
          const body = yield* call("/get-path-properties?path=props.txt");
          expectOk(body);
          expect(body.result).toEqual({ resourceType: "file", contentLength: 5, acl });
          expect(acl).toMatch(/^user::/);
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("DeletePath", () => {
      test(
        "deletes a file",
        Effect.gen(function* () {
          const fs = yield* oob("deletePath");
          yield* fs.put("doomed.txt", "doomed");
          expectOk(yield* call("/delete-path?path=doomed.txt"));
          expect(yield* fs.props("doomed.txt")).toEqual("missing");
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("ListPaths", () => {
      test(
        "lists a directory recursively",
        Effect.gen(function* () {
          const fs = yield* oob("listPaths");
          yield* fs.mkdir("tree/sub");
          yield* fs.put("tree/a.txt", "a");
          yield* fs.put("tree/sub/b.txt", "b");
          const body = yield* call("/list-paths?directory=tree");
          expectOk(body);
          expect(body.result).toEqual(["tree/a.txt", "tree/sub/", "tree/sub/b.txt"]);
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("ListFileSystemBlobHierarchy", () => {
      test(
        "lists one level of a prefix through the Blob service",
        Effect.gen(function* () {
          const fs = yield* oob("listBlobs");
          yield* fs.put("level/a.txt", "a");
          yield* fs.put("level/deeper/b.txt", "b");
          const body = yield* call("/list-blobs?prefix=level/");
          expectOk(body);
          expect(body.result).toEqual({ blobs: ["level/a.txt"], prefixes: ["level/deeper/"] });
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("RenamePath", () => {
      test(
        "renames a file",
        Effect.gen(function* () {
          const fs = yield* oob("renamePath");
          yield* fs.put("before.txt", "moved");
          expectOk(yield* call("/rename-path?source=before.txt&path=after.txt"));
          expect(yield* fs.read("before.txt")).toEqual("missing");
          expect(yield* fs.read("after.txt")).toEqual("moved");
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("SetPathAccessControl", () => {
      test(
        "sets a file's ACL",
        Effect.gen(function* () {
          const fs = yield* oob("setPathAccessControl");
          yield* fs.put("acl.txt", "acl");
          expectOk(yield* call("/set-acl?path=acl.txt&acl=user::rwx,group::r--,other::---"));
          expect(yield* fs.acl("acl.txt")).toEqual("user::rwx,group::r--,other::---");
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("SetPathAccessControlRecursive", () => {
      test(
        "modifies the ACL of a directory and everything under it",
        Effect.gen(function* () {
          const fs = yield* oob("setPathAccessControlRecursive");
          yield* fs.mkdir("shared");
          yield* fs.put("shared/a.txt", "a");
          const body = yield* call("/set-acl-recursive?path=shared&acl=other::r-x");
          expectOk(body);
          expect(body.result).toEqual({
            directoriesSuccessful: 1,
            filesSuccessful: 1,
            failureCount: 0,
          });
          expect(yield* fs.acl("shared")).toContain("other::r-x");
          expect(yield* fs.acl("shared/a.txt")).toContain("other::r-x");
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("LeasePath", () => {
      test(
        "acquires and releases a lease",
        Effect.gen(function* () {
          const fs = yield* oob("leasePath");
          yield* fs.put("leased.txt", "leased");
          const leaseId = "4f1d3c2b-8a7e-4b6d-9c5f-1e2d3c4b5a69";
          const acquired = yield* call(`/lease?path=leased.txt&action=acquire&leaseId=${leaseId}`);
          expectOk(acquired);
          expect(acquired.result.xMsLeaseId).toEqual(leaseId);
          const held = yield* fs.props("leased.txt");
          expect(held !== "missing" && held.xMsLeaseState).toEqual("leased");
          expectOk(yield* call(`/lease?path=leased.txt&action=release&leaseId=${leaseId}`));
          const released = yield* fs.props("leased.txt");
          expect(released !== "missing" && released.xMsLeaseState).toEqual("available");
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("SetPathExpiry", () => {
      test(
        "sets a file to expire in an hour",
        Effect.gen(function* () {
          const fs = yield* oob("setPathExpiry");
          yield* fs.put("expiring.txt", "expiring");
          const before = Date.now();
          expectOk(yield* call("/expiry?path=expiring.txt&ms=3600000"));
          const props = yield* fs.props("expiring.txt");
          const expiry = props !== "missing" ? Date.parse(props.xMsExpiryTime ?? "") : NaN;
          // Within a few minutes of one hour from now (clock skew, retries).
          expect(Math.abs(expiry - (before + 3_600_000)) < 5 * 60_000).toBe(true);
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("UndeletePath", () => {
      test(
        "restores a soft-deleted file",
        Effect.gen(function* () {
          const fs = yield* oob("undeletePath");
          yield* fs.put("restored.txt", "restored");
          const { xMsDeletionId } = yield* fs.remove("restored.txt");
          expect(xMsDeletionId).toMatch(/^\d+$/);
          expect(yield* fs.read("restored.txt")).toEqual("missing");
          expectOk(yield* call(`/undelete?path=restored.txt&deletionId=${xMsDeletionId}`));
          expect(yield* fs.read("restored.txt")).toEqual("restored");
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("SetPathProperties", () => {
      test(
        "sets a file's content type",
        Effect.gen(function* () {
          const fs = yield* oob("setPathProperties");
          yield* fs.put("typed.json", "{}");
          expectOk(
            yield* call("/set-path-properties?path=typed.json&contentType=application/json"),
          );
          const props = yield* fs.props("typed.json");
          expect(props !== "missing" && props.contentType).toEqual("application/json");
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("GetFileSystemProperties", () => {
      test(
        "reads the filesystem's properties",
        Effect.gen(function* () {
          const fs = yield* oob("getFileSystemProperties");
          const observed = yield* fs.fileSystemProperties();
          const body = yield* call("/get-fs-properties");
          expectOk(body);
          expect(body.result).toEqual({
            namespaceEnabled: "true",
            properties: observed.xMsProperties,
          });
          expect(observed.xMsProperties).toContain(
            `alchemy_id=${btoa("DlGetFileSystemProperties")}`,
          );
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("SetFileSystemProperties", () => {
      test(
        "sets a property and keeps the ownership markers",
        Effect.gen(function* () {
          const fs = yield* oob("setFileSystemProperties");
          expectOk(yield* call("/set-fs-properties?name=purpose&value=lake"));
          const observed = yield* fs.fileSystemProperties();
          const properties = (observed.xMsProperties ?? "").split(",").sort();
          expect(properties.filter((p) => !p.startsWith("alchemy_"))).toEqual([
            `purpose=${btoa("lake")}`,
          ]);
          expect(properties).toContain(`alchemy_id=${btoa("DlSetFileSystemProperties")}`);
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("CreateFileSystem", () => {
      test(
        "creates a filesystem in the account",
        Effect.gen(function* () {
          const created = yield* adminFileSystem("dlbind-created");
          expectOk(yield* call("/create-fs?name=dlbind-created"));
          expect(yield* created.get).toEqual("found");
          yield* created.remove;
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("DeleteFileSystem", () => {
      test(
        "deletes a filesystem from the account",
        Effect.gen(function* () {
          const doomed = yield* adminFileSystem("dlbind-deleted");
          yield* doomed.create;
          expectOk(yield* call("/delete-fs?name=dlbind-deleted"));
          const status = yield* doomed.get.pipe(
            Effect.repeat({
              schedule: Schedule.spaced("3 seconds"),
              until: (s) => s === "missing",
              times: 10,
            }),
          );
          expect(status).toEqual("missing");
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("ListFileSystems", () => {
      test(
        "lists the account's filesystems by prefix",
        Effect.gen(function* () {
          const listed = yield* adminFileSystem("dlbind-listed");
          yield* listed.create;
          const body = yield* call("/list-fs?prefix=dlbind-listed");
          expectOk(body);
          expect(body.result).toEqual(["dlbind-listed"]);
          yield* listed.remove;
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("DataLakeFileSystemRead", () => {
      test(
        "reads files and properties, lists, and reports missing paths",
        Effect.gen(function* () {
          const fs = yield* oob("read");
          yield* fs.mkdir("docs");
          yield* fs.put("docs/readme.md", "# readme");
          const body = yield* call("/read?path=docs/readme.md&directory=docs");
          expectOk(body);
          expect(body.result).toEqual({
            text: "# readme",
            missing: true,
            size: 8,
            isDirectory: false,
            missingProps: true,
            paths: ["docs/readme.md"],
          });
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("DataLakeFileSystemWrite", () => {
      test(
        "creates a directory, writes and renames a file, then deletes the tree",
        Effect.gen(function* () {
          const fs = yield* oob("write");
          const written = yield* call("/write?dir=out&text=written");
          expectOk(written);
          expect(written.result.etag).toMatch(/^"?0x[0-9A-F]+"?$/);
          expect(yield* fs.read("out/a.txt")).toEqual("missing");
          expect(yield* fs.read("out/b.txt")).toEqual("written");
          const props = yield* fs.props("out/b.txt");
          expect(props !== "missing" && props.contentType).toEqual("text/plain");
          expectOk(yield* call("/write-delete?dir=out"));
          expect(yield* fs.props("out")).toEqual("missing");
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("DataLakeFileSystemReadWrite", () => {
      test(
        "writes, reads, renames, and lists",
        Effect.gen(function* () {
          const fs = yield* oob("readWrite");
          const body = yield* call("/read-write?dir=rw&text=round-trip");
          expectOk(body);
          expect(body.result).toEqual({
            text: "round-trip",
            contentType: "text/plain; charset=utf-8",
            size: "round-trip".length,
            paths: ["rw/b.txt"],
          });
          expect(yield* fs.read("rw/b.txt")).toEqual("round-trip");
        }).pipe(Effect.provide(azure)),
        { timeout: 600_000 },
      );
    });

    describe("least privilege", () => {
      test(
        "assigns exactly each binding's permissions on its filesystem or account",
        Effect.gen(function* () {
          const outputs = yield* stack;
          const { grants } = yield* grantsOf(outputs.principalId!, outputs.hostStorageAccount);
          const at = (scope: string, ...permissions: string[]) =>
            `${scope.toLowerCase()} ${permissions.sort().join(",")}`;
          const ids = outputs.ids;
          const reader = [
            `${B}/read`,
            `${B}/blobs/read`,
            "Microsoft.Storage/storageAccounts/blobServices/generateUserDelegationKey/action",
          ];
          const write = `${B}/blobs/write`;
          expect(grants).toEqual(
            [
              at(ids.createPath, write),
              at(ids.appendPathData, write),
              at(ids.flushPathData, write),
              at(ids.readPath, ...reader),
              at(ids.getPathProperties, ...reader),
              at(ids.deletePath, `${B}/blobs/delete`),
              at(ids.listPaths, ...reader),
              at(ids.listBlobs, ...reader),
              at(ids.renamePath, write, `${B}/blobs/move/action`),
              at(
                ids.setPathAccessControl,
                `${B}/blobs/modifyPermissions/action`,
                `${B}/blobs/manageOwnership/action`,
              ),
              at(ids.setPathAccessControlRecursive, `${B}/blobs/modifyPermissions/action`),
              at(ids.leasePath, write),
              at(ids.setPathExpiry, write),
              at(ids.undeletePath, write),
              at(ids.setPathProperties, write),
              at(ids.getFileSystemProperties, `${B}/read`),
              at(ids.setFileSystemProperties, `${B}/read`, `${B}/write`),
              at(outputs.adminAccountId, `${B}/write`),
              at(outputs.adminAccountId, `${B}/delete`),
              at(outputs.adminAccountId, `${B}/read`),
              at(ids.read, ...reader),
              at(
                ids.write,
                write,
                `${B}/blobs/delete`,
                `${B}/blobs/move/action`,
                `${B}/blobs/add/action`,
              ),
              at(
                ids.readWrite,
                `${B}/delete`,
                `${B}/read`,
                `${B}/write`,
                "Microsoft.Storage/storageAccounts/blobServices/generateUserDelegationKey/action",
                `${B}/blobs/delete`,
                `${B}/blobs/read`,
                `${B}/blobs/write`,
                `${B}/blobs/move/action`,
                `${B}/blobs/add/action`,
              ),
            ].sort(),
          );
        }).pipe(Effect.provide(azure)),
        { timeout: 120_000 },
      );
    });
  },
);

// Destroy, then prove every role assigned to the Function's identity and
// every custom role the bindings defined is gone.
afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const { principalId, hostStorageAccount } = yield* stack;
    expect(principalId).toMatch(/^[0-9a-f-]{36}$/);
    const { customRoles } = yield* grantsOf(principalId!, hostStorageAccount);
    yield* destroy(Stack);
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const remaining = yield* authorization
      .ListRoleAssignmentForSubscription({
        subscriptionId,
        _filter: `principalId eq '${principalId}'`,
      })
      .pipe(
        Effect.map((page) => page.value.length),
        Effect.repeat({ schedule: Schedule.spaced("5 seconds"), until: (n) => n === 0, times: 12 }),
      );
    expect(remaining).toEqual(0);
    for (const roleDefinitionId of new Set(customRoles)) {
      const gone = yield* authorization
        .GetRoleDefinition({ scope: `/subscriptions/${subscriptionId}`, roleDefinitionId })
        .pipe(
          Effect.as("found" as const),
          Effect.catchTag("RoleDefinitionNotFound", () => Effect.succeed("gone" as const)),
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (status) => status === "gone",
            times: 12,
          }),
        );
      expect({ roleDefinitionId, gone }).toEqual({ roleDefinitionId, gone: "gone" });
    }
  }).pipe(Effect.provide(azure)),
  { timeout: 900_000 },
);
