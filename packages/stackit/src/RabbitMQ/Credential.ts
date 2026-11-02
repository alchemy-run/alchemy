import type * as rabbitmq from "@distilled.cloud/stackit/rabbitmq";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { ProjectScope } from "../IaaS/internal.ts";
import { makeCredentialLifecycle, toRedacted } from "../internal/dataServices.ts";
import { rawProp } from "../internal/diff.ts";
import { sameMembers } from "../internal/equal.ts";
import type { Providers } from "../Providers.ts";
import { credentialApi } from "./internal.ts";

/** A broker role STACKIT can give a credential. */
export type CredentialRole = "management" | "policymaker" | "monitoring" | "administrator";

export interface CredentialProps {
  /** Id of the instance the credential is for. Changing it replaces the credential. */
  instanceId: string;
  /**
   * Broker roles of the credential. The API has no update for a credential, so
   * changing them replaces it, and clients get a new user and password.
   *
   * @default STACKIT's default role (`policymaker`)
   */
  roles?: CredentialRole[];
  /**
   * Any value. Changing it, or removing it, replaces the credential: the old user
   * stops working once the new one exists.
   */
  rotationKey?: string;
  /** Project that owns the instance. Changing it replaces the credential. @default the profile's project */
  projectId?: string;
  /** Region of the instance. Changing it replaces the credential. @default the profile's region */
  region?: string;
}

export interface CredentialAttributes {
  /** STACKIT credential id. */
  credentialId: string;
  /** Id of the instance the credential is for. */
  instanceId: string;
  /** Project that owns the instance. */
  projectId: string;
  /** Region of the instance. */
  region: string;
  /** Host of the broker. */
  host: string;
  /** Hosts of the broker, one per node. */
  hosts: string[];
  /** AMQP port of the broker. */
  port: number | undefined;
  /** User name of the credential. */
  username: string;
  /** Password of the credential. */
  password: Redacted.Redacted<string>;
  /** AMQP URI, with the user and password in it. */
  uri: Redacted.Redacted<string>;
  /** AMQP URIs, one per node, with the user and password in them. */
  uris: Redacted.Redacted<string>[];
  /** Address of the broker's management HTTP API. */
  httpApiUri: Redacted.Redacted<string> | undefined;
  /** Addresses of the broker's management HTTP API, one per node. */
  httpApiUris: Redacted.Redacted<string>[];
  /** Address of the broker's management interface. */
  management: Redacted.Redacted<string> | undefined;
  /** MQTT address, if the API reports one. */
  mqtt: Redacted.Redacted<string> | undefined;
  /** STOMP address, if the API reports one. */
  stomp: Redacted.Redacted<string> | undefined;
}

export type Credential = Resource<
  "Stackit.RabbitMQ.Credential",
  CredentialProps,
  CredentialAttributes,
  never,
  Providers
>;

/**
 * A user on a `Stackit.RabbitMQ.Instance`, with the addresses to reach the broker
 * with. Its password and every address are `Redacted` in attributes and state.
 *
 * A credential has no update: changing `roles` or `rotationKey` creates a new one and
 * deletes the old one. It has no name or labels either, so only the id in state finds
 * it. A deploy that crashes between creating it and saving the state leaves that user
 * on the instance until the instance is deleted, and `alchemy unsafe nuke` removes
 * credentials with their instance.
 *
 * See [STACKIT's RabbitMQ docs](https://docs.stackit.cloud/products/messaging/rabbitmq/).
 *
 * :::caution[Changing `instanceId`, `roles`, `rotationKey`, `projectId` or `region` replaces the Credential]
 * A credential has no update. A new one is created with new addresses and a new
 * password, and the old one is deleted.
 * :::
 *
 * ### Creating a Credential
 * **Example:** A credential with the default role
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const broker = yield* Stackit.RabbitMQ.Instance("Broker", {
 *   version: "4.1",
 *   planName: "stackit-rabbitmq-2.4.10-single",
 *   acl: ["203.0.113.7/32"],
 * });
 * const credential = yield* Stackit.RabbitMQ.Credential("App", {
 *   instanceId: broker.instanceId,
 * });
 * // credential.uri and credential.password are Redacted: hand them to a binding or a
 * // secret store, never log them.
 * ```
 *
 * **Example:** A credential that can use the management interface
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const broker = yield* Stackit.RabbitMQ.Instance("Broker", {
 *   version: "4.1",
 *   planName: "stackit-rabbitmq-2.4.10-single",
 *   acl: ["203.0.113.7/32"],
 * });
 * const operator = yield* Stackit.RabbitMQ.Credential("Operator", {
 *   instanceId: broker.instanceId,
 *   roles: ["management", "monitoring"],
 * });
 * ```
 *
 * ### Rotating a Credential
 * **Example:** Replace the user by changing `rotationKey`
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const broker = yield* Stackit.RabbitMQ.Instance("Broker", {
 *   version: "4.1",
 *   planName: "stackit-rabbitmq-2.4.10-single",
 *   acl: ["203.0.113.7/32"],
 * });
 * const credential = yield* Stackit.RabbitMQ.Credential("App", {
 *   instanceId: broker.instanceId,
 *   rotationKey: "2026-11",
 * });
 * ```
 *
 * @resource
 * @product STACKIT RabbitMQ
 * @category RabbitMQ
 */
export const Credential = Resource<Credential>("Stackit.RabbitMQ.Credential");

const optionalSecret = (value: string | Redacted.Redacted<string> | undefined) =>
  value === undefined ? undefined : toRedacted(value);

const toAttrs = (
  scope: ProjectScope,
  instanceId: string,
  credential: rabbitmq.CredentialsResponse,
): CredentialAttributes | undefined => {
  const raw = credential.raw?.credentials;
  if (raw === undefined) return undefined;
  return {
    credentialId: credential.id,
    instanceId,
    projectId: scope.projectId,
    region: scope.region,
    host: raw.host,
    hosts: [...(raw.hosts ?? [])],
    port: raw.port,
    username: raw.username,
    password: toRedacted(raw.password),
    uri: toRedacted(raw.uri ?? credential.uri),
    uris: (raw.uris ?? []).map(toRedacted),
    httpApiUri: optionalSecret(raw.http_api_uri),
    httpApiUris: (raw.http_api_uris ?? []).map(toRedacted),
    management: optionalSecret(raw.management),
    mqtt: optionalSecret(raw.mqtt),
    stomp: optionalSecret(raw.stomp),
  };
};

const lifecycleOf = (roles: CredentialRole[] | undefined) =>
  makeCredentialLifecycle({
    label: "STACKIT RabbitMQ credential",
    api: credentialApi(roles),
    attributes: toAttrs,
  });

export const CredentialProvider = () =>
  Provider.succeed(Credential, {
    stables: ["credentialId", "instanceId", "projectId", "region"],
    nuke: { dependsOn: ["Stackit.RabbitMQ.Instance"] },

    // No `list`: nothing marks a credential as Alchemy's, and deleting its instance
    // deletes it.

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      const identity = yield* lifecycleOf(undefined).diff(news, olds, output);
      if (identity !== undefined) return identity;
      const roles = rawProp<CredentialProps>(news, "roles");
      if (!isResolved(roles)) return { action: "replace" } as const;
      if (olds !== undefined && !sameMembers(roles as CredentialRole[] | undefined, olds.roles)) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      // `getCredentials` keeps returning the password, so this restores the secrets.
      return yield* lifecycleOf(undefined).read(output);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      return yield* lifecycleOf(news.roles).reconcile(news, output);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* lifecycleOf(undefined).delete(output);
    }),
  });
