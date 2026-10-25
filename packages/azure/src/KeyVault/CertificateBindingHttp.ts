import * as certificates from "@distilled.cloud/azure/keyvault-certificates";
import type { Input } from "alchemy/Input";
import * as Effect from "effect/Effect";
import { RoleDefinition } from "../Authorization/RoleDefinition.ts";
import * as AzureBindings from "../AzureBindings.ts";
import type {
  CertificateListOptions,
  CertificateVersionsOptions,
  ReadCertificatesClient,
} from "./CertificateRead.ts";
import type { VaultCertificateRequest } from "./CertificateTypes.ts";
import type {
  CertificateCreateOptions,
  CertificateImportOptions,
  CertificatePolicyUpdate,
  CertificateUpdateOptions,
  WriteCertificatesClient,
} from "./CertificateWrite.ts";
import type { Vault } from "./Vault.ts";

/**
 * Shared scaffolding for the Key Vault certificate bindings
 * (`keyvault-certificates` data plane). Every `{Op}Http.ts` is a thin
 * `Layer.effect(Cap, makeVaultCertificateBinding({ … }))`; only the
 * operation and its role differ. Certificates are not ARM resources, so
 * every binding is bound to the vault and assigns its role on the vault.
 *
 * NOT exported from `index.ts`.
 */

const CERTIFICATES = "Microsoft.KeyVault/vaults/certificates";
const ISSUERS = "Microsoft.KeyVault/vaults/certificatecas";
const CONTACTS = "Microsoft.KeyVault/vaults/certificatecontacts";

/**
 * A custom role a certificate binding assigns: one role definition per
 * data-action set (logical ID `AzureKeyVaultCertificates<name>Role`, defined
 * once per stack at the subscription, shared by every host) holding only
 * those data actions. No built-in role is that narrow: **Key Vault
 * Certificate User** also reads secret values and keys, and **Key Vault
 * Certificates Officer** grants every certificate action.
 */
export interface CertificateRole {
  /** Logical ID of the custom role definition. */
  readonly id: string;
  /** Data actions the role grants. */
  readonly dataActions: readonly string[];
}

const custom = (name: string, ...dataActions: string[]): CertificateRole => ({
  id: `AzureKeyVaultCertificates${name}Role`,
  dataActions,
});

/** The roles of the certificate bindings, by data-action set. */
export const CertificateRoles = {
  /** Get a certificate, its policy, versions, pending operation, or a deleted certificate; list them. */
  Read: custom("Read", `${CERTIFICATES}/read`),
  /** Create a certificate version, merge a signed certificate into a pending one. */
  Create: custom("Create", `${CERTIFICATES}/create/action`),
  Import: custom("Import", `${CERTIFICATES}/import/action`),
  /** Update attributes, tags, policy, or the pending operation (cancel or delete it). */
  Update: custom("Update", `${CERTIFICATES}/update/action`),
  Delete: custom("Delete", `${CERTIFICATES}/delete`),
  Backup: custom("Backup", `${CERTIFICATES}/backup/action`),
  Restore: custom("Restore", `${CERTIFICATES}/restore/action`),
  Recover: custom("Recover", `${CERTIFICATES}/recover/action`),
  Purge: custom("Purge", `${CERTIFICATES}/purge/action`),
  ReadIssuers: custom("ReadIssuers", `${ISSUERS}/read`),
  WriteIssuers: custom("WriteIssuers", `${ISSUERS}/write`),
  DeleteIssuers: custom("DeleteIssuers", `${ISSUERS}/delete`),
  /** Key Vault has one data action for reading, setting, and deleting contacts. */
  ManageContacts: custom("ManageContacts", `${CONTACTS}/write`),
} satisfies Record<string, CertificateRole>;

type Grant = (tag: string, vault: Vault, roles: readonly CertificateRole[]) => Effect.Effect<void>;

/**
 * Deploy-time grant: defines each custom role (once per stack) and assigns
 * all of them on the vault to the host in one binding.
 */
const CertificateGrants: Effect.Effect<Grant> = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // Bindings only bind at deploy, so a host bundle drops the role definitions.
  if (globalThis.__ALCHEMY_RUNTIME__) return () => Effect.void;
  const AzureRoleDefinition = yield* RoleDefinition;
  return Effect.fn(function* (tag: string, vault: Vault, roles: readonly CertificateRole[]) {
    const roleAssignments: Input<AzureBindings.HostRoleAssignment>[] = [];
    for (const role of new Set(roles)) {
      const definition = yield* AzureRoleDefinition(role.id, {
        description: `Alchemy Key Vault certificate binding: ${role.dataActions.join(", ")}`,
        permissions: [{ dataActions: [...role.dataActions] }],
      });
      roleAssignments.push({ roleDefinitionId: definition.roleDefinitionId, scope: vault.vaultId });
    }
    yield* bind`${tag}(${vault})`({ roleAssignments });
  });
});

/** The bound vault's data-plane endpoint, resolved at runtime. */
const vaultBaseUrlOf = (vault: Vault) => vault.vaultUri;

/**
 * Build the impl Effect of a certificate operation (`GetCertificate`,
 * `CreateCertificate`, `SetCertificateIssuer`, …): the runtime callable
 * injects the bound {@link Vault}'s URL; the deploy-time half assigns
 * `role` on the vault.
 */
export const makeVaultCertificateBinding = <I extends { vaultBaseUrl: string }, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.KeyVault.GetCertificate`. */
  tag: string;
  /** The distilled `keyvault-certificates` operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** Role assigned on the vault. */
  role: CertificateRole;
}) =>
  Effect.gen(function* () {
    const grant = yield* CertificateGrants;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (vault: Vault) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* grant(options.tag, vault, [options.role]);
      }
      const vaultBaseUrl = yield* vaultBaseUrlOf(vault);
      return Effect.fn(`${options.tag}(${vault.LogicalId})`)(function* (
        request?: VaultCertificateRequest<I>,
      ) {
        const base = yield* vaultBaseUrl;
        // TS cannot prove `Omit<I, "vaultBaseUrl"> & { vaultBaseUrl }` is `I` for a generic `I`.
        return yield* op({ ...request, vaultBaseUrl: base } as I);
      });
    });
  });

/** Where the Read/Write clients send their calls. */
export interface CertificateAddress {
  readonly tag: string;
  readonly vaultBaseUrl: Effect.Effect<string>;
}

export const makeReadCertificatesClient = Effect.gen(function* () {
  const getCertificate = yield* AzureBindings.withCredentials(certificates.GetCertificate);
  const getPolicy = yield* AzureBindings.withCredentials(certificates.GetCertificatePolicy);
  const getOperation = yield* AzureBindings.withCredentials(certificates.GetCertificateOperation);
  const getCertificates = yield* AzureBindings.withCredentials(certificates.GetCertificates);
  const getVersions = yield* AzureBindings.withCredentials(certificates.GetCertificateVersions);
  return (address: CertificateAddress): ReadCertificatesClient => ({
    get: Effect.fn(`${address.tag}.get`)(function* (certificateName: string, version?: string) {
      const vaultBaseUrl = yield* address.vaultBaseUrl;
      return yield* getCertificate({
        vaultBaseUrl,
        certificateName,
        certificateVersion: version ?? "",
      }).pipe(Effect.catchTag("CertificateNotFound", () => Effect.succeed(undefined)));
    }),
    policy: Effect.fn(`${address.tag}.policy`)(function* (certificateName: string) {
      const vaultBaseUrl = yield* address.vaultBaseUrl;
      return yield* getPolicy({ vaultBaseUrl, certificateName }).pipe(
        Effect.catchTag("CertificateNotFound", () => Effect.succeed(undefined)),
      );
    }),
    operation: Effect.fn(`${address.tag}.operation`)(function* (certificateName: string) {
      const vaultBaseUrl = yield* address.vaultBaseUrl;
      return yield* getOperation({ vaultBaseUrl, certificateName }).pipe(
        Effect.catchTag(["PendingCertificateNotFound", "CertificateNotFound"], () =>
          Effect.succeed(undefined),
        ),
      );
    }),
    list: Effect.fn(`${address.tag}.list`)(function* (options?: CertificateListOptions) {
      const vaultBaseUrl = yield* address.vaultBaseUrl;
      return yield* getCertificates({ ...options, vaultBaseUrl });
    }),
    versions: Effect.fn(`${address.tag}.versions`)(function* (
      certificateName: string,
      options?: CertificateVersionsOptions,
    ) {
      const vaultBaseUrl = yield* address.vaultBaseUrl;
      return yield* getVersions({ ...options, vaultBaseUrl, certificateName });
    }),
  });
});

export const makeWriteCertificatesClient = Effect.gen(function* () {
  const create = yield* AzureBindings.withCredentials(certificates.CreateCertificate);
  const importCertificate = yield* AzureBindings.withCredentials(certificates.ImportCertificate);
  const update = yield* AzureBindings.withCredentials(certificates.UpdateCertificate);
  const updatePolicy = yield* AzureBindings.withCredentials(certificates.UpdateCertificatePolicy);
  const remove = yield* AzureBindings.withCredentials(certificates.DeleteCertificate);
  return (address: CertificateAddress): WriteCertificatesClient => ({
    create: Effect.fn(`${address.tag}.create`)(function* (
      certificateName: string,
      options?: CertificateCreateOptions,
    ) {
      const vaultBaseUrl = yield* address.vaultBaseUrl;
      return yield* create({ ...options, vaultBaseUrl, certificateName });
    }),
    import: Effect.fn(`${address.tag}.import`)(function* (
      certificateName: string,
      options: CertificateImportOptions,
    ) {
      const vaultBaseUrl = yield* address.vaultBaseUrl;
      return yield* importCertificate({ ...options, vaultBaseUrl, certificateName });
    }),
    update: Effect.fn(`${address.tag}.update`)(function* (
      certificateName: string,
      options: CertificateUpdateOptions,
    ) {
      const vaultBaseUrl = yield* address.vaultBaseUrl;
      const { version, ...rest } = options;
      return yield* update({
        ...rest,
        vaultBaseUrl,
        certificateName,
        certificateVersion: version ?? "",
      });
    }),
    updatePolicy: Effect.fn(`${address.tag}.updatePolicy`)(function* (
      certificateName: string,
      policy: CertificatePolicyUpdate,
    ) {
      const vaultBaseUrl = yield* address.vaultBaseUrl;
      return yield* updatePolicy({ ...policy, vaultBaseUrl, certificateName });
    }),
    delete: Effect.fn(`${address.tag}.delete`)(function* (certificateName: string) {
      const vaultBaseUrl = yield* address.vaultBaseUrl;
      return yield* remove({ vaultBaseUrl, certificateName }).pipe(
        Effect.catchTag("CertificateNotFound", () => Effect.succeed(undefined)),
      );
    }),
  });
});

/**
 * Build a Read/Write/ReadWrite certificate binding that assigns `roles` on
 * the vault and returns the client `makeClient` builds.
 */
export const makeCertificateLevelBinding = <Client>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.KeyVault.CertificateRead`. */
  tag: string;
  /** Roles assigned on the vault. */
  roles: readonly CertificateRole[];
  makeClient: Effect.Effect<(address: CertificateAddress) => Client>;
}) =>
  Effect.gen(function* () {
    const grant = yield* CertificateGrants;
    const makeClient = yield* options.makeClient;
    return Effect.fn(function* (vault: Vault) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* grant(options.tag, vault, options.roles);
      }
      const vaultBaseUrl = yield* vaultBaseUrlOf(vault);
      return makeClient({ tag: `${options.tag}(${vault.LogicalId})`, vaultBaseUrl });
    });
  });

/** Roles of {@link makeReadCertificatesClient}. */
export const READ_CERTIFICATE_ROLES = [CertificateRoles.Read];
/** Roles of {@link makeWriteCertificatesClient}. */
export const WRITE_CERTIFICATE_ROLES = [
  CertificateRoles.Create,
  CertificateRoles.Import,
  CertificateRoles.Update,
  CertificateRoles.Delete,
];
