import * as confidentialledger from "@distilled.cloud/azure/confidentialledger";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

/** Role a security principal holds on a ledger. */
export type LedgerRoleName = "Reader" | "Contributor" | "Administrator";

/** Microsoft Entra ID (AAD) principal with a ledger role. */
export interface LedgerAadPrincipal {
  /** Object (principal) ID of the user, group, service principal or managed identity. */
  principalId: string;
  /**
   * Tenant ID of the principal.
   * @default the tenant of the deploying credentials
   */
  tenantId?: string;
  /** Role granted to the principal on the ledger. */
  ledgerRoleName: LedgerRoleName;
}

/** Certificate-based principal with a ledger role. */
export interface LedgerCertPrincipal {
  /** PEM-encoded public certificate of the user. */
  cert: string;
  /** Role granted to the certificate holder on the ledger. */
  ledgerRoleName: LedgerRoleName;
}

export interface LedgerProps {
  /**
   * Resource group the ledger is created in. Confidential Ledger rejects
   * resource group names longer than 63 characters (the generated default
   * of `Azure.Resources.ResourceGroup` can be up to 90, so set its `name`).
   * Changing it replaces the ledger.
   */
  resourceGroup: string;
  /**
   * Globally unique ledger name (3-24 letters, digits and hyphens, starting
   * with a letter); it becomes `{name}.confidential-ledger.azure.com`. If
   * omitted, a unique name is generated from the app, stage, and logical ID.
   * Changing it replaces the ledger.
   */
  name?: string;
  /**
   * Azure location of the ledger. Confidential Ledger is offered in a limited
   * set of regions (e.g. `eastus`, `southcentralus`, `westeurope`). Changing
   * it replaces the ledger.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * `Public` ledgers store transactions in plain text; `Private` ledgers
   * encrypt them. Changing it replaces the ledger.
   * @default "Public"
   */
  ledgerType?: "Public" | "Private";
  /**
   * Ledger SKU. The `Basic` (preview) SKU is no longer offered for new
   * ledgers. Changing it replaces the ledger.
   * @default "Standard"
   */
  ledgerSku?: "Basic" | "Standard";
  /**
   * Application type. Changing it replaces the ledger.
   * @default "ConfidentialLedger"
   */
  applicationType?: "ConfidentialLedger" | "CodeTransparency";
  /**
   * Microsoft Entra ID principals and their ledger roles. A ledger needs at
   * least one `Administrator` (AAD or certificate based). Updated in place,
   * but the service applies principal changes through the ledger's data
   * plane as the caller, so the deploying identity must itself be listed
   * as an `Administrator` for later changes to succeed.
   */
  aadBasedSecurityPrincipals?: LedgerAadPrincipal[];
  /**
   * Certificate-based principals and their ledger roles. Updated in place.
   */
  certBasedSecurityPrincipals?: LedgerCertPrincipal[];
  /**
   * Desired running state. Set `Paused` to pause the ledger (and its
   * billing) and `Active` to resume it. Updated in place.
   * @default "Active"
   */
  runningState?: "Active" | "Paused";
  /**
   * CCF logging level for the untrusted host: `Trace`, `Debug`, `Info`,
   * `Fail`, `Fatal`. Updated in place.
   */
  hostLevel?: string;
  /** CCF maximum HTTP request body size in MB (1, 5 or 10). Updated in place. */
  maxBodySizeInMb?: number;
  /** CCF subject name for the node certificate (e.g. `CN=CCF Node`). Updated in place. */
  subjectName?: string;
  /** Number of CCF nodes. Updated in place. */
  nodeCount?: number;
  /** Prefix for the write load balancer address (e.g. `write`). Updated in place. */
  writeLBAddressPrefix?: string;
  /** Additional enclave worker threads processing client requests. Updated in place. */
  workerThreads?: number;
  /** SCITT configuration (CodeTransparency ledgers). Updated in place. */
  scittConfiguration?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Ledger extends Resource<
  "Azure.ConfidentialLedger.Ledger",
  LedgerProps,
  {
    /** Name of the ledger. */
    ledgerName: string;
    /** Resource group that holds the ledger. */
    resourceGroup: string;
    /** ARM resource ID of the ledger. */
    ledgerId: string;
    /** Location of the ledger. */
    location: string;
    /** Data-plane endpoint (`https://{name}.confidential-ledger.azure.com`). */
    ledgerUri: string;
    /** Endpoint serving the ledger's network identity certificate. */
    identityServiceUri: string;
    /** Internal namespace of the ledger. */
    ledgerInternalNamespace: string;
    /** Ledger type (`Public` or `Private`). */
    ledgerType: string;
    /** Ledger SKU. */
    ledgerSku: string;
    /** Application type of the ledger. */
    applicationType: string;
    /** Enclave platform (`IntelSgx` or `AmdSevSnp`). */
    enclavePlatform: string;
    /** Current running state. */
    runningState: string;
    /** Provisioning state of the ledger. */
    provisioningState: string;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Confidential Ledger — a tamper-proof, append-only ledger running
 * in hardware-backed secure enclaves (Confidential Consortium Framework).
 *
 * Ledger names are globally unique and are retained for a while after
 * deletion, so re-creating a ledger with the same name right after deleting
 * it can fail with a name conflict.
 *
 * @see https://learn.microsoft.com/azure/confidential-ledger/overview
 *
 * ### Creating a Ledger
 * **Example:** Public ledger administered by a managed identity
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("ledger", {
 *   name: "ledger-rg", // ledger requires a group name of <= 63 characters
 *   location: "eastus",
 * });
 * const admin = yield* Azure.ManagedIdentity.UserAssignedIdentity("admin", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const ledger = yield* Azure.ConfidentialLedger.Ledger("audit", {
 *   resourceGroup: group.resourceGroupName,
 *   aadBasedSecurityPrincipals: [
 *     { principalId: admin.principalId, ledgerRoleName: "Administrator" },
 *   ],
 * });
 * // ledger.ledgerUri -> "https://<name>.confidential-ledger.azure.com"
 * ```
 *
 * **Example:** Private ledger
 * ```typescript
 * const ledger = yield* Azure.ConfidentialLedger.Ledger("secrets", {
 *   resourceGroup: group.resourceGroupName,
 *   ledgerType: "Private",
 *   aadBasedSecurityPrincipals: [
 *     { principalId: admin.principalId, ledgerRoleName: "Administrator" },
 *   ],
 * });
 * ```
 *
 * ### Managing Access
 * **Example:** Add a reader and a certificate administrator
 * ```typescript
 * const ledger = yield* Azure.ConfidentialLedger.Ledger("audit", {
 *   resourceGroup: group.resourceGroupName,
 *   aadBasedSecurityPrincipals: [
 *     { principalId: admin.principalId, ledgerRoleName: "Administrator" },
 *     { principalId: auditor.principalId, ledgerRoleName: "Reader" },
 *   ],
 *   certBasedSecurityPrincipals: [
 *     { cert: adminCertPem, ledgerRoleName: "Administrator" },
 *   ],
 * });
 * ```
 *
 * ### Pausing a Ledger
 * **Example:** Pause to stop billing
 * ```typescript
 * const ledger = yield* Azure.ConfidentialLedger.Ledger("audit", {
 *   resourceGroup: group.resourceGroupName,
 *   runningState: "Paused",
 *   aadBasedSecurityPrincipals: [
 *     { principalId: admin.principalId, ledgerRoleName: "Administrator" },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const Ledger = Resource<Ledger>("Azure.ConfidentialLedger.Ledger");

type ObservedLedger = confidentialledger.GetLedgerResponse;

/** 3-24 lowercase letters and digits, starting with a letter. */
const createLedgerName = Effect.fn(function* (id: string) {
  const name = (yield* createPhysicalName({
    id,
    maxLength: 24,
    lowercase: true,
    delimiter: "",
  })).replace(/[^a-z0-9]/g, "");
  return /^[a-z]/.test(name) ? name : `l${name}`.slice(0, 24);
});

export const getLedger = (
  subscriptionId: string,
  resourceGroupName: string,
  ledgerName: string,
) =>
  orUndefinedIfNotFound(
    confidentialledger.GetLedger({
      subscriptionId,
      resourceGroupName,
      ledgerName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  ledger: ObservedLedger,
): Ledger["Attributes"] => ({
  ledgerName: name,
  resourceGroup,
  ledgerId: ledger.id ?? "",
  location: ledger.location,
  ledgerUri: ledger.properties?.ledgerUri ?? "",
  identityServiceUri: ledger.properties?.identityServiceUri ?? "",
  ledgerInternalNamespace: ledger.properties?.ledgerInternalNamespace ?? "",
  ledgerType: ledger.properties?.ledgerType ?? "",
  ledgerSku: ledger.properties?.ledgerSku ?? "",
  applicationType: ledger.properties?.applicationType ?? "",
  enclavePlatform: ledger.properties?.enclavePlatform ?? "",
  runningState: ledger.properties?.runningState ?? "",
  provisioningState: ledger.properties?.provisioningState ?? "",
  tags: userTags(ledger.tags),
});

const aadKey = (principals: confidentialledger.AADBasedSecurityPrincipal[]) =>
  principals
    .map((p) =>
      [
        (p.principalId ?? "").toLowerCase(),
        (p.tenantId ?? "").toLowerCase(),
        (p.ledgerRoleName ?? "").toLowerCase(),
      ].join("|"),
    )
    .sort()
    .join(",");

const certKey = (principals: confidentialledger.CertBasedSecurityPrincipal[]) =>
  principals
    .map((p) =>
      [
        (p.cert ?? "").replace(/\s+/g, ""),
        (p.ledgerRoleName ?? "").toLowerCase(),
      ].join("|"),
    )
    .sort()
    .join(",");

const differs = <A>(desired: A | undefined, observed: A | undefined) =>
  desired !== undefined && desired !== observed;

export const LedgerProvider = () =>
  Provider.succeed(Ledger, {
    stables: ["ledgerName", "resourceGroup", "ledgerId", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* confidentialledger
        .ListLedgerBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListLedgerBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((ledger) => {
        const group = resourceGroupOf(ledger.id);
        return hasAnyAlchemyTag(ledger.tags) &&
          group !== undefined &&
          ledger.name !== undefined
          ? [toAttrs(group, ledger.name, ledger)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const lower = (s: string | undefined) => s?.toLowerCase();
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.ledgerName)) ||
        (news.location !== undefined &&
          lower(news.location) !== lower(output.location)) ||
        lower(news.ledgerType ?? "Public") !== lower(output.ledgerType) ||
        lower(news.ledgerSku ?? "Standard") !== lower(output.ledgerSku) ||
        lower(news.applicationType ?? "ConfidentialLedger") !==
          lower(output.applicationType)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.ledgerName ?? olds?.name ?? (yield* createLedgerName(id));
      const observed = yield* getLedger(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.ConfidentialLedger");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.ledgerName ?? (yield* createLedgerName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        ledgerName: name,
      };
      const label = `confidential ledger ${name}`;
      const get = getLedger(subscriptionId, resourceGroup, name);
      // The ledger GET never reports provisioningState; a ledger is usable
      // once its data-plane endpoint (`ledgerUri`) is published (~4 min).
      const waitUntil = (ready: (ledger: ObservedLedger) => boolean) =>
        waitForProvisioned(
          label,
          get,
          (ledger) => {
            const state = ledger.properties?.provisioningState;
            if (state !== undefined && state !== "Succeeded") return state;
            return ready(ledger) ? "Succeeded" : "Pending";
          },
          { interval: "10 seconds", times: 60 },
        );
      const wait = waitUntil((ledger) => !!ledger.properties?.ledgerUri);

      const aad: confidentialledger.AADBasedSecurityPrincipal[] = (
        news.aadBasedSecurityPrincipals ?? []
      ).map((p) => ({
        principalId: p.principalId,
        tenantId: p.tenantId ?? env.tenantId,
        ledgerRoleName: p.ledgerRoleName,
      }));
      const certs: confidentialledger.CertBasedSecurityPrincipal[] = (
        news.certBasedSecurityPrincipals ?? []
      ).map((p) => ({ cert: p.cert, ledgerRoleName: p.ledgerRoleName }));
      const tuning = {
        hostLevel: news.hostLevel,
        maxBodySizeInMb: news.maxBodySizeInMb,
        subjectName: news.subjectName,
        nodeCount: news.nodeCount,
        writeLBAddressPrefix: news.writeLBAddressPrefix,
        workerThreads: news.workerThreads,
        scittConfiguration: news.scittConfiguration,
      };

      const runningState = news.runningState ?? "Active";
      // PUT is a full upsert; the service applies PATCH bodies unreliably,
      // so every write sends the complete desired state.
      const put = (withRunningState: boolean) =>
        confidentialledger.CreateLedger({
          ...where,
          location,
          tags,
          properties: {
            ledgerType: news.ledgerType ?? "Public",
            ledgerSku: news.ledgerSku ?? "Standard",
            applicationType: news.applicationType ?? "ConfidentialLedger",
            aadBasedSecurityPrincipals: aad,
            certBasedSecurityPrincipals: certs,
            ...tuning,
            ...(withRunningState ? { runningState } : {}),
          },
        });

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation.
      if (observed === undefined) {
        yield* put(false);
      }
      observed = yield* wait;

      // Sync principals, tuning, running state and tags against observed state.
      const props = observed.properties ?? {};
      const principalsChanged =
        aadKey(props.aadBasedSecurityPrincipals ?? []) !== aadKey(aad) ||
        certKey(props.certBasedSecurityPrincipals ?? []) !== certKey(certs);
      const tuningChanged = (
        Object.keys(tuning) as (keyof typeof tuning)[]
      ).some((key) => differs(tuning[key], props[key]));
      const observedState = props.runningState;
      const runningStateChanged =
        (observedState === "Active" || observedState === "Paused") &&
        observedState !== runningState;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (
        principalsChanged ||
        tuningChanged ||
        runningStateChanged ||
        tagsChanged
      ) {
        yield* put(runningStateChanged);
        // The write is applied asynchronously and GET never reports its
        // outcome, so wait for the observed state to converge. Principal
        // changes go through the ledger's data plane as the caller: the
        // deploying identity must itself be a ledger Administrator.
        observed = yield* waitForProvisioned(
          `${label} (security principals are only updated when the deploying identity is a ledger Administrator)`,
          get,
          (ledger) => {
            const p = ledger.properties ?? {};
            const converged =
              !!p.ledgerUri &&
              !tagsDiffer(ledger.tags, tags) &&
              aadKey(p.aadBasedSecurityPrincipals ?? []) === aadKey(aad) &&
              certKey(p.certBasedSecurityPrincipals ?? []) === certKey(certs) &&
              (!runningStateChanged || p.runningState === runningState);
            return converged ? "Succeeded" : "Pending";
          },
          { interval: "10 seconds", times: 30 },
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      // A DELETE accepted while the ledger is still being created is dropped
      // by the service, so re-issue it if the ledger outlives one wait.
      yield* ignoreNotFound(
        confidentialledger.DeleteLedger({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          ledgerName: output.ledgerName,
        }),
      ).pipe(
        Effect.andThen(
          waitUntilGone(
            `confidential ledger ${output.ledgerName}`,
            getLedger(subscriptionId, output.resourceGroup, output.ledgerName),
            { interval: "10 seconds", times: 40 },
          ),
        ),
        Effect.retry({
          while: (e) => e._tag === "Azure.DeleteTimedOut",
          times: 2,
        }),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
