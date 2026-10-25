import * as Azure from "@alchemy.run/azure";
import { type AzureOpError, Credentials } from "@distilled.cloud/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as certificates from "@distilled.cloud/azure/keyvault-certificates";
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
import KvCertificatesFunction, { Vault } from "./fixtures/certificate-function.ts";
import { IMPORT_PEM, IMPORT_X5T } from "./fixtures/certificate-pem.ts";
import { signCsr } from "./fixtures/sign-csr.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

/** Built-in **Key Vault Certificates Officer**: the deployer's out-of-band data-plane access. */
const KEY_VAULT_CERTIFICATES_OFFICER = "a4417e6f-fecd-4de8-b567-7b0420556985";

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
  "AzureKeyVaultCertificateBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* KvCertificatesFunction;
    const vault = yield* Vault;
    // Lets the deployer set up and verify each binding's effect through the data plane.
    const deployer = yield* callerObjectId;
    yield* Azure.Authorization.RoleAssignment("KvDeployerCertificatesOfficer", {
      scope: vault.vaultId,
      roleDefinitionId: KEY_VAULT_CERTIFICATES_OFFICER,
      principalId: deployer,
    });
    return {
      url: fn.url,
      principalId: fn.principalId,
      vaultUri: vault.vaultUri,
      vaultId: vault.vaultId,
    };
  }),
);

// ~$0.02/run (Flex Consumption + a standard vault and ~40 certificate operations); ~5 min deploy.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 600_000 });

/** Deployer credentials and environment for out-of-band checks. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

type Body = { ok: boolean; result?: any; tag?: string; error?: string };

/** Failures a route answers while the Function cold-starts or its roles propagate. */
const transient = (body: Body | undefined, retryOn: readonly string[]) =>
  !body?.ok &&
  (body?.tag === undefined ||
    body.tag === "Forbidden" ||
    body.tag === "Unauthorized" ||
    retryOn.includes(body.tag));

/**
 * `POST /call/<route>` with `request` as the JSON body. Retries through the
 * Flex Consumption cold start and role propagation (about 4 minutes), and
 * returns the first typed answer, so a test can assert typed failures.
 */
const call = (route: string, request: unknown = {}, retryOn: readonly string[] = []) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    return yield* HttpClient.execute(
      HttpClientRequest.post(`${url}/call/${route}`).pipe(
        HttpClientRequest.bodyJsonUnsafe(request),
      ),
    ).pipe(
      Effect.timeout("60 seconds"),
      Effect.flatMap((response) => response.json),
      Effect.map((json) => json as Body),
      Effect.catch((error) => Effect.succeed({ ok: false, error: String(error) } as Body)),
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        while: (body) => transient(body, retryOn),
        times: 48,
      }),
    );
  });

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

const vaultBaseUrl = Effect.map(stack, ({ vaultUri }) => vaultUri.replace(/\/+$/, ""));

/**
 * Retry a deployer data-plane call while the deployer's own role assignment
 * propagates, or when the response is cut off in transit.
 */
const asDeployer = <A, E extends { _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden" || e._tag === "HttpClientError",
      schedule: Schedule.spaced("10 seconds"),
      times: 18,
    }),
  );

const selfSigned = (name: string) => ({
  issuer: { name: "Self" },
  x509_props: { subject: `CN=${name}`, validity_months: 12 },
  key_props: { kty: "RSA", key_size: 2048, exportable: true, reuse_key: false },
  secret_props: { contentType: "application/x-pkcs12" },
});

/** Create a certificate as the deployer and wait until its operation finishes. */
const deployerCreate = (certificateName: string, issuer = "Self") =>
  Effect.gen(function* () {
    const base = yield* vaultBaseUrl;
    yield* asDeployer(
      certificates.CreateCertificate({
        vaultBaseUrl: base,
        certificateName,
        policy: { ...selfSigned(certificateName), issuer: { name: issuer } },
      }),
    );
    if (issuer !== "Self") return yield* deployerOperation(certificateName);
    const done = yield* certificates
      .GetCertificateOperation({ vaultBaseUrl: base, certificateName })
      .pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (op) => op.status !== "inProgress",
          times: 20,
        }),
      );
    expect(done.status).toEqual("completed");
    return done;
  }).pipe(Effect.provide(azure));

const deployerGet = (certificateName: string) =>
  Effect.flatMap(vaultBaseUrl, (base) =>
    asDeployer(certificates.GetCertificate({ vaultBaseUrl: base, certificateName })),
  ).pipe(Effect.provide(azure));

const deployerOperation = (certificateName: string) =>
  Effect.flatMap(vaultBaseUrl, (base) =>
    asDeployer(certificates.GetCertificateOperation({ vaultBaseUrl: base, certificateName })),
  ).pipe(Effect.provide(azure));

/** `"found"` once a read succeeds, or the typed not-found tag it keeps failing with. */
const outcome = <A, R>(read: Effect.Effect<A, AzureOpError, R>, until: "found" | "gone") =>
  read.pipe(
    Effect.as("found"),
    Effect.catchTag(
      [
        "CertificateNotFound",
        "PendingCertificateNotFound",
        "CertificateIssuerNotFound",
        "CertificateContactsNotFound",
      ],
      (e) => Effect.succeed(e._tag),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => (until === "found" ? status === "found" : status !== "found"),
      times: 20,
    }),
  );

/** Delete a certificate as the deployer and wait until it is listed as deleted. */
const deployerDelete = (certificateName: string) =>
  Effect.gen(function* () {
    const base = yield* vaultBaseUrl;
    yield* asDeployer(certificates.DeleteCertificate({ vaultBaseUrl: base, certificateName }));
    return yield* certificates.GetDeletedCertificate({ vaultBaseUrl: base, certificateName }).pipe(
      Effect.retry({
        while: (e) => e._tag === "CertificateNotFound",
        schedule: Schedule.spaced("3 seconds"),
        times: 20,
      }),
    );
  }).pipe(Effect.provide(azure));

/** Delete and purge a certificate as the deployer, so its name can be restored. */
const deployerPurge = (certificateName: string) =>
  Effect.gen(function* () {
    yield* deployerDelete(certificateName);
    const base = yield* vaultBaseUrl;
    yield* certificates.PurgeDeletedCertificate({ vaultBaseUrl: base, certificateName }).pipe(
      // "Certificate is currently being deleted."
      Effect.retry({
        while: (e) => e._tag === "ResourceConflict",
        schedule: Schedule.spaced("3 seconds"),
        times: 20,
      }),
    );
    const gone = yield* outcome(
      certificates.GetDeletedCertificate({ vaultBaseUrl: base, certificateName }),
      "gone",
    );
    expect(gone).toEqual("CertificateNotFound");
  }).pipe(Effect.provide(azure));

/** Key Vault requires both fields; the issuer is never used to order a certificate. */
const ISSUER_CREDENTIALS = { account_id: "alchemy-test", pwd: "not-a-real-api-key" };

const deployerSetIssuer = (issuerName: string, orgId: string) =>
  Effect.flatMap(vaultBaseUrl, (base) =>
    asDeployer(
      certificates.SetCertificateIssuer({
        vaultBaseUrl: base,
        issuerName,
        provider: "DigiCert",
        credentials: ISSUER_CREDENTIALS,
        org_details: { id: orgId },
      }),
    ),
  ).pipe(Effect.provide(azure));

const deployerGetIssuer = (issuerName: string) =>
  Effect.flatMap(vaultBaseUrl, (base) =>
    asDeployer(certificates.GetCertificateIssuer({ vaultBaseUrl: base, issuerName })),
  ).pipe(Effect.provide(azure));

const deployerContacts = Effect.flatMap(vaultBaseUrl, (base) =>
  asDeployer(certificates.GetCertificateContacts({ vaultBaseUrl: base })),
).pipe(Effect.provide(azure));

/** Every id across the pages of a list route. */
const listAll = (route: string, request: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    const ids: string[] = [];
    let nextLink: string | undefined;
    for (let page = 0; page < 10; page++) {
      const body = yield* call(route, { ...request, ...(nextLink ? { nextLink } : {}) });
      expectOk(body);
      for (const item of body.result.value) ids.push(item.recoveryId ?? item.id);
      nextLink = body.result.nextLink ?? undefined;
      if (nextLink === undefined) break;
    }
    return ids;
  });

/** Every role on the Function's identity, as `<data actions> <scope>`. */
const grantsOf = (principalId: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const page = yield* authorization.ListRoleAssignmentForSubscription({
      subscriptionId,
      _filter: `principalId eq '${principalId}'`,
    });
    const grants: string[] = [];
    for (const assignment of page.value) {
      const scope = assignment.properties?.scope?.toLowerCase() ?? "";
      // Skip the app's own host-storage grants.
      if (/\/storageaccounts\/[^/]+$/.test(scope)) continue;
      const definition = yield* authorization.GetRoleDefinition({
        scope: `/subscriptions/${subscriptionId}`,
        roleDefinitionId: assignment.properties?.roleDefinitionId?.split("/").pop() ?? "",
      });
      const actions = (definition.properties?.permissions ?? [])
        .flatMap((p) => [...(p.actions ?? []), ...(p.dataActions ?? [])])
        .map((a) => a.replace("Microsoft.KeyVault/vaults/", ""))
        .sort()
        .join("+");
      grants.push(`${actions} ${scope}`);
    }
    return grants.sort();
  }).pipe(Effect.provide(azure));

const timeout = { timeout: 300_000 };

describe(
  "Key Vault certificate bindings on an Azure Function",
  { tags: ["provider:azure", "live"] },
  () => {
    test(
      "assigns one custom role per data-action set, on the vault only",
      Effect.gen(function* () {
        const { principalId, vaultId } = yield* stack;
        const scope = vaultId.toLowerCase();
        // Role-assignment lists trail the writes by a few seconds.
        const grants = yield* grantsOf(principalId).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (observed) => observed.length >= 13,
            times: 24,
          }),
        );
        expect(grants).toEqual(
          [
            "certificatecas/delete",
            "certificatecas/read",
            "certificatecas/write",
            "certificatecontacts/write",
            "certificates/backup/action",
            "certificates/create/action",
            "certificates/delete",
            "certificates/import/action",
            "certificates/purge/action",
            "certificates/read",
            "certificates/recover/action",
            "certificates/restore/action",
            "certificates/update/action",
          ].map((actions) => `${actions} ${scope}`),
        );
      }),
      timeout,
    );

    describe("KeyVault.GetCertificate", () => {
      test(
        "reads the latest version; a missing certificate is CertificateNotFound",
        Effect.gen(function* () {
          yield* deployerCreate("get-cert");
          const expected = yield* deployerGet("get-cert");
          const body = yield* call("GetCertificate", { certificateName: "get-cert" });
          expectOk(body);
          expect({ id: body.result.id, x5t: body.result.x5t }).toEqual({
            id: expected.id,
            x5t: expected.x5t,
          });
          const missing = yield* call("GetCertificate", { certificateName: "get-cert-missing" });
          expect(missing.tag).toEqual("CertificateNotFound");
        }),
        timeout,
      );
    });

    describe("KeyVault.GetCertificates", () => {
      test(
        "lists a certificate the deployer created",
        Effect.gen(function* () {
          yield* deployerCreate("list-cert");
          const base = yield* vaultBaseUrl;
          const ids = yield* listAll("GetCertificates", { maxresults: 10 });
          expect(ids).toContain(`${base}/certificates/list-cert`);
        }),
        timeout,
      );
    });

    describe("KeyVault.GetCertificateVersions", () => {
      test(
        "lists both versions of a certificate",
        Effect.gen(function* () {
          yield* deployerCreate("versions-cert");
          yield* deployerCreate("versions-cert");
          const base = yield* vaultBaseUrl;
          const expected = yield* asDeployer(
            certificates.GetCertificateVersions({
              vaultBaseUrl: base,
              certificateName: "versions-cert",
            }),
          ).pipe(Effect.provide(azure));
          const body = yield* call("GetCertificateVersions", { certificateName: "versions-cert" });
          expectOk(body);
          const ids = body.result.value.map((item: { id: string }) => item.id).sort();
          expect(ids).toHaveLength(2);
          expect(ids).toEqual(expected.value.map((item) => item.id).sort());
        }),
        timeout,
      );
    });

    describe("KeyVault.GetCertificatePolicy", () => {
      test(
        "reads the certificate's subject",
        Effect.gen(function* () {
          yield* deployerCreate("policy-cert");
          const body = yield* call("GetCertificatePolicy", { certificateName: "policy-cert" });
          expectOk(body);
          expect(body.result.x509_props.subject).toEqual("CN=policy-cert");
        }),
        timeout,
      );
    });

    describe("KeyVault.GetCertificateOperation", () => {
      test(
        "reads a pending operation's status and CSR",
        Effect.gen(function* () {
          const pending = yield* deployerCreate("pending-cert", "Unknown");
          const body = yield* call("GetCertificateOperation", { certificateName: "pending-cert" });
          expectOk(body);
          expect({ status: body.result.status, csr: body.result.csr }).toEqual({
            status: "inProgress",
            csr: pending.csr,
          });
        }),
        timeout,
      );
    });

    describe("KeyVault.CreateCertificate", () => {
      test(
        "starts a self-signed certificate the deployer then reads",
        Effect.gen(function* () {
          const base = yield* vaultBaseUrl;
          const body = yield* call("CreateCertificate", {
            certificateName: "created-cert",
            policy: selfSigned("created-cert"),
          });
          expectOk(body);
          expect(body.result.id).toEqual(`${base}/certificates/created-cert/pending`);
          const status = yield* deployerOperation("created-cert").pipe(
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (op) => op.status !== "inProgress",
              times: 20,
            }),
          );
          expect(status.status).toEqual("completed");
          const cert = yield* deployerGet("created-cert");
          expect(cert.policy?.x509_props?.subject).toEqual("CN=created-cert");
        }),
        timeout,
      );
    });

    describe("KeyVault.ImportCertificate", () => {
      test(
        "imports a PEM certificate with its key",
        Effect.gen(function* () {
          const body = yield* call("ImportCertificate", {
            certificateName: "imported-cert",
            value: IMPORT_PEM,
            policy: { secret_props: { contentType: "application/x-pem-file" } },
          });
          expectOk(body);
          expect(body.result.x5t).toEqual(IMPORT_X5T);
          const cert = yield* deployerGet("imported-cert");
          expect(cert.x5t).toEqual(IMPORT_X5T);
        }),
        timeout,
      );
    });

    describe("KeyVault.MergeCertificate", () => {
      test(
        "merges a CA-signed certificate into a pending one",
        Effect.gen(function* () {
          const pending = yield* deployerCreate("merged-cert", "Unknown");
          const signed = yield* Effect.sync(() => signCsr(pending.csr ?? ""));
          const body = yield* call("MergeCertificate", {
            certificateName: "merged-cert",
            x5c: [signed.x5c],
          });
          expectOk(body);
          expect(body.result.x5t).toEqual(signed.x5t);
          const cert = yield* deployerGet("merged-cert");
          expect(cert.x5t).toEqual(signed.x5t);
        }),
        timeout,
      );
    });

    describe("KeyVault.UpdateCertificate", () => {
      test(
        "tags the latest version",
        Effect.gen(function* () {
          yield* deployerCreate("update-cert");
          const body = yield* call("UpdateCertificate", {
            certificateName: "update-cert",
            certificateVersion: "",
            tags: { stage: "updated" },
          });
          expectOk(body);
          const cert = yield* deployerGet("update-cert");
          expect(cert.tags).toEqual({ stage: "updated" });
        }),
        timeout,
      );
    });

    describe("KeyVault.UpdateCertificatePolicy", () => {
      test(
        "changes the renewal trigger",
        Effect.gen(function* () {
          yield* deployerCreate("update-policy-cert");
          const body = yield* call("UpdateCertificatePolicy", {
            certificateName: "update-policy-cert",
            lifetime_actions: [
              { trigger: { days_before_expiry: 30 }, action: { action_type: "AutoRenew" } },
            ],
          });
          expectOk(body);
          const base = yield* vaultBaseUrl;
          const policy = yield* certificates
            .GetCertificatePolicy({ vaultBaseUrl: base, certificateName: "update-policy-cert" })
            .pipe(Effect.provide(azure));
          expect(policy.lifetime_actions).toEqual([
            { trigger: { days_before_expiry: 30 }, action: { action_type: "AutoRenew" } },
          ]);
        }),
        timeout,
      );
    });

    describe("KeyVault.UpdateCertificateOperation", () => {
      test(
        "requests cancellation of a pending certificate",
        Effect.gen(function* () {
          yield* deployerCreate("cancel-cert", "Unknown");
          const body = yield* call("UpdateCertificateOperation", {
            certificateName: "cancel-cert",
            cancellation_requested: true,
          });
          expectOk(body);
          const operation = yield* deployerOperation("cancel-cert");
          expect(operation.cancellation_requested).toEqual(true);
        }),
        timeout,
      );
    });

    describe("KeyVault.DeleteCertificateOperation", () => {
      test(
        "deletes a pending operation",
        Effect.gen(function* () {
          yield* deployerCreate("abandon-cert", "Unknown");
          const body = yield* call("DeleteCertificateOperation", {
            certificateName: "abandon-cert",
          });
          expectOk(body);
          const base = yield* vaultBaseUrl;
          const gone = yield* outcome(
            certificates.GetCertificateOperation({
              vaultBaseUrl: base,
              certificateName: "abandon-cert",
            }),
            "gone",
          ).pipe(Effect.provide(azure));
          expect(gone).toEqual("PendingCertificateNotFound");
        }),
        timeout,
      );
    });

    describe("KeyVault.DeleteCertificate", () => {
      test(
        "soft-deletes a certificate",
        Effect.gen(function* () {
          yield* deployerCreate("delete-cert");
          const base = yield* vaultBaseUrl;
          const body = yield* call("DeleteCertificate", { certificateName: "delete-cert" });
          expectOk(body);
          expect(body.result.recoveryId).toEqual(`${base}/deletedcertificates/delete-cert`);
          const live = yield* outcome(
            certificates.GetCertificate({ vaultBaseUrl: base, certificateName: "delete-cert" }),
            "gone",
          ).pipe(Effect.provide(azure));
          expect(live).toEqual("CertificateNotFound");
          const deleted = yield* outcome(
            certificates.GetDeletedCertificate({
              vaultBaseUrl: base,
              certificateName: "delete-cert",
            }),
            "found",
          ).pipe(Effect.provide(azure));
          expect(deleted).toEqual("found");
        }),
        timeout,
      );
    });

    describe("KeyVault.GetDeletedCertificate", () => {
      test(
        "reads a deleted certificate's recovery id",
        Effect.gen(function* () {
          yield* deployerCreate("deleted-get-cert");
          const deleted = yield* deployerDelete("deleted-get-cert");
          const body = yield* call("GetDeletedCertificate", {
            certificateName: "deleted-get-cert",
          });
          expectOk(body);
          expect(body.result.recoveryId).toEqual(deleted.recoveryId);
        }),
        timeout,
      );
    });

    describe("KeyVault.GetDeletedCertificates", () => {
      test(
        "lists a deleted certificate",
        Effect.gen(function* () {
          yield* deployerCreate("deleted-list-cert");
          const deleted = yield* deployerDelete("deleted-list-cert");
          const ids = yield* listAll("GetDeletedCertificates", { maxresults: 10 });
          expect(ids).toContain(deleted.recoveryId);
        }),
        timeout,
      );
    });

    describe("KeyVault.RecoverDeletedCertificate", () => {
      test(
        "recovers a deleted certificate",
        Effect.gen(function* () {
          yield* deployerCreate("recover-cert");
          const original = yield* deployerGet("recover-cert");
          yield* deployerDelete("recover-cert");
          const body = yield* call("RecoverDeletedCertificate", {
            certificateName: "recover-cert",
          });
          expectOk(body);
          const base = yield* vaultBaseUrl;
          const back = yield* outcome(
            certificates.GetCertificate({ vaultBaseUrl: base, certificateName: "recover-cert" }),
            "found",
          ).pipe(Effect.provide(azure));
          expect(back).toEqual("found");
          const cert = yield* deployerGet("recover-cert");
          expect(cert.x5t).toEqual(original.x5t);
        }),
        timeout,
      );
    });

    describe("KeyVault.PurgeDeletedCertificate", () => {
      test(
        "permanently deletes a deleted certificate",
        Effect.gen(function* () {
          yield* deployerCreate("purge-cert");
          yield* deployerDelete("purge-cert");
          // "Certificate is currently being deleted." until the soft delete settles.
          const body = yield* call("PurgeDeletedCertificate", { certificateName: "purge-cert" }, [
            "ResourceConflict",
          ]);
          expectOk(body);
          const base = yield* vaultBaseUrl;
          const gone = yield* outcome(
            certificates.GetDeletedCertificate({
              vaultBaseUrl: base,
              certificateName: "purge-cert",
            }),
            "gone",
          ).pipe(Effect.provide(azure));
          expect(gone).toEqual("CertificateNotFound");
        }),
        timeout,
      );
    });

    describe("KeyVault.BackupCertificate", () => {
      test(
        "backs up a certificate the deployer can restore",
        Effect.gen(function* () {
          yield* deployerCreate("backup-cert");
          const original = yield* deployerGet("backup-cert");
          const body = yield* call("BackupCertificate", { certificateName: "backup-cert" });
          expectOk(body);
          expect(body.result.value.length).toBeGreaterThan(1000);
          yield* deployerPurge("backup-cert");
          const base = yield* vaultBaseUrl;
          const restored = yield* certificates
            .RestoreCertificate({ vaultBaseUrl: base, value: body.result.value })
            .pipe(
              // The purged name frees up a moment after the purge.
              Effect.retry({
                while: (e) => e._tag === "ResourceConflict",
                schedule: Schedule.spaced("5 seconds"),
                times: 12,
              }),
              Effect.provide(azure),
            );
          expect(restored.x5t).toEqual(original.x5t);
        }),
        timeout,
      );
    });

    describe("KeyVault.RestoreCertificate", () => {
      test(
        "restores a purged certificate from a backup",
        Effect.gen(function* () {
          yield* deployerCreate("restore-cert");
          const original = yield* deployerGet("restore-cert");
          const base = yield* vaultBaseUrl;
          const backup = yield* asDeployer(
            certificates.BackupCertificate({ vaultBaseUrl: base, certificateName: "restore-cert" }),
          ).pipe(Effect.provide(azure));
          yield* deployerPurge("restore-cert");
          const body = yield* call("RestoreCertificate", { value: backup.value }, [
            "ResourceConflict",
          ]);
          expectOk(body);
          expect(body.result.x5t).toEqual(original.x5t);
          const cert = yield* deployerGet("restore-cert");
          expect(cert.x5t).toEqual(original.x5t);
        }),
        timeout,
      );
    });

    describe("KeyVault.SetCertificateIssuer", () => {
      test(
        "registers an issuer the deployer reads back",
        Effect.gen(function* () {
          const body = yield* call("SetCertificateIssuer", {
            issuerName: "set-issuer",
            provider: "DigiCert",
            credentials: ISSUER_CREDENTIALS,
            org_details: { id: "org-set" },
          });
          expectOk(body);
          const issuer = yield* deployerGetIssuer("set-issuer");
          expect({ provider: issuer.provider, org: issuer.org_details?.id }).toEqual({
            provider: "DigiCert",
            org: "org-set",
          });
        }),
        timeout,
      );
    });

    describe("KeyVault.GetCertificateIssuer", () => {
      test(
        "reads an issuer; a missing issuer is CertificateIssuerNotFound",
        Effect.gen(function* () {
          yield* deployerSetIssuer("get-issuer", "org-get");
          const body = yield* call("GetCertificateIssuer", { issuerName: "get-issuer" });
          expectOk(body);
          expect({ provider: body.result.provider, org: body.result.org_details.id }).toEqual({
            provider: "DigiCert",
            org: "org-get",
          });
          const missing = yield* call("GetCertificateIssuer", { issuerName: "get-issuer-missing" });
          expect(missing.tag).toEqual("CertificateIssuerNotFound");
        }),
        timeout,
      );
    });

    describe("KeyVault.GetCertificateIssuers", () => {
      test(
        "lists an issuer",
        Effect.gen(function* () {
          yield* deployerSetIssuer("list-issuer", "org-list");
          const base = yield* vaultBaseUrl;
          const ids = yield* listAll("GetCertificateIssuers");
          expect(ids).toContain(`${base}/certificates/issuers/list-issuer`);
        }),
        timeout,
      );
    });

    describe("KeyVault.UpdateCertificateIssuer", () => {
      test(
        "changes an issuer's organization",
        Effect.gen(function* () {
          yield* deployerSetIssuer("update-issuer", "org-before");
          const body = yield* call("UpdateCertificateIssuer", {
            issuerName: "update-issuer",
            org_details: { id: "org-after" },
          });
          expectOk(body);
          const issuer = yield* deployerGetIssuer("update-issuer");
          expect(issuer.org_details?.id).toEqual("org-after");
        }),
        timeout,
      );
    });

    describe("KeyVault.DeleteCertificateIssuer", () => {
      test(
        "deletes an issuer",
        Effect.gen(function* () {
          yield* deployerSetIssuer("delete-issuer", "org-delete");
          const body = yield* call("DeleteCertificateIssuer", { issuerName: "delete-issuer" });
          expectOk(body);
          const gone = yield* outcome(deployerGetIssuer("delete-issuer"), "gone");
          expect(gone).toEqual("CertificateIssuerNotFound");
        }),
        timeout,
      );
    });

    // The contacts are one object per vault: these run one at a time.
    describe.sequential("certificate contacts", () => {
      describe("KeyVault.SetCertificateContacts", () => {
        test(
          "replaces the vault's contacts",
          Effect.gen(function* () {
            const body = yield* call("SetCertificateContacts", {
              contacts: [{ email: "set@example.com", name: "Set" }],
            });
            expectOk(body);
            const contacts = yield* deployerContacts;
            expect(contacts.contacts).toEqual([{ email: "set@example.com", name: "Set" }]);
          }),
          timeout,
        );
      });

      describe("KeyVault.GetCertificateContacts", () => {
        test(
          "reads the vault's contacts",
          Effect.gen(function* () {
            const base = yield* vaultBaseUrl;
            yield* asDeployer(
              certificates.SetCertificateContacts({
                vaultBaseUrl: base,
                contacts: [{ email: "get@example.com", name: "Get" }],
              }),
            ).pipe(Effect.provide(azure));
            const body = yield* call("GetCertificateContacts");
            expectOk(body);
            expect(body.result.contacts).toEqual([{ email: "get@example.com", name: "Get" }]);
          }),
          timeout,
        );
      });

      describe("KeyVault.DeleteCertificateContacts", () => {
        test(
          "clears the vault's contacts",
          Effect.gen(function* () {
            const base = yield* vaultBaseUrl;
            yield* asDeployer(
              certificates.SetCertificateContacts({
                vaultBaseUrl: base,
                contacts: [{ email: "delete@example.com" }],
              }),
            ).pipe(Effect.provide(azure));
            const body = yield* call("DeleteCertificateContacts");
            expectOk(body);
            const gone = yield* outcome(deployerContacts, "gone");
            expect(gone).toEqual("CertificateContactsNotFound");
          }),
          timeout,
        );
      });
    });

    describe("KeyVault.CertificateRead", () => {
      test(
        "gets, reads the policy and operation, lists versions and certificates",
        Effect.gen(function* () {
          yield* deployerCreate("read-cert");
          const expected = yield* deployerGet("read-cert");
          const base = yield* vaultBaseUrl;
          const body = yield* call("CertificateRead.all", { name: "read-cert" });
          expectOk(body);
          expect({
            x5t: body.result.x5t,
            missing: body.result.missing,
            subject: body.result.subject,
            status: body.result.status,
            versions: body.result.versions,
          }).toEqual({
            x5t: expected.x5t,
            missing: true,
            subject: "CN=read-cert",
            status: "completed",
            versions: [expected.id],
          });
        }),
        timeout,
      );
    });

    describe("KeyVault.CertificateWrite", () => {
      test(
        "creates, imports, updates, and deletes certificates",
        Effect.gen(function* () {
          const base = yield* vaultBaseUrl;
          const created = yield* call("CertificateWrite.create", { name: "write-cert" });
          expectOk(created);
          const operation = yield* deployerOperation("write-cert").pipe(
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (op) => op.status !== "inProgress",
              times: 20,
            }),
          );
          expect(operation.status).toEqual("completed");

          const imported = yield* call("CertificateWrite.import", {
            name: "write-import-cert",
            pem: IMPORT_PEM,
          });
          expectOk(imported);
          expect(imported.result).toEqual(IMPORT_X5T);
          const importedCert = yield* deployerGet("write-import-cert");
          expect(importedCert.x5t).toEqual(IMPORT_X5T);

          const updated = yield* call("CertificateWrite.update", { name: "write-cert" });
          expectOk(updated);
          const cert = yield* deployerGet("write-cert");
          expect({
            tags: cert.tags,
            lifetimeActions: cert.policy?.lifetime_actions,
          }).toEqual({
            tags: { writtenBy: "CertificateWrite" },
            lifetimeActions: [
              { trigger: { days_before_expiry: 20 }, action: { action_type: "AutoRenew" } },
            ],
          });

          const deleted = yield* call("CertificateWrite.delete", { name: "write-cert" });
          expectOk(deleted);
          expect(deleted.result).toEqual({
            recoveryId: `${base}/deletedcertificates/write-cert`,
            missing: true,
          });
          const live = yield* outcome(
            certificates.GetCertificate({ vaultBaseUrl: base, certificateName: "write-cert" }),
            "gone",
          ).pipe(Effect.provide(azure));
          expect(live).toEqual("CertificateNotFound");
        }),
        timeout,
      );
    });

    describe("KeyVault.CertificateReadWrite", () => {
      test(
        "creates a certificate and reads it back",
        Effect.gen(function* () {
          const body = yield* call("CertificateReadWrite.roundtrip", { name: "rw-cert" });
          expectOk(body);
          expect(body.result.status).toEqual("completed");
          const cert = yield* deployerGet("rw-cert");
          expect(body.result.x5t).toEqual(cert.x5t);
        }),
        timeout,
      );
    });
  },
);
