import type * as logme from "@distilled.cloud/stackit/logme";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { makeCredentialLifecycle, toRedacted } from "../OpenSearch/internal.ts";
import type { Providers } from "../Providers.ts";
import { CREDENTIAL_LABEL, credentialApi, type LogMeError } from "./internal.ts";

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
  /** Port to connect to, when the API reports one. */
  port: number | undefined;
  /**
   * Where to send syslog, when the API reports it. `Redacted` because a URL like this
   * can embed a user and password. Set another instance's `syslog` to reach it.
   */
  syslogDrainUrl: Redacted.Redacted<string> | undefined;
  /** User name. */
  username: string;
  /** The user's password. */
  password: Redacted.Redacted<string>;
  /** Connection URI. `Redacted` because it embeds the password. */
  uri: Redacted.Redacted<string>;
}

export type Credential = Resource<
  "Stackit.LogMe.Credential",
  CredentialProps,
  CredentialAttributes,
  never,
  Providers
>;

/**
 * A user on a `Stackit.LogMe.Instance`, with its connection details.
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
 * See [STACKIT's LogMe docs](https://docs.stackit.cloud/products/logging-and-monitoring/logme/).
 *
 * :::caution[Changing any prop replaces the Credential]
 * STACKIT can't update a credential. A new one is created first and the old one is
 * deleted after, with a new password and URI.
 * :::
 *
 * ### Creating a Credential
 * **Example:** A credential for an application
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const logs = yield* Stackit.LogMe.Instance("Logs", {
 *   version: "2",
 *   planName: "stackit-logme2-1.2.50-replica",
 *   acl: ["203.0.113.7/32"],
 * });
 * const credential = yield* Stackit.LogMe.Credential("App", {
 *   instanceId: logs.instanceId,
 * });
 * ```
 *
 * ### Rotating a Credential
 * **Example:** Change `rotationKey` for a new user and password
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const logs = yield* Stackit.LogMe.Instance("Logs", {
 *   version: "2",
 *   planName: "stackit-logme2-1.2.50-replica",
 *   acl: ["203.0.113.7/32"],
 * });
 * const credential = yield* Stackit.LogMe.Credential("App", {
 *   instanceId: logs.instanceId,
 *   rotationKey: "2026-11",
 * });
 * ```
 *
 * @resource
 * @product STACKIT LogMe
 * @category LogMe
 */
export const Credential = Resource<Credential>("Stackit.LogMe.Credential");

export const CredentialProvider = () => {
  const lifecycle = makeCredentialLifecycle<
    LogMeError,
    logme.StackitOpContext,
    logme.CredentialsResponse,
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
        port: details.port,
        syslogDrainUrl:
          details.syslog_drain_url === undefined ? undefined : toRedacted(details.syslog_drain_url),
        username: details.username,
        password: toRedacted(details.password),
        uri: toRedacted(credential.uri),
      };
    },
  });

  return Provider.succeed(Credential, {
    stables: ["credentialId", "instanceId", "projectId", "region"],
    nuke: { dependsOn: ["Stackit.LogMe.Instance"] },

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
