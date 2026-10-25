import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { distilledFromSource } from "./distilled-source.ts";

/**
 * The HSM's initial administrator. The test sets it to the deployer's object
 * ID before deploying, so it can activate the HSM between the two deploys.
 */
export const hsmAdmin = { objectId: "" };

/** The bound HSM. Its props are read when it is deployed. */
export const Hsm = Azure.KeyVault.ManagedHsm(
  "BindingsHsm",
  Effect.sync(() => ({
    initialAdminObjectIds: [hsmAdmin.objectId],
    softDeleteRetentionInDays: 7,
  })),
);

const text = (body: string, status = 200) => HttpServerResponse.text(body, { status });

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/**
 * Effect-native Azure Function that binds every Managed HSM administration
 * and security-domain binding to {@link Hsm}, with one route per runtime
 * behaviour under test. Backup, restore, setting updates and security
 * domain upload/download are bound (their grants are checked out of band)
 * but not called: they need a storage container or change the HSM.
 */
export default class ManagedHsmFunction extends Azure.Functions.Function<ManagedHsmFunction>()(
  "ManagedHsmFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const hsm = yield* Hsm;
    const KV = Azure.KeyVault;
    yield* KV.StartFullBackup(hsm);
    yield* KV.GetFullBackupStatus(hsm);
    yield* KV.CheckFullBackup(hsm);
    yield* KV.StartFullRestore(hsm);
    yield* KV.CheckFullRestore(hsm);
    yield* KV.GetFullRestoreStatus(hsm);
    yield* KV.StartSelectiveKeyRestore(hsm);
    yield* KV.GetSelectiveKeyRestoreStatus(hsm);
    yield* KV.UpdateHsmSetting(hsm);
    yield* KV.DownloadSecurityDomain(hsm);
    yield* KV.UploadSecurityDomain(hsm);
    yield* KV.GetSecurityDomainUploadStatus(hsm);
    const listSettings = yield* KV.ListHsmSettings(hsm);
    const getSetting = yield* KV.GetHsmSetting(hsm);
    const listAssignments = yield* KV.ListHsmRoleAssignments(hsm);
    const getAssignment = yield* KV.GetHsmRoleAssignment(hsm);
    const createAssignment = yield* KV.CreateHsmRoleAssignment(hsm);
    const deleteAssignment = yield* KV.DeleteHsmRoleAssignment(hsm);
    const listRoles = yield* KV.ListHsmRoleDefinitions(hsm);
    const getRole = yield* KV.GetHsmRoleDefinition(hsm);
    const putRole = yield* KV.PutHsmRoleDefinition(hsm);
    const deleteRole = yield* KV.DeleteHsmRoleDefinition(hsm);
    const downloadStatus = yield* KV.GetSecurityDomainDownloadStatus(hsm);
    const transferKey = yield* KV.GetSecurityDomainTransferKey(hsm);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const param = (name: string) => url.searchParams.get(name) ?? "";
        switch (url.pathname) {
          case "/settings":
            return yield* respond(
              Effect.map(listSettings(), (r) => (r.settings ?? []).map((s) => s.name)),
            );
          case "/setting":
            return yield* respond(getSetting({ settingName: param("name") }));
          case "/roles":
            return yield* respond(
              Effect.map(listRoles({ scope: "/" }), (roles) => roles.map((r) => r.name)),
            );
          case "/role":
            return yield* respond(getRole({ scope: "/", roleDefinitionName: param("name") }));
          case "/role/put":
            return yield* respond(
              putRole({
                scope: "/",
                roleDefinitionName: param("name"),
                properties: {
                  roleName: param("roleName"),
                  type: "CustomRole",
                  permissions: [
                    { dataActions: ["Microsoft.KeyVault/managedHsm/keys/read/action"] },
                  ],
                  assignableScopes: ["/"],
                },
              }),
            );
          case "/role/delete":
            return yield* respond(deleteRole({ scope: "/", roleDefinitionName: param("name") }));
          case "/assignments":
            return yield* respond(
              Effect.map(listAssignments({ scope: "/" }), (all) => all.map((a) => a.name)),
            );
          case "/assignment":
            return yield* respond(
              getAssignment({ scope: "/keys", roleAssignmentName: param("name") }),
            );
          case "/assignment/create":
            return yield* respond(
              createAssignment({
                scope: "/keys",
                roleAssignmentName: param("name"),
                properties: { roleDefinitionId: param("role"), principalId: param("principal") },
              }),
            );
          case "/assignment/delete":
            return yield* respond(
              deleteAssignment({ scope: "/keys", roleAssignmentName: param("name") }),
            );
          case "/security-domain/download-status":
            return yield* respond(downloadStatus());
          case "/security-domain/transfer-key":
            return yield* respond(Effect.map(transferKey(), (k) => k.transfer_key.kty));
          default:
            return text("not found", 404);
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.KeyVault.StartFullBackupHttp,
        Azure.KeyVault.GetFullBackupStatusHttp,
        Azure.KeyVault.CheckFullBackupHttp,
        Azure.KeyVault.StartFullRestoreHttp,
        Azure.KeyVault.CheckFullRestoreHttp,
        Azure.KeyVault.GetFullRestoreStatusHttp,
        Azure.KeyVault.StartSelectiveKeyRestoreHttp,
        Azure.KeyVault.GetSelectiveKeyRestoreStatusHttp,
        Azure.KeyVault.ListHsmSettingsHttp,
        Azure.KeyVault.GetHsmSettingHttp,
        Azure.KeyVault.UpdateHsmSettingHttp,
        Azure.KeyVault.ListHsmRoleAssignmentsHttp,
        Azure.KeyVault.GetHsmRoleAssignmentHttp,
        Azure.KeyVault.CreateHsmRoleAssignmentHttp,
        Azure.KeyVault.DeleteHsmRoleAssignmentHttp,
        Azure.KeyVault.ListHsmRoleDefinitionsHttp,
        Azure.KeyVault.GetHsmRoleDefinitionHttp,
        Azure.KeyVault.PutHsmRoleDefinitionHttp,
        Azure.KeyVault.DeleteHsmRoleDefinitionHttp,
        Azure.KeyVault.DownloadSecurityDomainHttp,
        Azure.KeyVault.GetSecurityDomainDownloadStatusHttp,
        Azure.KeyVault.GetSecurityDomainTransferKeyHttp,
        Azure.KeyVault.UploadSecurityDomainHttp,
        Azure.KeyVault.GetSecurityDomainUploadStatusHttp,
      ),
    ),
  ),
) {}
