import * as Azure from "@alchemy.run/azure";
import { Credentials } from "@distilled.cloud/azure";
import * as keyvault from "@distilled.cloud/azure/keyvault";
import * as admin from "@distilled.cloud/azure/keyvault-administration";
import * as securityDomain from "@distilled.cloud/azure/keyvault-security-domain";
import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { runExpensive } from "../gates.ts";
import { activateHsm, deployerObjectId } from "./fixtures/activate-hsm.ts";
import ManagedHsmFunction, { Hsm, hsmAdmin } from "./fixtures/managed-hsm-function.ts";
import { SECURITY_DOMAIN_KEYS } from "./fixtures/security-domain-keys.ts";

const { test } = Test.make({ providers: Azure.providers() });

const HSM_URL = "https://alchemyhsm.managedhsm.azure.net";

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly audience: string | undefined;
  readonly body: string | undefined;
}

/**
 * Credentials and an HTTP client that answer every request with `reply`
 * and record what was sent, including the token audience asked for.
 */
const recordingAzure = (sent: Sent[], reply: () => Response) => {
  let audience: string | undefined;
  return Layer.mergeAll(
    Layer.succeed(
      Credentials,
      Effect.succeed({
        bearerToken: Redacted.make("arm-token"),
        subscriptionId: "",
        apiBaseUrl: "https://management.azure.com",
        tokenFor: (scope: string) =>
          Effect.sync(() => {
            audience = scope;
            return Redacted.make("data-plane-token");
          }),
      }),
    ),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request, url) =>
        Effect.sync(() => {
          sent.push({
            method: request.method,
            url: url.href,
            audience,
            body:
              request.body._tag === "Uint8Array"
                ? new TextDecoder().decode(request.body.body)
                : undefined,
          });
          return HttpClientResponse.fromWeb(request, reply());
        }),
      ),
    ),
  );
};

const accepted = (body: unknown) =>
  Response.json(body, {
    status: 202,
    headers: { "Azure-AsyncOperation": `${HSM_URL}/backup/job-1/pending`, "Retry-After": "10" },
  });

describe("Managed HSM data plane encoding", { tags: ["provider:azure"] }, () => {
  test(
    "FullBackup asks for a Managed HSM token and decodes the 202 job body",
    Effect.gen(function* () {
      const sent: Sent[] = [];
      const job = yield* admin
        .FullBackup({
          vaultBaseUrl: HSM_URL,
          storageResourceUri: "https://account.blob.core.windows.net/backups",
          useManagedIdentity: true,
        })
        .pipe(
          Effect.provide(
            recordingAzure(sent, () =>
              accepted({ status: "InProgress", jobId: "job-1", startTime: 1761350400 }),
            ),
          ),
        );
      expect(job).toEqual({
        azureAsyncOperation: `${HSM_URL}/backup/job-1/pending`,
        retryAfter: 10,
        status: "InProgress",
        jobId: "job-1",
        startTime: 1761350400,
      });
      expect(sent.map(({ method, url, audience }) => ({ method, url, audience }))).toEqual([
        {
          method: "POST",
          url: `${HSM_URL}/backup?api-version=2026-04-01`,
          audience: "https://managedhsm.azure.net/.default",
        },
      ]);
      expect(JSON.parse(sent[0]!.body!)).toEqual({
        storageResourceUri: "https://account.blob.core.windows.net/backups",
        useManagedIdentity: true,
      });
    }),
  );

  test(
    "selective key restore decodes the 202 job body",
    Effect.gen(function* () {
      const sent: Sent[] = [];
      const job = yield* admin
        .SelectiveKeyRestoreOperation({
          vaultBaseUrl: HSM_URL,
          keyName: "payments",
          folder: "mhsm-alchemyhsm-2026102412345678",
          sasTokenParameters: {
            storageResourceUri: "https://account.blob.core.windows.net/backups",
            useManagedIdentity: true,
          },
        })
        .pipe(
          Effect.provide(
            recordingAzure(sent, () => accepted({ status: "InProgress", jobId: "k-1" })),
          ),
        );
      expect({ status: job.status, jobId: job.jobId }).toEqual({
        status: "InProgress",
        jobId: "k-1",
      });
      expect(sent[0]!.url).toEqual(`${HSM_URL}/keys/payments/restore?api-version=2026-04-01`);
    }),
  );

  test(
    "security domain download sends the JWKs and returns the encrypted domain",
    Effect.gen(function* () {
      const sent: Sent[] = [];
      const downloaded = yield* securityDomain
        .DownloadHSMSecurityDomain({
          vaultBaseUrl: HSM_URL,
          certificates: SECURITY_DOMAIN_KEYS,
          required: 2,
        })
        .pipe(Effect.provide(recordingAzure(sent, () => accepted({ value: "encrypted-domain" }))));
      expect(downloaded.value).toEqual("encrypted-domain");
      expect(sent[0]!.audience).toEqual("https://managedhsm.azure.net/.default");
      expect(sent[0]!.url).toEqual(`${HSM_URL}/securitydomain/download?api-version=2026-04-01`);
      const body = JSON.parse(sent[0]!.body!) as {
        required: number;
        certificates: Array<Record<string, unknown>>;
      };
      expect(body.required).toEqual(2);
      expect(body.certificates.map((c) => Object.keys(c).sort())).toEqual(
        SECURITY_DOMAIN_KEYS.map(() =>
          ["alg", "e", "key_ops", "kid", "kty", "n", "use", "x5c", "x5t#S256"].sort(),
        ),
      );
    }),
  );

  test(
    "security domain upload decodes the 202 status body",
    Effect.gen(function* () {
      const sent: Sent[] = [];
      const uploaded = yield* securityDomain
        .UploadHSMSecurityDomain({ vaultBaseUrl: HSM_URL, value: "restore-blob" })
        .pipe(Effect.provide(recordingAzure(sent, () => accepted({ status: "InProgress" }))));
      expect(uploaded.status).toEqual("InProgress");
      expect(sent[0]!.audience).toEqual("https://managedhsm.azure.net/.default");
    }),
  );

  test(
    "role assignment and settings requests address the HSM",
    Effect.gen(function* () {
      const sent: Sent[] = [];
      const layer = recordingAzure(sent, () =>
        Response.json({
          settings: [
            { name: "AllowKeyManagementOperationsThroughARM", value: "false", type: "boolean" },
          ],
        }),
      );
      const settings = yield* admin
        .GetSettings({ vaultBaseUrl: HSM_URL })
        .pipe(Effect.provide(layer));
      expect(settings.settings?.map((s) => s.name)).toEqual([
        "AllowKeyManagementOperationsThroughARM",
      ]);
      yield* admin
        .GetRoleAssignment({ vaultBaseUrl: HSM_URL, scope: "/keys", roleAssignmentName: "a-1" })
        .pipe(Effect.provide(layer));
      expect(sent.map((s) => s.url)).toEqual([
        `${HSM_URL}/settings?api-version=2026-04-01`,
        `${HSM_URL}/keys/providers/Microsoft.Authorization/roleAssignments/a-1?api-version=2026-04-01`,
      ]);
      expect(sent.map((s) => s.audience)).toEqual([
        "https://managedhsm.azure.net/.default",
        "https://managedhsm.azure.net/.default",
      ]);
    }),
  );
});

/** Custom HSM roles assigned to `principalId`, as sorted data-action lists. */
const grantedDataActions = (hsmName: string, principalId: string) =>
  Effect.gen(function* () {
    const vaultBaseUrl = `https://${hsmName}.managedhsm.azure.net`;
    const assignments = Array.from(
      yield* Stream.runCollect(
        admin.ListRoleAssignmentForScope.items({
          vaultBaseUrl,
          scope: "/",
          _filter: `principalId eq '${principalId}'`,
        }),
      ),
    );
    const roles: string[] = [];
    for (const assignment of assignments) {
      const roleName = assignment.properties?.roleDefinitionId?.split("/").pop() ?? "";
      const role = yield* admin.GetRoleDefinition({
        vaultBaseUrl,
        scope: "/",
        roleDefinitionName: roleName,
      });
      roles.push(
        role.properties?.type === "CustomRole"
          ? (role.properties.permissions ?? [])
              .flatMap((p) => p.dataActions ?? [])
              .sort()
              .join(",")
          : `builtin:${roleName}`,
      );
    }
    return roles.sort();
  });

type Body = { ok: boolean; result?: any; error?: string };

const hsmPurged = (location: string, name: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* keyvault.GetManagedHsmDeleted({ subscriptionId, location, name }).pipe(
      Effect.as("found" as const),
      Effect.catchTag(["ResourceNotFound", "NotFound"], () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("15 seconds"),
        until: (status) => status === "gone",
        times: 40,
      }),
    );
  });

const base = Effect.gen(function* () {
  const hsm = yield* Hsm;
  return { hsm };
});

const full = Effect.gen(function* () {
  const hsm = yield* Hsm;
  const fn = yield* ManagedHsmFunction;
  return { hsm, url: fn.url, principalId: fn.principalId };
});

// ~$3/run, ~45 min: Managed HSM Standard_B1 is billed ~$3.20/hour until
// deleted and purged; provisioning takes 20-30 minutes.
test.provider.skipIf(!runExpensive)(
  "Managed HSM bindings on an Azure Function",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      hsmAdmin.objectId = yield* deployerObjectId;

      // 1. The HSM alone, then activate it: local RBAC (every binding's grant)
      //    only exists on an activated HSM.
      const { hsm } = yield* stack.deploy(base);
      const vaultBaseUrl = `https://${hsm.managedHsmName}.managedhsm.azure.net`;
      yield* activateHsm(hsm.managedHsmName);

      // 2. The Function with every binding.
      const out = yield* stack.deploy(full);
      const principalId = out.principalId!;

      // Every binding granted its exact local role to the Function.
      expect(yield* grantedDataActions(hsm.managedHsmName, principalId)).toEqual(
        [
          "Microsoft.KeyVault/managedHsm/backup/start/action",
          "Microsoft.KeyVault/managedHsm/backup/start/action",
          "Microsoft.KeyVault/managedHsm/backup/status/action",
          "Microsoft.KeyVault/managedHsm/restore/start/action",
          "Microsoft.KeyVault/managedHsm/restore/start/action",
          "Microsoft.KeyVault/managedHsm/restore/start/action",
          "Microsoft.KeyVault/managedHsm/restore/status/action",
          "Microsoft.KeyVault/managedHsm/restore/status/action",
          "Microsoft.KeyVault/managedHsm/roleAssignments/delete/action",
          "Microsoft.KeyVault/managedHsm/roleAssignments/read/action",
          "Microsoft.KeyVault/managedHsm/roleAssignments/read/action",
          "Microsoft.KeyVault/managedHsm/roleAssignments/write/action",
          "Microsoft.KeyVault/managedHsm/roleDefinitions/delete/action",
          "Microsoft.KeyVault/managedHsm/roleDefinitions/read/action",
          "Microsoft.KeyVault/managedHsm/roleDefinitions/read/action",
          "Microsoft.KeyVault/managedHsm/roleDefinitions/write/action",
          "Microsoft.KeyVault/managedHsm/securitydomain/download/action",
          "Microsoft.KeyVault/managedHsm/securitydomain/download/read",
          "Microsoft.KeyVault/managedHsm/securitydomain/transferkey/read",
          "Microsoft.KeyVault/managedHsm/securitydomain/upload/action",
          "Microsoft.KeyVault/managedHsm/securitydomain/upload/read",
          `builtin:${Azure.KeyVault.ManagedHsmBuiltInRole.Administrator}`,
          `builtin:${Azure.KeyVault.ManagedHsmBuiltInRole.Administrator}`,
          `builtin:${Azure.KeyVault.ManagedHsmBuiltInRole.Administrator}`,
        ].sort(),
      );

      /** Call a route until it answers `ok` (cold start, role propagation). */
      const call = (route: string) =>
        HttpClient.get(`${out.url}${route}`).pipe(
          Effect.timeout("60 seconds"),
          Effect.flatMap((response) => response.json),
          Effect.map((body) => body as Body),
          Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 40 }),
          Effect.catch((body) => Effect.succeed(body as Body)),
        );
      const ok = (body: Body) => {
        expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });
        return body.result;
      };

      // ListHsmSettings + GetHsmSetting
      const settings = ok(yield* call("/settings")) as string[];
      expect(settings).toContain("AllowKeyManagementOperationsThroughARM");
      const setting = ok(yield* call("/setting?name=AllowKeyManagementOperationsThroughARM"));
      expect(setting.name).toEqual("AllowKeyManagementOperationsThroughARM");

      // ListHsmRoleDefinitions + GetHsmRoleDefinition
      const cryptoUser = Azure.KeyVault.ManagedHsmBuiltInRole.CryptoUser;
      expect(ok(yield* call("/roles")) as string[]).toContain(cryptoUser);
      expect(ok(yield* call(`/role?name=${cryptoUser}`)).name).toEqual(cryptoUser);

      // PutHsmRoleDefinition + DeleteHsmRoleDefinition, verified by the deployer.
      const customRole = "6c7f4a1e-0d2b-4f3a-9b8e-5a1c2d3e4f50";
      ok(yield* call(`/role/put?name=${customRole}&roleName=AlchemyBindingsTestReader`));
      const put = yield* admin.GetRoleDefinition({
        vaultBaseUrl,
        scope: "/",
        roleDefinitionName: customRole,
      });
      expect(put.properties?.roleName).toEqual("AlchemyBindingsTestReader");
      ok(yield* call(`/role/delete?name=${customRole}`));
      const afterDelete = yield* admin
        .GetRoleDefinition({ vaultBaseUrl, scope: "/", roleDefinitionName: customRole })
        .pipe(
          Effect.as("found" as const),
          Effect.catchTag(["RoleDefinitionNotFound", "NotFound"], () =>
            Effect.succeed("gone" as const),
          ),
        );
      expect(afterDelete).toEqual("gone");

      // CreateHsmRoleAssignment + GetHsmRoleAssignment + ListHsmRoleAssignments
      // + DeleteHsmRoleAssignment: grant the Function itself Crypto Auditor on /keys.
      const assignment = "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0";
      const auditor = `Microsoft.KeyVault/providers/Microsoft.Authorization/roleDefinitions/${Azure.KeyVault.ManagedHsmBuiltInRole.CryptoAuditor}`;
      ok(
        yield* call(
          `/assignment/create?name=${assignment}&role=${auditor}&principal=${principalId}`,
        ),
      );
      const created = yield* admin.GetRoleAssignment({
        vaultBaseUrl,
        scope: "/keys",
        roleAssignmentName: assignment,
      });
      expect(created.properties?.principalId).toEqual(principalId);
      expect(ok(yield* call(`/assignment?name=${assignment}`)).name).toEqual(assignment);
      expect(ok(yield* call("/assignments")) as string[]).toContain(assignment);
      ok(yield* call(`/assignment/delete?name=${assignment}`));
      const assignmentGone = yield* admin
        .GetRoleAssignment({ vaultBaseUrl, scope: "/keys", roleAssignmentName: assignment })
        .pipe(
          Effect.as("found" as const),
          Effect.catchTag(["RoleAssignmentNotFound", "NotFound"], () =>
            Effect.succeed("gone" as const),
          ),
        );
      expect(assignmentGone).toEqual("gone");

      // GetSecurityDomainDownloadStatus + GetSecurityDomainTransferKey
      expect(ok(yield* call("/security-domain/download-status")).status).toEqual("Success");
      expect(ok(yield* call("/security-domain/transfer-key"))).toEqual("RSA");

      yield* stack.destroy();
      expect(yield* hsmPurged(hsm.location, hsm.managedHsmName)).toEqual("gone");
    }),
  {
    tags: ["provider:azure", "provider:azure:keyvault", "live"],
    timeout: 7_200_000,
  },
);
