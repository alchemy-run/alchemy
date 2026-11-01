import * as observability from "@distilled.cloud/stackit/observability";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import {
  asRedacted,
  CONFIG_DELETE_TIMEOUT,
  CONFIG_TIMEOUT,
  generatedName,
  isGeneratedName,
  isInstanceGone,
  listOwnedInstances,
  type InstanceScope,
} from "./internal.ts";

export interface CredentialProps {
  /** Id of the instance the credential belongs to. Changing it replaces the credential. */
  instanceId: string;
  /**
   * Description of the credential, at most 1000 characters. The API can't change it,
   * so changing it replaces the credential, and the new one has a new username and
   * password. Removing it changes nothing.
   *
   * @default a unique name generated from the stack, stage and logical ID
   */
  description?: string;
  /**
   * Metric samples per minute this credential may push through remote write. Updates
   * in place; removing it deletes the limit.
   */
  remoteWriteLimit?: number;
  /** Project that owns the instance. Changing it replaces the credential. @default the profile's project */
  projectId?: string;
}

export interface CredentialAttributes {
  /** Username STACKIT generated for the credential. Basic auth username. */
  username: string;
  /**
   * The password. STACKIT only returns it when the credential is created. Basic auth
   * password. `undefined` only until a deploy has replaced a credential whose password
   * a crash lost.
   */
  password: Redacted.Redacted<string> | undefined;
  /** Id of the instance the credential belongs to. */
  instanceId: string;
  /** Project that owns the instance. */
  projectId: string;
  /** Description of the credential. */
  description: string;
  /** The remote-write limit this credential holds, when `remoteWriteLimit` is set. */
  remoteWriteLimit: number | undefined;
  /** The most the plan allows a credential's remote-write limit to be, when `remoteWriteLimit` is set. */
  credentialsMaxLimit: number | undefined;
}

export type Credential = Resource<
  "Stackit.Observability.Credential",
  CredentialProps,
  CredentialAttributes,
  never,
  Providers
>;

/**
 * A technical user of a `Stackit.Observability.Instance`: the basic-auth key for
 * pushing metrics and logs and for querying them.
 *
 * STACKIT generates the username and password, and only returns the password when it
 * creates the credential. Alchemy keeps it `Redacted` in the `password` attribute.
 * There is no way to reset it: changing `description` replaces the credential, and
 * the new one has a new username and password.
 *
 * Credentials have no name and no labels. The default `description` is a generated
 * name, which is what finds a credential again after a crash: it is deleted and
 * created again, because its password is gone. A credential with a `description` you
 * chose can't be found that way, so one that a crash left behind stays on the
 * instance until you delete it. `alchemy unsafe nuke` only clears credentials with a
 * generated `description`.
 *
 * See [STACKIT's Observability docs](https://docs.stackit.cloud/products/logging-and-monitoring/observability/).
 *
 * :::caution[Changing `instanceId`, `description` or `projectId` replaces the Credential]
 * There is no way to reset a password. The new credential has a new username and
 * password, and the old one stops working when it is deleted.
 * :::
 *
 * ### Creating a Credential
 * **Example:** A credential for remote write
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.Observability.Instance("Metrics", {});
 * const credential = yield* Stackit.Observability.Credential("Writer", {
 *   instanceId: instance.instanceId,
 * });
 * // Push to instance.pushMetricsUrl with credential.username and credential.password,
 * // which is Redacted: hand it to a secret store or a binding, never log it.
 * ```
 *
 * ### Limiting Remote Write
 * **Example:** Cap what one tenant can push
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.Observability.Instance("Metrics", {});
 * const credential = yield* Stackit.Observability.Credential("Tenant", {
 *   instanceId: instance.instanceId,
 *   description: "tenant-a",
 *   remoteWriteLimit: 5000,
 * });
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Changing the description changes the password
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // The API has no update for a credential: a new one is created, with a new
 * // username and password, and the old one is deleted.
 * const instance = yield* Stackit.Observability.Instance("Metrics", {});
 * const credential = yield* Stackit.Observability.Credential("Tenant", {
 *   instanceId: instance.instanceId,
 *   description: "tenant-b",
 * });
 * ```
 *
 * @resource
 * @product STACKIT Observability
 * @category Observability
 */
export const Credential = Resource<Credential>("Stackit.Observability.Credential");

const getCredentialOrUndefined = (scope: InstanceScope, username: string) =>
  observability
    .getCredentials({ ...scope, username })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/**
 * Crash recovery: a description holding this generation's generated name. The list's
 * `name` is what `getCredentials` takes as the username.
 */
const findByDescription = (scope: InstanceScope, description: string) =>
  observability
    .listCredentials(scope)
    .pipe(
      Effect.map(({ credentials }) =>
        credentials.find((credential) => credential.description === description),
      ),
    );

/** Delete a credential; gone counts as done. */
const deleteCredentialAndWait = (scope: InstanceScope, username: string) =>
  Effect.gen(function* () {
    yield* observability
      .deleteCredentials({ ...scope, username })
      .pipe(Effect.catchTag("NotFound", () => Effect.void));
    yield* waitUntilGone({
      resource: `STACKIT Observability credential ${username}`,
      read: getCredentialOrUndefined(scope, username),
      timeout: CONFIG_DELETE_TIMEOUT,
    });
  });

const toAttrs = (
  scope: InstanceScope,
  fields: {
    readonly username: string;
    readonly password: Redacted.Redacted<string> | undefined;
    readonly description: string;
    readonly limit?: observability.CredentialsRemoteWriteConfig | undefined;
  },
): CredentialAttributes => ({
  username: fields.username,
  password: fields.password,
  instanceId: scope.instanceId,
  projectId: scope.projectId,
  description: fields.description,
  remoteWriteLimit: fields.limit?.maxLimit,
  credentialsMaxLimit: fields.limit?.credentialsMaxLimit,
});

export const CredentialProvider = () =>
  Provider.succeed(Credential, {
    stables: ["instanceId", "projectId"],
    nuke: { dependsOn: ["Stackit.Observability.Instance"] },

    // No name and no labels: only a generated description shows a credential is ours.
    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const projectId = env.projectId;
      const instances = yield* listOwnedInstances(projectId);
      const attrs: CredentialAttributes[] = [];
      for (const instance of instances) {
        const scope = { projectId, instanceId: instance.id };
        if (yield* isInstanceGone(scope)) continue;
        const { credentials } = yield* observability.listCredentials(scope);
        for (const credential of credentials) {
          if (credential.description === undefined || !isGeneratedName(credential.description)) {
            continue;
          }
          attrs.push(
            toAttrs(scope, {
              username: credential.name,
              password: undefined,
              description: credential.description,
            }),
          );
        }
      }
      return attrs;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // The username is STACKIT's, so a new credential can't collide with the old one.
      if (hasUnresolvedTrigger<CredentialProps>(news, ["instanceId", "projectId", "description"])) {
        return { action: "replace", deleteFirst: false } as const;
      }
      const env = yield* StackitEnvironment.current;
      const resolved = triggerProps<CredentialProps>(news);
      if (
        resolved.instanceId !== output.instanceId ||
        (resolved.projectId ?? env.projectId) !== output.projectId ||
        (resolved.description !== undefined && resolved.description !== output.description)
      ) {
        return { action: "replace", deleteFirst: false } as const;
      }
      // A credential whose password a crash lost: reconcile recreates it.
      if (output.password === undefined) return { action: "update" } as const;
      // A plain change of `remoteWriteLimit` (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* StackitEnvironment.current;
      const projectId = output?.projectId ?? olds?.projectId ?? env.projectId;
      const instanceId = output?.instanceId ?? olds?.instanceId;
      if (instanceId === undefined) return undefined;
      const scope = { projectId, instanceId };
      if (yield* isInstanceGone(scope)) return undefined;
      if (output !== undefined) {
        const live = yield* getCredentialOrUndefined(scope, output.username);
        if (live !== undefined) return output;
      }
      // A chosen description proves nothing, so only a generated one can be recovered.
      if (rawProp<CredentialProps>(olds, "description") !== undefined) return undefined;
      const description = yield* generatedName(id);
      const found = yield* findByDescription(scope, description);
      if (found === undefined) return undefined;
      // No password: reconcile recreates it.
      return toAttrs(scope, { username: found.name, password: undefined, description });
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* StackitEnvironment.current;
      const projectId = news.projectId ?? output?.projectId ?? env.projectId;
      const instanceId = news.instanceId;
      const scope = { projectId, instanceId };
      const generated = yield* generatedName(id);
      const description = news.description ?? output?.description ?? generated;
      // `output` only speaks for this credential while it is on the desired instance.
      const known =
        output?.instanceId === instanceId && output.projectId === projectId ? output : undefined;

      // 1. Observe — by cached username, then by this generation's generated description.
      const live =
        known === undefined ? undefined : yield* getCredentialOrUndefined(scope, known.username);
      const reachable = live === undefined ? undefined : known;
      let username = reachable?.username;
      let password = reachable?.password;
      if (username === undefined && description === generated) {
        const found = yield* findByDescription(scope, generated);
        username = found?.name;
      }

      // A credential with no known password can't be used by anyone: its only copy was
      // lost, so there is nothing to protect, and the API has no reset.
      if (username !== undefined && password === undefined) {
        yield* deleteCredentialAndWait(scope, username);
        username = undefined;
      }

      // 2. Ensure — the response holds the only copy of the password.
      let createdNow = false;
      if (username === undefined) {
        const { credentials } = yield* observability.createCredentials({ ...scope, description });
        username = credentials.username;
        password = asRedacted(credentials.password);
        createdNow = true;
      }
      const finalUsername = username;
      const finalPassword = password;

      const converge = Effect.gen(function* () {
        // The next reads can miss a credential that was just created.
        yield* waitFor({
          resource: `STACKIT Observability credential ${finalUsername}`,
          read: getCredentialOrUndefined(scope, finalUsername),
          ready: (credential) => credential !== undefined,
          state: (credential) => (credential === undefined ? "not visible yet" : "ready"),
          timeout: CONFIG_TIMEOUT,
        });

        // 3. Sync — the limit against what is live. Reading it needs a plan with
        // metrics, so a credential that never asked for one doesn't ask.
        const limit = news.remoteWriteLimit;
        const request = { ...scope, username: finalUsername };
        let observedLimit: observability.CredentialsRemoteWriteConfig | undefined;
        if (limit !== undefined) {
          observedLimit = yield* observability.getCredentialsRemoteWriteConfig(request);
          if (observedLimit.maxLimit !== limit) {
            yield* observability.updateCredentialsRemoteWriteConfig({
              ...request,
              maxLimit: limit,
            });
            observedLimit = yield* waitFor({
              resource: `Remote-write limit of STACKIT Observability credential ${finalUsername}`,
              read: observability.getCredentialsRemoteWriteConfig(request),
              ready: (config) => config.maxLimit === limit,
              state: (config) => String(config.maxLimit),
              timeout: CONFIG_TIMEOUT,
            });
          }
        } else if (known?.remoteWriteLimit !== undefined) {
          yield* observability
            .deleteCredentialsRemoteWriteConfig(request)
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }

        // 4. Return
        return toAttrs(scope, {
          username: finalUsername,
          password: finalPassword,
          description,
          limit: observedLimit,
        });
      });

      // A failure from here on would lose the password and the only way to delete this
      // live login: state never hears of it.
      return yield* createdNow
        ? converge.pipe(
            Effect.onError(() => deleteCredentialAndWait(scope, finalUsername).pipe(Effect.ignore)),
          )
        : converge;
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, instanceId: output.instanceId };
      if (yield* isInstanceGone(scope)) return;
      yield* deleteCredentialAndWait(scope, output.username);
    }),
  });
