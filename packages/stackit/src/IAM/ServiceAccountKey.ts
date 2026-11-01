import * as serviceAccount from "@distilled.cloud/stackit/service_account";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger } from "../internal/diff.ts";
import type { Providers } from "../Providers.ts";
import { hasServiceAccount } from "./internal/service_account.ts";

export type ServiceAccountKeyAlgorithm = "RSA_2048" | "RSA_4096";

export type ServiceAccountKeyProps = {
  /**
   * Email of the service account the key belongs to, e.g. a
   * `Stackit.IAM.ServiceAccount`'s `email`. Changing it replaces the key.
   */
  serviceAccountEmail: string;
  /**
   * Project of the service account. Defaults to the profile's project.
   * Changing it replaces the key.
   */
  projectId?: string;
  /**
   * Algorithm of the key pair STACKIT generates. Ignored when `publicKey` is
   * set (the algorithm is then derived from the public key). Changing it
   * replaces the key.
   * @default "RSA_2048"
   */
  algorithm?: ServiceAccountKeyAlgorithm;
  /**
   * Public half of your own RSA key pair, as a PEM-encoded X.509 v3
   * certificate. When set, STACKIT stores only the public key and the
   * resource exposes no `privateKey`: sign with the private key you keep.
   * When omitted, STACKIT generates the pair and returns the private key
   * once, at creation. Changing it replaces the key.
   */
  publicKey?: string;
  /**
   * Expiry of the key, as an RFC 3339 timestamp
   * (`2027-01-01T00:00:00Z`). Omit it for a key that is valid until
   * deleted. Changing or removing it updates the key in place.
   */
  validUntil?: string;
  /**
   * Whether the key can be used. `false` deactivates the key temporarily
   * without deleting it; flipping it updates the key in place.
   * @default true
   */
  active?: boolean;
};

export interface ServiceAccountKeyCredentials {
  /** Key id to put in the `kid` header of self-signed assertions. */
  kid: string;
  /** Issuer: the service account email. */
  iss: string;
  /** Subject: the service account id. */
  sub: string;
  /** Audience: the service account API URL. */
  aud: string;
  /** Token endpoint to exchange a signed assertion for an access token. */
  tokenEndpoint: string | undefined;
}

export type ServiceAccountKey = Resource<
  "Stackit.IAM.ServiceAccountKey",
  ServiceAccountKeyProps,
  {
    /** Unique id of the key. */
    keyId: string;
    /** Email of the service account the key belongs to. */
    serviceAccountEmail: string;
    /** Project of the service account. */
    projectId: string;
    /** Whether the key is active. */
    active: boolean;
    /** Expiry timestamp, or `undefined` for a key valid until deleted. */
    validUntil: string | undefined;
    /** Creation timestamp. */
    createdAt: string;
    /** Key algorithm (`RSA_2048` or `RSA_4096`). */
    keyAlgorithm: string;
    /** `GENERATED` (STACKIT made the pair) or `USER_PROVIDED`. */
    keyOrigin: string;
    /** `USER_MANAGED` for keys created through the API. */
    keyType: string;
    /** Public key of the pair, as returned at creation. */
    publicKey: string;
    /** Claims and endpoint for signing in as the service account. */
    credentials: ServiceAccountKeyCredentials;
    /**
     * PEM private key of a STACKIT-generated pair. STACKIT returns it only
     * when the key is created, so it is kept in Alchemy's state.
     * `undefined` for a key made from your own `publicKey`.
     */
    privateKey: Redacted.Redacted<string> | undefined;
    /**
     * The service account key file, the JSON document `stackit
     * service-account key create` writes: STACKIT's CLI, SDKs, Terraform
     * provider and Alchemy's own STACKIT profile read it. Includes the
     * private key when STACKIT generated it.
     */
    keyJson: Redacted.Redacted<string>;
  },
  never,
  Providers
>;

/**
 * A key for a STACKIT service account. Code outside STACKIT signs a JWT with
 * the key and exchanges it for a short-lived access token, acting as the
 * service account.
 *
 * STACKIT generates an RSA key pair unless you pass your own `publicKey`
 * (an X.509 certificate). A generated private key is returned only once, so
 * Alchemy keeps it in state (`privateKey`, `keyJson`, both redacted). A key
 * whose stored private key is lost (state written by another tool, or an
 * adopted key) is replaced on the next deploy, because the material cannot
 * be read back.
 *
 * Limits and cautions: a service account holds at most 10 keys, and a key
 * cannot be created or changed while authenticated as the same service
 * account. Prefer workload identity federation
 * (`Stackit.IAM.FederatedIdentityProvider`) for CI systems that issue OIDC
 * tokens: there is no long-lived secret to leak.
 *
 * Ownership: keys have no labels. Alchemy tracks a key only through the
 * `keyId` in its state, and `alchemy unsafe nuke` removes keys by deleting
 * their service account.
 *
 * ### Creating a Key
 * **Example:** STACKIT-generated key pair
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const ci = yield* Stackit.IAM.ServiceAccount("Ci", {});
 * const key = yield* Stackit.IAM.ServiceAccountKey("CiKey", {
 *   serviceAccountEmail: ci.email,
 *   algorithm: "RSA_4096",
 * });
 * ```
 *
 * **Example:** Key from your own certificate
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const ci = yield* Stackit.IAM.ServiceAccount("Ci", {});
 * const key = yield* Stackit.IAM.ServiceAccountKey("CiKey", {
 *   serviceAccountEmail: ci.email,
 *   publicKey: "-----BEGIN CERTIFICATE-----\nMIIC…\n-----END CERTIFICATE-----\n",
 * });
 * ```
 *
 * ### Expiry and Deactivation
 * **Example:** Key that expires
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const ci = yield* Stackit.IAM.ServiceAccount("Ci", {});
 * const key = yield* Stackit.IAM.ServiceAccountKey("CiKey", {
 *   serviceAccountEmail: ci.email,
 *   validUntil: "2027-01-01T00:00:00Z",
 * });
 * ```
 *
 * **Example:** Deactivate a key without deleting it
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const ci = yield* Stackit.IAM.ServiceAccount("Ci", {});
 * const key = yield* Stackit.IAM.ServiceAccountKey("CiKey", {
 *   serviceAccountEmail: ci.email,
 *   active: false,
 * });
 * ```
 *
 * ### Using the Key
 * **Example:** Pass the key file to another system as a secret
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const ci = yield* Stackit.IAM.ServiceAccount("Ci", {});
 * const key = yield* Stackit.IAM.ServiceAccountKey("CiKey", {
 *   serviceAccountEmail: ci.email,
 * });
 * // key.keyJson is Redacted: hand it to a secret store, never log it.
 * ```
 *
 * ### Replacement
 * Changing `serviceAccountEmail`, `projectId`, `algorithm` or `publicKey`
 * creates a new key (new `keyId` and private key) and deletes the old one;
 * anything holding the old key file stops authenticating.
 *
 * @resource
 * @product STACKIT Service Account
 * @category IAM
 */
export const ServiceAccountKey = Resource<ServiceAccountKey>("Stackit.IAM.ServiceAccountKey");

type Attributes = ServiceAccountKey["Attributes"];

/** STACKIT's "no expiry" sentinel for `validUntil` on update. */
const NO_EXPIRY = "9999-01-01T01:01:01Z";

/** `undefined` for no expiry (unset, or STACKIT's year-9999 sentinel). */
const expiryOf = (validUntil: string | undefined): number | undefined => {
  if (validUntil === undefined || validUntil === "") return undefined;
  const time = Date.parse(validUntil);
  if (Number.isNaN(time) || new Date(time).getUTCFullYear() >= 9999) return undefined;
  return time;
};

const normalizeExpiry = (validUntil: string | undefined) =>
  expiryOf(validUntil) === undefined ? undefined : validUntil;

const redact = (
  value: string | Redacted.Redacted<string> | undefined,
): Redacted.Redacted<string> | undefined =>
  typeof value === "string" ? Redacted.make(value) : value;

/** The key file STACKIT's tooling reads (`stackit service-account key create`). */
const toKeyJson = (
  key: serviceAccount.CreateServiceAccountKeyResponse,
  privateKey: Redacted.Redacted<string> | undefined,
) =>
  Effect.sync(() =>
    Redacted.make(
      JSON.stringify({
        id: key.id,
        publicKey: key.publicKey,
        createdAt: key.createdAt,
        validUntil: key.validUntil,
        keyType: key.keyType,
        keyOrigin: key.keyOrigin,
        keyAlgorithm: key.keyAlgorithm,
        active: key.active,
        credentials: {
          kid: key.credentials.kid,
          iss: key.credentials.iss,
          sub: key.credentials.sub,
          aud: key.credentials.aud,
          privateKey: privateKey === undefined ? undefined : Redacted.value(privateKey),
          tokenEndpoint: key.credentials.tokenEndpoint,
        },
      }),
    ),
  );

/**
 * The live key, or `undefined` when it (or its service account) is gone.
 * The account is checked first so a deleted account reads as "gone" rather
 * than whatever status the key endpoint answers for it.
 */
const observeKey = Effect.fn(function* (input: {
  projectId: string;
  serviceAccountEmail: string;
  keyId: string;
}) {
  if (!(yield* hasServiceAccount(input.projectId, input.serviceAccountEmail))) return undefined;
  return yield* serviceAccount
    .getServiceAccountKey({
      projectId: input.projectId,
      serviceAccountEmail: input.serviceAccountEmail,
      keyId: input.keyId,
    })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
});

const deleteKey = Effect.fn(function* (input: {
  projectId: string;
  serviceAccountEmail: string;
  keyId: string;
}) {
  // A deleted service account took its keys with it.
  if (!(yield* hasServiceAccount(input.projectId, input.serviceAccountEmail))) return;
  yield* serviceAccount
    .deleteServiceAccountKey(input)
    .pipe(Effect.catchTag("NotFound", () => Effect.void));
});

/** Stored key material is missing: it can't be read back, so replace. */
const materialLost = (output: Attributes) =>
  output.keyOrigin === "GENERATED" && output.privateKey === undefined;

export const ServiceAccountKeyProvider = () =>
  Provider.succeed(ServiceAccountKey, {
    stables: [
      "keyId",
      "serviceAccountEmail",
      "projectId",
      "createdAt",
      "keyAlgorithm",
      "keyOrigin",
      "keyType",
      "publicKey",
      "credentials",
      "privateKey",
      "keyJson",
    ],
    // Deleting a key needs its service account; nuke removes keys through
    // the account (`list` is empty: keys carry no ownership marker).
    nuke: { dependsOn: ["Stackit.IAM.ServiceAccount"] },

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      if (
        hasUnresolvedTrigger<ServiceAccountKeyProps>(news, [
          "projectId",
          "serviceAccountEmail",
          "publicKey",
          "algorithm",
        ])
      ) {
        return { action: "replace" as const };
      }
      if (!isResolved(news)) return undefined;
      const env = yield* StackitEnvironment.current;
      if ((news.projectId ?? env.projectId) !== output.projectId) {
        return { action: "replace" as const };
      }
      if (news.serviceAccountEmail !== output.serviceAccountEmail) {
        return { action: "replace" as const };
      }
      if (olds !== undefined) {
        if (news.publicKey !== olds.publicKey) return { action: "replace" as const };
        if (news.publicKey === undefined && news.algorithm !== olds.algorithm) {
          // Unset means STACKIT's default (RSA_2048): only a real change replaces.
          const before = olds.algorithm ?? output.keyAlgorithm;
          const after = news.algorithm ?? "RSA_2048";
          if (before !== after) return { action: "replace" as const };
        }
      } else if (news.algorithm !== undefined && news.algorithm !== output.keyAlgorithm) {
        return { action: "replace" as const };
      }
      if (materialLost(output)) return { action: "replace" as const };
      return undefined;
    }),

    // A key carries no labels and its private half is returned only on
    // create, so only a key recorded in state can be read back.
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const live = yield* observeKey(output);
      if (live === undefined) return undefined;
      return {
        ...output,
        active: live.active,
        validUntil: normalizeExpiry(live.validUntil),
      };
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* StackitEnvironment.current;
      const projectId = news.projectId ?? output?.projectId ?? env.projectId;
      const serviceAccountEmail = news.serviceAccountEmail;
      const sameIdentity =
        output !== undefined &&
        output.projectId === projectId &&
        output.serviceAccountEmail === serviceAccountEmail &&
        !materialLost(output);

      // Observe: keep the key we made while it still exists.
      const live =
        sameIdentity && output !== undefined
          ? yield* observeKey({ projectId, serviceAccountEmail, keyId: output.keyId })
          : undefined;

      let attrs: Attributes;
      if (live !== undefined && output !== undefined) {
        attrs = {
          ...output,
          active: live.active,
          validUntil: normalizeExpiry(live.validUntil),
        };
      } else {
        // Ensure: create a new key; its private half is only returned now.
        const created = yield* serviceAccount.createServiceAccountKey({
          projectId,
          serviceAccountEmail,
          algorithm: news.publicKey === undefined ? news.algorithm : undefined,
          publicKey: news.publicKey,
          validUntil: news.validUntil,
        });
        const privateKey = redact(created.credentials.privateKey);
        attrs = {
          keyId: created.id,
          serviceAccountEmail,
          projectId,
          active: created.active,
          validUntil: normalizeExpiry(created.validUntil),
          createdAt: created.createdAt,
          keyAlgorithm: created.keyAlgorithm,
          keyOrigin: created.keyOrigin,
          keyType: created.keyType,
          publicKey: created.publicKey,
          credentials: {
            kid: created.credentials.kid,
            iss: created.credentials.iss,
            sub: created.credentials.sub,
            aud: created.credentials.aud,
            tokenEndpoint: created.credentials.tokenEndpoint,
          },
          privateKey,
          keyJson: yield* toKeyJson(created, privateKey),
        };
        // A key this resource made earlier, under an identity it no longer
        // has, would otherwise be left behind.
        if (output !== undefined && output.keyId !== created.id) {
          yield* deleteKey({
            projectId: output.projectId,
            serviceAccountEmail: output.serviceAccountEmail,
            keyId: output.keyId,
          });
        }
      }

      // Sync the mutable aspects against observed state.
      const desiredActive = news.active ?? true;
      const desiredExpiry = expiryOf(news.validUntil);
      const observedExpiry = expiryOf(attrs.validUntil);
      const activeChanged = attrs.active !== desiredActive;
      const expiryChanged = desiredExpiry !== observedExpiry;
      if (activeChanged || expiryChanged) {
        const updated = yield* serviceAccount.partialUpdateServiceAccountKey({
          projectId,
          serviceAccountEmail,
          keyId: attrs.keyId,
          active: activeChanged ? desiredActive : undefined,
          validUntil: expiryChanged ? (news.validUntil ?? NO_EXPIRY) : undefined,
        });
        attrs = {
          ...attrs,
          active: updated.active,
          validUntil: normalizeExpiry(updated.validUntil),
        };
      }

      return attrs;
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* deleteKey({
        projectId: output.projectId,
        serviceAccountEmail: output.serviceAccountEmail,
        keyId: output.keyId,
      });
    }),
  });
