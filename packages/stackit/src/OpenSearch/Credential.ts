import type * as opensearch from "@distilled.cloud/stackit/opensearch";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { Providers } from "../Providers.ts";
import {
  CREDENTIAL_LABEL,
  credentialApi,
  makeCredentialLifecycle,
  type OpenSearchError,
  toRedacted,
} from "./internal.ts";

export interface CredentialProps {
  /** Instance the credential belongs to. Changing it creates a new credential. */
  instanceId: string;
  /**
   * Change this value to rotate the credential. STACKIT has no update for a credential,
   * so the new one is created first and the old one deleted after.
   */
  rotationKey?: string;
  /** Project that owns the instance. Changing it creates a new credential. @default the profile's project */
  projectId?: string;
  /** Region of the instance. Changing it creates a new credential. @default the profile's region */
  region?: string;
}

export interface CredentialAttributes {
  /** STACKIT credential id. Stable across updates. */
  credentialId: string;
  /** Instance the credential belongs to. */
  instanceId: string;
  /** Project that owns the instance. */
  projectId: string;
  /** Region of the instance. */
  region: string;
  /** Host to connect to. */
  host: string;
  /** Every host of the instance. */
  hosts: string[];
  /** Port to connect to, when the API reports one. */
  port: number | undefined;
  /** URL scheme of the instance, when the API reports one. */
  scheme: string | undefined;
  /** User name. */
  username: string;
  /** The user's password. */
  password: Redacted.Redacted<string>;
  /** Connection URI. `Redacted` because it embeds the password. */
  uri: Redacted.Redacted<string>;
}

export type Credential = Resource<
  "Stackit.OpenSearch.Credential",
  CredentialProps,
  CredentialAttributes,
  never,
  Providers
>;

/**
 * A user on a `Stackit.OpenSearch.Instance`, with its connection details.
 *
 * STACKIT can't update a credential: changing any prop creates a new one first and
 * deletes the old one after. Password and URI stay `Redacted`, and the API keeps
 * returning them, so a refresh restores them.
 *
 * A credential has neither a name nor labels, so only the id in state ties it to a
 * stack. A deploy that crashes between creating one and saving it leaves it behind
 * until the instance is deleted. `alchemy unsafe nuke` removes credentials with their
 * instance.
 *
 * ### Creating a Credential
 * **Example:** A credential for an application
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const search = yield* Stackit.OpenSearch.Instance("Search", {
 *   version: "2",
 *   planName: "stackit-opensearch-1.2.10-replica",
 *   acl: ["203.0.113.7/32"],
 * });
 * const credential = yield* Stackit.OpenSearch.Credential("App", {
 *   instanceId: search.instanceId,
 * });
 * ```
 *
 * ### Rotating a Credential
 * **Example:** Change `rotationKey` for a new user and password
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const search = yield* Stackit.OpenSearch.Instance("Search", {
 *   version: "2",
 *   planName: "stackit-opensearch-1.2.10-replica",
 *   acl: ["203.0.113.7/32"],
 * });
 * const credential = yield* Stackit.OpenSearch.Credential("App", {
 *   instanceId: search.instanceId,
 *   rotationKey: "2026-11",
 * });
 * ```
 *
 * @resource
 * @product STACKIT OpenSearch
 * @category OpenSearch
 */
export const Credential = Resource<Credential>("Stackit.OpenSearch.Credential");

export const CredentialProvider = () => {
  const lifecycle = makeCredentialLifecycle<
    OpenSearchError,
    opensearch.StackitOpContext,
    opensearch.CredentialsResponse,
    CredentialAttributes
  >({
    label: CREDENTIAL_LABEL,
    api: credentialApi,
    attributes: (scope, instanceId, credential) => {
      const details = credential.raw?.credentials;
      if (details === undefined) return undefined;
      return {
        credentialId: credential.id,
        instanceId,
        projectId: scope.projectId,
        region: scope.region,
        host: details.host,
        hosts: [...(details.hosts ?? [])],
        port: details.port,
        scheme: details.scheme,
        username: details.username,
        password: toRedacted(details.password),
        uri: toRedacted(credential.uri),
      };
    },
  });

  return Provider.succeed(Credential, {
    stables: ["credentialId", "instanceId", "projectId", "region"],
    nuke: { dependsOn: ["Stackit.OpenSearch.Instance"] },

    // No name and no labels, so nothing identifies a credential as ours: nuke removes
    // them with the instance.
    list: () => Effect.succeed([]),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      return yield* lifecycle.diff(news, olds, output);
    }),

    read: Effect.fn(function* ({ output }) {
      return yield* lifecycle.read(output);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      return yield* lifecycle.reconcile(news, output);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* lifecycle.delete(output);
    }),
  });
};
