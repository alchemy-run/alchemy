import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as secretsManager from "@distilled.cloud/stackit/secrets_manager";
import * as kv from "@distilled.cloud/stackit/secrets_manager_kv";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { stackitTags } from "../helpers.ts";
import SecretsManagerBindingsWorker, {
  SeedRole,
  SeedSecretId,
  SeedUser,
  Vault,
} from "./fixtures/worker.ts";
import { readSecretMetadata, readSecretValues, withVault } from "./vault.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "StackitSecretsManagerBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* SecretsManagerBindingsWorker;
    const vault = yield* Vault;
    const user = yield* SeedUser;
    const role = yield* SeedRole;
    const secretId = yield* SeedSecretId;
    return {
      url: worker.url.as<string>(),
      instanceId: vault.instanceId,
      projectId: vault.projectId,
      apiUrl: vault.apiUrl,
      instanceName: vault.name,
      userId: user.userId,
      roleId: role.roleId,
      secretIdVersion: secretId.version,
    };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

const timeout = { timeout: 240_000 } as const;

// Versions of one path are asserted exactly, so the bindings run one after another.
describe.sequential(
  "STACKIT Secrets Manager bindings on a Cloudflare Worker",
  { tags: [...stackitTags("secretsmanager", "bindings"), "provider:cloudflare"] },
  () => {
    const stack = beforeAll(deploy(Stack), { timeout: 600_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 600_000 });

    // A fresh workers.dev URL, the created key and the account's memberships take
    // a while to propagate: retry until the route answers `ok`, then report the
    // last answer so a real failure shows its error.
    const call = (route: string, params: Record<string, string> = {}) =>
      Effect.gen(function* () {
        const { url } = yield* stack;
        const query = new URLSearchParams(params).toString();
        return yield* HttpClient.get(`${url}${route}?${query}`).pipe(
          Effect.timeout("20 seconds"),
          Effect.flatMap((response) => response.json),
          Effect.map((body) => body as Body),
          Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
          Effect.catch((body) => Effect.succeed(body as Body)),
        );
      });

    /** Run Vault operations out of band, against the deployed instance. */
    const outOfBand = <A, E, R>(use: (mount: string) => Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const { projectId, instanceId, apiUrl } = yield* stack;
        return yield* withVault(
          { projectId: projectId!, instanceId: instanceId!, apiUrl: apiUrl! },
          use(instanceId!),
        );
      });

    /** A secret written out of band, for a binding to act on. */
    const seedSecret = (secretPath: string, value: string) =>
      outOfBand((mount) =>
        kv
          .putSecret({ mount, secretPath, data: { value } })
          .pipe(Effect.map(({ data }) => data.version)),
      );

    describe("GetInstance", () => {
      test.provider(
        "reads the bound instance",
        (_stack) =>
          Effect.gen(function* () {
            const { instanceId, instanceName, apiUrl } = yield* stack;
            const body = yield* call("/get-instance");
            expectOk(body);
            expect(body.result.id).toBe(instanceId);
            expect(body.result.name).toBe(instanceName);
            expect(body.result.apiUrl).toBe(apiUrl);
          }),
        timeout,
      );
    });

    describe("ListACLs", () => {
      test.provider(
        "lists the bound instance's ACL entries",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/list-acls");
            expectOk(body);
            expect(body.result.acls.map((acl: { cidr: string }) => acl.cidr)).toEqual([
              "0.0.0.0/0",
            ]);
          }),
        timeout,
      );
    });

    describe("ListUsers", () => {
      test.provider(
        "lists the bound instance's users",
        (_stack) =>
          Effect.gen(function* () {
            const { userId } = yield* stack;
            const body = yield* call("/list-users");
            expectOk(body);
            expect(body.result.map((user: { id: string }) => user.id)).toContain(userId);
          }),
        timeout,
      );
    });

    describe("GetUser", () => {
      test.provider(
        "reads a user of the bound instance by id",
        (_stack) =>
          Effect.gen(function* () {
            const { userId } = yield* stack;
            const body = yield* call("/get-user", { id: userId! });
            expectOk(body);
            expect(body.result).toEqual({ id: userId, description: "bindings suite seed" });
          }),
        timeout,
      );
    });

    describe("ListAppRoles", () => {
      test.provider(
        "lists the bound instance's AppRoles",
        (_stack) =>
          Effect.gen(function* () {
            const { roleId } = yield* stack;
            const body = yield* call("/list-app-roles");
            expectOk(body);
            expect(body.result.approles.map((role: { role_id: string }) => role.role_id)).toContain(
              roleId,
            );
          }),
        timeout,
      );
    });

    describe("GetAppRole", () => {
      test.provider(
        "reads an AppRole of the bound instance by id",
        (_stack) =>
          Effect.gen(function* () {
            const { roleId } = yield* stack;
            const body = yield* call("/get-app-role", { id: roleId! });
            expectOk(body);
            expect(body.result.role_id).toBe(roleId);
            expect(body.result.description).toBe("bindings suite seed");
          }),
        timeout,
      );
    });

    describe("ListAppRoleSecretIds", () => {
      test.provider(
        "lists an AppRole's secret ids",
        (_stack) =>
          Effect.gen(function* () {
            const { roleId, secretIdVersion } = yield* stack;
            const body = yield* call("/list-app-role-secret-ids", { id: roleId! });
            expectOk(body);
            expect(body.result.map((secret: { version: number }) => secret.version)).toContain(
              secretIdVersion,
            );
          }),
        timeout,
      );
    });

    describe("GetAppRoleSecretId", () => {
      test.provider(
        "reads a secret id's metadata",
        (_stack) =>
          Effect.gen(function* () {
            const { roleId, secretIdVersion } = yield* stack;
            const body = yield* call("/get-app-role-secret-id", {
              id: roleId!,
              version: String(secretIdVersion),
            });
            expectOk(body);
            expect(body.result).toEqual({
              version: secretIdVersion,
              description: "bindings suite seed",
            });
          }),
        timeout,
      );
    });

    describe("GetSecret", () => {
      test.provider(
        "reads a secret's values, under a path with a slash",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedSecret("bind/get", "seeded-get");
            const body = yield* call("/get-secret", { path: "bind/get" });
            expectOk(body);
            expect(body.result).toEqual({ value: "seeded-get" });
          }),
        timeout,
      );
    });

    describe("PutSecret", () => {
      test.provider(
        "writes a new version",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/put-secret", { path: "bind/put", value: "from-worker" });
            expectOk(body);
            expect(body.result.data.version).toBe(1);
            const values = yield* outOfBand((mount) => readSecretValues(mount, "bind/put"));
            expect(values).toEqual({ value: "from-worker" });
          }),
        timeout,
      );
    });

    describe("ListSecrets", () => {
      test.provider(
        "lists a folder and the root",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedSecret("bind/list/one", "seeded");
            const folder = yield* call("/list-secrets", { path: "bind/list" });
            expectOk(folder);
            expect(folder.result.data.keys).toEqual(["one"]);
            const root = yield* call("/list-root-secrets");
            expectOk(root);
            expect(root.result.data.keys).toContain("bind/");
          }),
        timeout,
      );
    });

    describe("DeleteSecret", () => {
      test.provider(
        "soft-deletes the latest version, or the given versions",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedSecret("bind/delete", "first");
            yield* seedSecret("bind/delete", "second");

            const latest = yield* call("/delete-secret", { path: "bind/delete" });
            expectOk(latest);
            const afterLatest = yield* outOfBand((mount) => readSecretValues(mount, "bind/delete"));
            expect(afterLatest).toEqual("gone");

            const first = yield* call("/delete-secret-versions", {
              path: "bind/delete",
              versions: "1",
            });
            expectOk(first);
            const metadata = yield* outOfBand((mount) => readSecretMetadata(mount, "bind/delete"));
            expect(metadata).toMatchObject({
              versions: { "1": { destroyed: false }, "2": { destroyed: false } },
            });
            if (metadata === "gone") return yield* Effect.die("metadata is gone");
            expect(metadata.versions?.["1"]?.deletion_time).not.toEqual("");
            expect(metadata.versions?.["2"]?.deletion_time).not.toEqual("");
          }),
        timeout,
      );
    });

    describe("UndeleteSecret", () => {
      test.provider(
        "restores a soft-deleted version",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedSecret("bind/undelete", "restored");
            yield* outOfBand((mount) =>
              kv.deleteLatestSecretVersion({ mount, secretPath: "bind/undelete" }),
            );
            const body = yield* call("/undelete-secret", {
              path: "bind/undelete",
              versions: "1",
            });
            expectOk(body);
            const values = yield* outOfBand((mount) => readSecretValues(mount, "bind/undelete"));
            expect(values).toEqual({ value: "restored" });
          }),
        timeout,
      );
    });

    describe("DestroySecretVersions", () => {
      test.provider(
        "permanently destroys a version",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedSecret("bind/destroy", "doomed");
            const body = yield* call("/destroy-secret-versions", {
              path: "bind/destroy",
              versions: "1",
            });
            expectOk(body);
            const metadata = yield* outOfBand((mount) => readSecretMetadata(mount, "bind/destroy"));
            expect(metadata).toMatchObject({ versions: { "1": { destroyed: true } } });
          }),
        timeout,
      );
    });

    describe("PurgeSecret", () => {
      test.provider(
        "permanently deletes a secret and its metadata",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedSecret("bind/purge", "doomed");
            const body = yield* call("/purge-secret", { path: "bind/purge" });
            expectOk(body);
            const metadata = yield* outOfBand((mount) => readSecretMetadata(mount, "bind/purge"));
            expect(metadata).toEqual("gone");
          }),
        timeout,
      );
    });

    describe("GetSecretMetadata", () => {
      test.provider(
        "reads a secret's current version",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedSecret("bind/metadata", "first");
            yield* seedSecret("bind/metadata", "second");
            const body = yield* call("/get-secret-metadata", { path: "bind/metadata" });
            expectOk(body);
            expect(body.result.data.current_version).toBe(2);
          }),
        timeout,
      );
    });

    describe("PutSecretMetadata", () => {
      test.provider(
        "sets a secret's version limit",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedSecret("bind/put-metadata", "seeded");
            const body = yield* call("/put-secret-metadata", {
              path: "bind/put-metadata",
              max: "7",
            });
            expectOk(body);
            const metadata = yield* outOfBand((mount) =>
              readSecretMetadata(mount, "bind/put-metadata"),
            );
            expect(metadata).toMatchObject({ max_versions: 7 });
          }),
        timeout,
      );
    });

    describe("ReadSecret", () => {
      test.provider(
        "reads, lists and reads metadata through one client",
        (_stack) =>
          Effect.gen(function* () {
            yield* seedSecret("bind/read", "seeded-read");
            const body = yield* call("/read-secret", { path: "bind/read" });
            expectOk(body);
            expect(body.result.values).toEqual({ value: "seeded-read" });
            expect(body.result.listed.data.keys).toContain("bind/");
            expect(body.result.metadata.data.current_version).toBe(1);
          }),
        timeout,
      );

      test.provider(
        "gets a read-only AppRole, and a Writer for the write bindings",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, instanceId, roleId } = yield* stack;
            const { approles } = yield* secretsManager.listApproles({
              projectId: projectId!,
              instanceId: instanceId!,
            });
            const created = approles.filter((role) => role.role_id !== roleId);
            expect(created.map((role) => role.write).sort()).toEqual([false, true]);
          }),
        timeout,
      );
    });

    describe("WriteSecret", () => {
      test.provider(
        "writes through the client",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/write-secret", { path: "bind/write", value: "written" });
            expectOk(body);
            const values = yield* outOfBand((mount) => readSecretValues(mount, "bind/write"));
            expect(values).toEqual({ value: "written" });
          }),
        timeout,
      );
    });

    describe("ReadWriteSecret", () => {
      test.provider(
        "writes and reads back through one client",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/read-write-secret", {
              path: "bind/read-write",
              value: "round-trip",
            });
            expectOk(body);
            expect(body.result.values).toEqual({ value: "round-trip" });
          }),
        timeout,
      );
    });
  },
);
