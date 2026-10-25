import * as Azure from "@alchemy.run/azure";
import { Credentials } from "@distilled.cloud/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as secrets from "@distilled.cloud/azure/keyvault-secrets";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import KvSecretsFunction, {
  DOOMED_VALUE,
  DoomedTarget,
  READ_VALUE,
  ReadTarget,
  Vault,
  WriteTarget,
} from "./fixtures/secret-function.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

/** Built-in **Key Vault Secrets Officer**: the deployer's out-of-band data-plane access. */
const KEY_VAULT_SECRETS_OFFICER = "b86a8fe4-44ce-4948-aee5-eccb2c155cd7";

/** Object ID (`oid` claim) of the identity running the tests. */
const callerObjectId = Effect.gen(function* () {
  const config = yield* yield* Credentials;
  const token = Redacted.value(config.bearerToken);
  return yield* Effect.sync(
    () =>
      JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"))
        .oid as string,
  );
});

const Stack = Alchemy.Stack(
  "AzureKeyVaultSecretBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* KvSecretsFunction;
    const vault = yield* Vault;
    const read = yield* ReadTarget;
    const write = yield* WriteTarget;
    const doomed = yield* DoomedTarget;
    // Lets the deployer verify each binding's effect through the data plane.
    const deployer = yield* callerObjectId;
    yield* Azure.Authorization.RoleAssignment("KvDeployerSecretsOfficer", {
      scope: vault.vaultId,
      roleDefinitionId: KEY_VAULT_SECRETS_OFFICER,
      principalId: deployer,
    });
    return {
      url: fn.url,
      principalId: fn.principalId,
      vaultName: vault.vaultName,
      vaultId: vault.vaultId,
      readId: read.secretId,
      readName: read.secretName,
      writeId: write.secretId,
      writeName: write.secretName,
      doomedId: doomed.secretId,
      doomedName: doomed.secretName,
    };
  }),
);

// ~$0.01/run (Flex Consumption + a standard vault for ~10 min); ~4 min deploy.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

/** Deployer credentials and environment for out-of-band checks and hooks. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

type Body = { ok: boolean; result?: any; error?: string };

/**
 * Call a binding route until it answers `ok`, through the Flex Consumption
 * cold start and role propagation (about 4 minutes), then return the last
 * answer so a real failure shows its Azure error.
 */
const call = (route: string, body?: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    const request =
      body === undefined
        ? HttpClientRequest.get(`${url}${route}`)
        : HttpClientRequest.post(`${url}${route}`).pipe(
            HttpClientRequest.bodyText(body, "text/plain"),
          );
    return yield* HttpClient.execute(request).pipe(
      Effect.timeout("60 seconds"),
      Effect.flatMap((response) => response.json),
      Effect.map((json) => json as Body),
      Effect.flatMap((json) => (json?.ok ? Effect.succeed(json) : Effect.fail(json))),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 48 }),
      Effect.catch((json) => Effect.succeed(json as Body)),
    );
  });

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

const vaultBaseUrl = Effect.map(stack, ({ vaultName }) => `https://${vaultName}.vault.azure.net`);

/** Read a secret version through the data plane as the deployer (retried through role propagation). */
const deployerGet = (secretName: string, secretVersion = "") =>
  Effect.gen(function* () {
    const base = yield* vaultBaseUrl;
    return yield* secrets
      .GetSecret({ vaultBaseUrl: base, secretName, secretVersion })
      .pipe(Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 18 }));
  }).pipe(Effect.provide(azure));

/** Role assignments of the Function's identity, without its own host-storage grants. */
const assignmentsOf = (principalId: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    // Every page: a filtered list can answer an empty first page with a `nextLink`.
    const assignments = yield* Stream.runCollect(
      authorization.ListRoleAssignmentForSubscription.items({
        subscriptionId,
        _filter: `principalId eq '${principalId}'`,
      }),
    );
    return Array.from(assignments).filter(
      (a) => !/\/storageaccounts\/[^/]+$/.test(a.properties?.scope?.toLowerCase() ?? ""),
    );
  });

/** Every role on the Function's identity as `<data actions> <scope>`. */
const grantsOf = (principalId: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const grants: string[] = [];
    for (const assignment of yield* assignmentsOf(principalId)) {
      const scope = assignment.properties?.scope?.toLowerCase() ?? "";
      const definition = yield* authorization.GetRoleDefinition({
        scope: `/subscriptions/${subscriptionId}`,
        roleDefinitionId: assignment.properties?.roleDefinitionId?.split("/").pop() ?? "",
      });
      const actions = (definition.properties?.permissions ?? [])
        .flatMap((p) => [...(p.actions ?? []), ...(p.dataActions ?? [])])
        .map((a) => a.replace("Microsoft.KeyVault/vaults/secrets/", ""))
        .sort()
        .join("+");
      grants.push(`${actions} ${scope}`);
    }
    return grants.sort();
  });

describe(
  "Key Vault secret bindings on an Azure Function",
  { tags: ["provider:azure", "live"] },
  () => {
    describe("KeyVault.GetSecret", () => {
      test(
        "reads the latest and a pinned version; a missing version is SecretNotFound",
        Effect.gen(function* () {
          const body = yield* call("/get");
          expectOk(body);
          expect(body.result).toEqual({
            value: READ_VALUE,
            pinned: READ_VALUE,
            missing: "SecretNotFound",
          });
        }),
        { timeout: 300_000 },
      );
    });

    describe("KeyVault.GetSecretVersions", () => {
      test(
        "lists the deployed version",
        Effect.gen(function* () {
          const { readName } = yield* stack;
          const body = yield* call("/versions");
          expectOk(body);
          const latest = yield* deployerGet(readName);
          expect(body.result.versions).toEqual([latest.id?.split("/").pop()]);
        }),
        { timeout: 300_000 },
      );
    });

    describe("KeyVault.SecretRead", () => {
      test(
        "gets the value and lists versions",
        Effect.gen(function* () {
          const body = yield* call("/read");
          expectOk(body);
          expect(body.result.value).toEqual(READ_VALUE);
          expect(body.result.pinned).toEqual(READ_VALUE);
          expect(body.result.versions).toHaveLength(1);
        }),
        { timeout: 300_000 },
      );
    });

    describe("KeyVault.SetSecret", () => {
      test(
        "writes a new version the deployer reads back",
        Effect.gen(function* () {
          const { writeName } = yield* stack;
          const body = yield* call("/set?value=set-by-function");
          expectOk(body);
          expect(body.result.contentType).toEqual("text/plain");
          const observed = yield* deployerGet(writeName, body.result.version);
          expect(observed.value).toEqual("set-by-function");
        }),
        { timeout: 300_000 },
      );
    });

    describe("KeyVault.UpdateSecret", () => {
      test(
        "changes a version's content type and tags",
        Effect.gen(function* () {
          const { writeName } = yield* stack;
          const latest = yield* deployerGet(writeName);
          const version = latest.id?.split("/").pop() ?? "";
          const body = yield* call(`/update?version=${version}`);
          expectOk(body);
          expect(body.result).toEqual({ version, contentType: "application/json" });
          const observed = yield* deployerGet(writeName, version);
          expect({ contentType: observed.contentType, tags: observed.tags }).toEqual({
            contentType: "application/json",
            tags: { updatedBy: "UpdateSecret" },
          });
        }),
        { timeout: 300_000 },
      );
    });

    describe("KeyVault.SecretWrite", () => {
      test(
        "sets a version and updates it",
        Effect.gen(function* () {
          const { writeName } = yield* stack;
          const body = yield* call("/write?value=written-by-write");
          expectOk(body);
          expect(body.result.updatedVersion).toEqual(body.result.version);
          const observed = yield* deployerGet(writeName, body.result.version);
          expect({
            value: observed.value,
            contentType: observed.contentType,
            tags: observed.tags,
          }).toEqual({
            value: "written-by-write",
            contentType: "text/csv",
            tags: { via: "write", updated: "yes" },
          });
        }),
        { timeout: 300_000 },
      );
    });

    describe("KeyVault.SecretReadWrite", () => {
      test(
        "sets a version, reads it back, and lists it",
        Effect.gen(function* () {
          const { writeName } = yield* stack;
          const body = yield* call("/read-write?value=round-trip");
          expectOk(body);
          expect({ value: body.result.value, listed: body.result.listed }).toEqual({
            value: "round-trip",
            listed: true,
          });
          const latest = yield* deployerGet(writeName);
          expect(latest.value).toEqual("round-trip");
        }),
        { timeout: 300_000 },
      );
    });

    describe("KeyVault.GetSecrets", () => {
      test(
        "lists the vault's secrets",
        Effect.gen(function* () {
          const { readName, writeName, doomedName } = yield* stack;
          const body = yield* call("/list");
          expectOk(body);
          expect([...body.result.names].sort()).toEqual([readName, writeName, doomedName].sort());
        }),
        { timeout: 300_000 },
      );
    });

    // The doomed secret's chain runs in order: back up, delete, read deleted,
    // recover, delete again, purge, restore from the backup.
    let backup = "";

    describe("KeyVault.BackupSecret", () => {
      test(
        "returns a backup blob",
        Effect.gen(function* () {
          const body = yield* call("/backup");
          expectOk(body);
          backup = body.result.blob;
          expect(backup.length).toBeGreaterThan(100);
        }),
        { timeout: 300_000 },
      );
    });

    describe("KeyVault.DeleteSecret", () => {
      test(
        "soft-deletes the secret",
        Effect.gen(function* () {
          const { doomedName } = yield* stack;
          const body = yield* call("/delete");
          expectOk(body);
          expect(body.result.recoveryId).toContain(`/deletedsecrets/${doomedName}`);
          const gone = yield* Effect.gen(function* () {
            const base = yield* vaultBaseUrl;
            return yield* secrets
              .GetSecret({ vaultBaseUrl: base, secretName: doomedName, secretVersion: "" })
              .pipe(
                Effect.as("found"),
                Effect.catchTag("SecretNotFound", () => Effect.succeed("gone")),
              );
          }).pipe(Effect.provide(azure));
          expect(gone).toEqual("gone");
        }),
        { timeout: 300_000 },
      );
    });

    describe("KeyVault.GetDeletedSecret", () => {
      test(
        "reads the deleted secret",
        Effect.gen(function* () {
          const { doomedName } = yield* stack;
          const body = yield* call("/deleted");
          expectOk(body);
          expect(body.result.name).toEqual(doomedName);
        }),
        { timeout: 300_000 },
      );
    });

    describe("KeyVault.GetDeletedSecrets", () => {
      test(
        "lists the deleted secret",
        Effect.gen(function* () {
          const { doomedName } = yield* stack;
          const body = yield* call("/deleted-list");
          expectOk(body);
          expect(body.result.names).toEqual([doomedName]);
        }),
        { timeout: 300_000 },
      );
    });

    describe("KeyVault.RecoverDeletedSecret", () => {
      test(
        "recovers the secret with its value",
        Effect.gen(function* () {
          const { doomedName } = yield* stack;
          const body = yield* call("/recover");
          expectOk(body);
          expect(body.result.name).toEqual(doomedName);
          const observed = yield* deployerGet(doomedName);
          expect(observed.value).toEqual(DOOMED_VALUE);
        }),
        { timeout: 300_000 },
      );
    });

    describe("KeyVault.PurgeDeletedSecret", () => {
      test(
        "purges the deleted secret",
        Effect.gen(function* () {
          expectOk(yield* call("/delete"));
          const body = yield* call("/purge");
          expectOk(body);
          expect(body.result.after).toEqual("SecretNotFound");
        }),
        { timeout: 300_000 },
      );
    });

    describe("KeyVault.RestoreSecret", () => {
      test(
        "restores the purged secret from its backup",
        Effect.gen(function* () {
          const { doomedName } = yield* stack;
          expect(backup.length).toBeGreaterThan(100);
          const body = yield* call("/restore", backup);
          expectOk(body);
          expect(body.result.name).toEqual(doomedName);
          const observed = yield* deployerGet(doomedName);
          expect(observed.value).toEqual(DOOMED_VALUE);
        }),
        { timeout: 300_000 },
      );
    });

    describe("AzureBindings.Bind least privilege", () => {
      test(
        "assigns exactly each binding's data actions, scoped to the bound secret or vault",
        Effect.gen(function* () {
          const outputs = yield* stack;
          expect(outputs.principalId).toMatch(/^[0-9a-f-]{36}$/);
          const grants = yield* grantsOf(outputs.principalId!).pipe(Effect.provide(azure));
          const id = (value: string | undefined) => value!.toLowerCase();
          const read = id(outputs.readId);
          const write = id(outputs.writeId);
          const doomed = id(outputs.doomedId);
          const vault = id(outputs.vaultId);
          expect(grants).toEqual(
            [
              `getSecret/action ${read}`,
              `readMetadata/action ${read}`,
              `getSecret/action+readMetadata/action ${read}`,
              `setSecret/action ${write}`,
              `update/action ${write}`,
              `setSecret/action+update/action ${write}`,
              `getSecret/action+readMetadata/action ${write}`,
              `backup/action ${doomed}`,
              `delete ${doomed}`,
              `getSecret/action ${doomed}`,
              `recover/action ${doomed}`,
              `purge/action ${doomed}`,
              `readMetadata/action ${vault}`,
              `restore/action ${vault}`,
            ].sort(),
          );
        }),
        { timeout: 120_000 },
      );
    });
  },
);

// Destroy, then prove every role assigned to the Function's identity is gone.
afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const { principalId } = yield* stack;
    yield* destroy(Stack);
    expect(principalId).toMatch(/^[0-9a-f-]{36}$/);
    const remaining = yield* assignmentsOf(principalId!).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (assignments) => assignments.length === 0,
        times: 12,
      }),
    );
    expect(remaining.map((a) => a.properties?.scope)).toEqual([]);
  }).pipe(Effect.provide(azure)),
  { timeout: 900_000 },
);
