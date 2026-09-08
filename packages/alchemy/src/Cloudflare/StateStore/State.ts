import * as SecretsStore from "@distilled.cloud/cloudflare/secrets-store";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import crypto from "node:crypto";

import * as Config from "effect/Config";
import * as Option from "effect/Option";
import { isHttpClientError } from "effect/unstable/http/HttpClientError";
import { adopt } from "../../AdoptPolicy.ts";
import { AlchemyContext } from "../../AlchemyContext.ts";
import { AuthError } from "../../Auth/AuthProvider.ts";
import { CredentialsStore } from "../../Auth/Credentials.ts";
import { currentProfileName } from "../../Auth/Profile.ts";
import * as Cloudflare from "../../Cloudflare/Providers.ts";
import { deploy } from "../../Deploy.ts";
import * as Output from "../../Output.ts";
import { RandomProvider } from "../../Random.ts";
import * as Alchemy from "../../Stack.ts";
import { Progress } from "../../Report.ts";
import { StateApi } from "../../State/HttpStateApi.ts";
import {
  checkHttpStateStoreAuth,
  makeHttpStateStore,
  type HttpStateStoreCredentials,
} from "../../State/HttpStateStore.ts";
import { makeLocalState } from "../../State/LocalState.ts";
import {
  State,
  isResourceState,
  type StateService,
} from "../../State/State.ts";
import {
  recordStateStoreInit,
  recordStateStoreOp,
} from "../../Telemetry/Metrics.ts";
import * as Interaction from "../../Interaction.ts";
import * as Access from "../Access.ts";
import * as CloudflareEnvironment from "../CloudflareEnvironment.ts";
import { EdgeSessionError, createEdgeSession } from "../EdgeSession.ts";
import Api, { STATE_STORE_SCRIPT_NAME, STATE_STORE_VERSION } from "./Api.ts";
import {
  CREDENTIALS_FILE,
  StoredStateStoreCredentials,
  isStateStoreCredentialsStale,
} from "./CredentialsFile.ts";
import {
  AuthToken,
  AuthTokenSecretName,
  EncryptionKeySecretName,
  TokenValue,
} from "./Token.ts";

const CI = Config.boolean("CI").pipe(Config.withDefault(false));

export const state = () =>
  Layer.effect(
    State,
    Effect.gen(function* () {
      const isCI = yield* CI;
      const scriptName = STATE_STORE_SCRIPT_NAME;
      const profileName = yield* currentProfileName;
      const localStage = `${profileName}_${scriptName}`;
      const credStore = yield* CredentialsStore;
      // `deploy --yes` flows in here (via AlchemyContext.updateStateStore) to
      // auto-accept an out-of-date state store upgrade instead of prompting.
      // Optional so callers that don't provide AlchemyContext keep the prompt.
      const autoUpdateStateStore =
        Option.getOrUndefined(yield* Effect.serviceOption(AlchemyContext))
          ?.updateStateStore ?? false;
      const context = yield* Effect.context<Effect.Services<typeof init>>();

      const init = Effect.gen(function* () {
        if (yield* hasLocalStack(localStage)) {
          // if there's still a local stack, then we need to finish the bootstrap
          // TODO(sam): what if the local stack was
          const task = (yield* Interaction.Interaction).task;
          return yield* task(
            {
              label: `Resuming Cloudflare State Store '${scriptName}' deployment`,
            },
            deployWithLocalState({
              scriptName,
              profileName,
              isCI,
              force: false,
            }),
          ).pipe(withStateBootstrapEvents(scriptName));
        }

        const ensureLatest = ({
          url,
          authToken,
        }: {
          url: string;
          authToken: string;
        }) =>
          Effect.gen(function* () {
            const { matches, expected, observed } =
              yield* checkStateStoreVersion(url);

            if (observed === undefined) {
              const shouldDeploy =
                autoUpdateStateStore ||
                (yield* Interaction.accessors.prompt.confirm({
                  message: `Cloudflare State Store '${scriptName}' is not available. Do you want to deploy it?`,
                  // Deploying is the constructive happy path, not destructive
                  // — keep default-yes despite the prompt-wide default-no.
                  initialValue: true,
                  confirmLabel: "Deploy",
                  cancelLabel: "Cancel",
                }));
              if (shouldDeploy) {
                return yield* bootstrap({
                  workerName: scriptName,
                  profile: profileName,
                });
              } else {
                return yield* Effect.die(new Interaction.TerminalCancelled());
              }
            }

            const httpState = yield* ensureAccess({ url, authToken });
            if (matches) {
              return httpState;
            }

            // The store is out of date. Upgrade it in place.
            const upgrade = Effect.gen(function* () {
              const interaction = yield* Interaction.Interaction;
              return yield* interaction.task(
                {
                  label: `Updating Cloudflare State Store '${scriptName}'`,
                  detail: `v${observed ?? "unknown"} → v${expected}`,
                },
                Effect.gen(function* () {
                  const stateStoreOptions = yield* deployStateStore({
                    stage: scriptName,
                    state: httpState,
                    force: false,
                  });
                  return yield* makeCloudflareStateStore(stateStoreOptions);
                }),
              );
            }).pipe(withStateBootstrapEvents(scriptName));

            if (autoUpdateStateStore) {
              // `--yes`: upgrade automatically (also unblocks CI).
              return yield* upgrade;
            } else if (isCI) {
              return yield* Effect.die(
                new AuthError({
                  message:
                    `Cloudflare State store is out of date ` +
                    `(expected v${expected}, observed v${observed ?? "unknown"}). ` +
                    `Run 'alchemy provider cloudflare bootstrap --profile <your-ci-profile>' to upgrade it first, or pass --yes.`,
                }),
              );
            } else {
              const shouldDeploy = yield* Interaction.accessors.prompt.confirm({
                message:
                  `Cloudflare State Store '${scriptName}' is out of date ` +
                  `(expected v${expected}, observed v${observed ?? "unknown"})`,
                // Upgrading is the constructive happy path — default-yes.
                initialValue: true,
                confirmLabel: "Upgrade",
                cancelLabel: "Cancel",
              });
              if (shouldDeploy) {
                return yield* upgrade;
              } else {
                return yield* Effect.die(new Interaction.TerminalCancelled());
              }
            }
          });

        const ensureAccess = (credentials: HttpStateStoreCredentials) =>
          Effect.gen(function* () {
            const isAuth = yield* checkHttpStateStoreAuth(credentials);
            if (!isAuth) {
              // our token is wrong, force a refresh
              const credentials = yield* loginWithCloudflare(profileName, true);
              if (!(yield* checkHttpStateStoreAuth(credentials))) {
                return yield* Effect.die(
                  new AuthError({
                    message: `Cloudflare State store authentication failed, after refreshing credentials.`,
                  }),
                );
              }
              return yield* makeCloudflareStateStore(credentials);
            }
            return yield* makeCloudflareStateStore(credentials);
          });

        const { accountId } =
          yield* yield* CloudflareEnvironment.CloudflareEnvironment;

        const credentials = yield* credStore.read(
          profileName,
          CREDENTIALS_FILE,
          StoredStateStoreCredentials,
        );
        if (credentials) {
          // The cached `url`/`authToken` are minted per-account (the `url`
          // encodes the account via its workers.dev subdomain). If the
          // active account changed since they were written — or the file
          // predates the `accountId` field — trusting the cache would
          // silently read/write state in the wrong account, so discard it
          // and fall through to re-derivation from the current account.
          if (isStateStoreCredentialsStale(credentials, accountId)) {
            yield* Interaction.accessors.output.info(
              `Cloudflare State Store credentials were minted for a different ` +
                `Cloudflare account; re-deriving for the current account.`,
            );
            yield* credStore
              .delete(profileName, CREDENTIALS_FILE)
              .pipe(Effect.ignore);
          } else {
            return yield* ensureLatest(credentials);
          }
        }
        const decision = decideStateStoreInit({
          serving: yield* isStateStoreServing(accountId),
          autoUpdate: autoUpdateStateStore,
          isCI,
        });
        return yield* Match.value(decision).pipe(
          Match.when("login", () =>
            loginWithCloudflare(profileName, false).pipe(
              Effect.flatMap(ensureLatest),
            ),
          ),
          Match.when("bootstrap", () => bootstrap()),
          Match.when("refuse-ci", () =>
            Effect.die(
              new AuthError({
                message:
                  "Cloudflare State store not found. A CI deploy does not " +
                  "bootstrap it. Run 'alchemy provider cloudflare bootstrap " +
                  "--profile <profile>' from a workstation first.",
              }),
            ),
          ),
          Match.when("prompt", () =>
            Interaction.accessors.prompt
              .confirm({
                message:
                  "Cloudflare State Store not found. Do you want to deploy it?",
                // Deploying is the constructive happy path — default-yes.
                initialValue: true,
              })
              .pipe(
                Effect.flatMap((shouldDeploy) =>
                  shouldDeploy
                    ? bootstrap()
                    : Effect.die(new Interaction.TerminalCancelled()),
                ),
              ),
          ),
          Match.exhaustive,
        );
      }).pipe(recordStateStoreInit, Effect.orDie);

      return yield* Effect.cached(init.pipe(Effect.provideContext(context)));
    }),
  ).pipe(
    // The Cloudflare API foundation shared with `providers()` —
    // credentials, environment, auth/access, profile + credential
    // store, and the same blanket retry policy. Without the retry
    // policy the init-time subdomain/script/secrets probes run on the
    // SDK default and give up early under Cloudflare rate limiting.
    // `provide` (not `provideMerge`) so the distilled Retry tag stays
    // out of this layer's public type.
    Layer.provide(Cloudflare.CloudflareApiLive()),
    Layer.orDie,
  );

export interface BootstrapOptions {
  /** @default "alchemy-state-store" */
  workerName?: string;
  /** @default false */
  force?: boolean;
  /** @default "default" */
  profile?: string;
}

/**
 * Report `state.bootstrap.*` progress events around a state-store deploy or
 * upgrade. Bootstrap runs lazily inside the plan's "loading state" phase,
 * can take many seconds (it deploys a worker), and would otherwise be
 * invisible to non-interactive renderers and traces — the Interaction task only
 * paints the local terminal.
 */
const withStateBootstrapEvents =
  (store: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const report = yield* Progress;
      yield* report({ _tag: "state.bootstrap.started", store });
      const result = yield* effect;
      yield* report({ _tag: "state.bootstrap.completed", store });
      return result;
    });

export const bootstrap = (options: BootstrapOptions = {}) =>
  withStateBootstrapEvents(options.workerName ?? STATE_STORE_SCRIPT_NAME)(
    Effect.gen(function* () {
      const interaction = yield* Interaction.Interaction;
      const isCI = yield* CI;
      const profileName = options.profile ?? (yield* currentProfileName);
      const scriptName = options.workerName ?? STATE_STORE_SCRIPT_NAME;
      const force = options.force ?? false;
      const localStage = `${profileName}_${scriptName}`;
      yield* Effect.annotateCurrentSpan({
        "alchemy.state_store.script_name": scriptName,
        "alchemy.state_store.profile": profileName,
        "alchemy.state_store.force": force,
        "alchemy.state_store.ci": isCI,
      });
      yield* annotateAccountHash();
      const { accountId } =
        yield* yield* CloudflareEnvironment.CloudflareEnvironment;

      if (yield* hasLocalStack(localStage)) {
        // A local stack means an earlier bootstrap did not finish. Resume it.
        return yield* interaction.task(
          {
            label: `Resuming Cloudflare State Store '${scriptName}' deployment`,
          },
          deployWithLocalState({
            scriptName,
            profileName,
            isCI,
            force,
          }),
        );
      }
      if (scriptName !== STATE_STORE_SCRIPT_NAME) {
        yield* refuseSecondStateStore(accountId, scriptName);
      }
      if (yield* isStateStoreServing(accountId)) {
        // this is a regular update, let's check if it needs an update and refresh credentials
        if (!force) {
          yield* Interaction.accessors.output.info(
            `Worker '${scriptName}' already exists; adopting and refreshing credentials. ` +
              `Use --force to redeploy.`,
          );
        }
        const credentials = yield* loginWithCloudflare(
          profileName,
          // force refresh during
          true,
        );
        const { url, authToken } = credentials;
        if (!isCI) {
          // we don't write credentials in CI because the file system is ephemeral
          const store = yield* CredentialsStore;
          yield* store.write(
            profileName,
            CREDENTIALS_FILE,
            StoredStateStoreCredentials,
            credentials,
          );
        }
        const { matches, expected, observed } =
          yield* checkStateStoreVersion(url);
        const httpState = yield* makeCloudflareStateStore({ url, authToken });
        if (!matches || force) {
          return yield* interaction.task(
            {
              label: `${matches ? "Redeploying" : "Updating"} Cloudflare State Store '${scriptName}'`,
              detail: matches
                ? "forced"
                : `v${observed ?? "unknown"} → v${expected}`,
            },
            deployStateStore({
              stage: scriptName,
              state: httpState,
              force,
            }).pipe(Effect.flatMap(makeCloudflareStateStore)),
          );
        } else {
          return httpState;
        }
      } else {
        return yield* interaction.task(
          { label: `Deploying Cloudflare State Store '${scriptName}'` },
          deployWithLocalState({
            scriptName,
            profileName,
            isCI,
            force,
          }),
        );
      }
    }).pipe(
      Effect.withSpan("state_store.bootstrap", {
        attributes: {
          "alchemy.state_store.op": "bootstrap",
          "alchemy.state_store.script_name":
            options.workerName ?? STATE_STORE_SCRIPT_NAME,
        },
      }),
    ),
  );

export interface TeardownOptions {
  /** @default "alchemy-state-store" */
  workerName?: string;
  /** @default "default" */
  profile?: string;
  /**
   * Delete the account Secrets Store too, but only once the state-store
   * secrets have been removed and no other secrets remain in it. A store that
   * still holds foreign secrets is left in place.
   * @default true
   */
  deleteEmptySecretsStore?: boolean;
}

/**
 * The inverse of {@link bootstrap}: tear down the Cloudflare-deployed state
 * store. Deletes the state-store Worker and the secrets it created in the
 * account Secrets Store (the bearer token + the encryption key), then deletes
 * the Secrets Store itself if it is left empty, and drops the locally cached
 * state-store credentials for the profile.
 *
 * Idempotent — missing resources are treated as already-gone, so it is safe to
 * re-run. Intended for reclaiming a throwaway account after testing; on a
 * shared account it only removes resources alchemy created.
 */
export const teardownStateStore = (options: TeardownOptions = {}) =>
  Effect.gen(function* () {
    const interaction = yield* Interaction.Interaction;
    const profileName = options.profile ?? (yield* currentProfileName);
    const scriptName = options.workerName ?? STATE_STORE_SCRIPT_NAME;
    const deleteEmptyStore = options.deleteEmptySecretsStore ?? true;
    const { accountId } =
      yield* yield* CloudflareEnvironment.CloudflareEnvironment;

    yield* annotateAccountHash();
    yield* Effect.annotateCurrentSpan({
      "alchemy.state_store.script_name": scriptName,
      "alchemy.state_store.profile": profileName,
    });

    // 1. Delete the state-store Worker.
    yield* Interaction.accessors.output.info(
      `Deleting state store worker '${scriptName}'...`,
    );
    yield* workers.deleteScript({ accountId, scriptName, force: true }).pipe(
      Effect.asVoid,
      Effect.catchTag("WorkerNotFound", () =>
        interaction.output.info(
          `  Worker '${scriptName}' not found (already gone).`,
        ),
      ),
    );

    // 2. Delete the secrets the state store created, plus any now-empty store.
    const ourSecretNames = new Set<string>([
      AuthTokenSecretName,
      EncryptionKeySecretName,
    ]);
    const stores = yield* SecretsStore.listStores.items({ accountId }).pipe(
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("InvalidAccountId", () => Effect.succeed([])),
    );
    for (const store of stores) {
      const secrets = yield* SecretsStore.listStoreSecrets
        .items({ accountId, storeId: store.id })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag(["StoreNotFound", "InvalidAccountId"], () =>
            Effect.succeed([]),
          ),
        );
      const ours = secrets.filter((s) => ourSecretNames.has(s.name));
      for (const secret of ours) {
        yield* Interaction.accessors.output.info(
          `Deleting secret '${secret.name}'...`,
        );
        yield* SecretsStore.deleteStoreSecret({
          accountId,
          storeId: store.id,
          secretId: secret.id,
        }).pipe(
          Effect.asVoid,
          Effect.catchTag(
            ["SecretNotFound", "StoreNotFound", "NotFound", "InvalidAccountId"],
            () => Effect.void,
          ),
        );
      }
      const remaining = secrets.length - ours.length;
      if (deleteEmptyStore && remaining === 0) {
        yield* Interaction.accessors.output.info(
          `Deleting empty secrets store '${store.id}'...`,
        );
        yield* SecretsStore.deleteStore({
          accountId,
          storeId: store.id,
          force: true,
        }).pipe(
          Effect.asVoid,
          Effect.catchTag(
            ["StoreNotFound", "NotFound", "InvalidAccountId"],
            () => Effect.void,
          ),
        );
      } else if (remaining > 0) {
        yield* Interaction.accessors.output.info(
          `Secrets store '${store.id}' still has ${remaining} other ` +
            `secret(s); leaving it in place.`,
        );
      }
    }

    // 3. Drop the locally cached state-store credentials for this profile.
    const credStore = yield* CredentialsStore;
    yield* credStore.delete(profileName, CREDENTIALS_FILE).pipe(Effect.ignore);

    yield* Interaction.accessors.output.success(
      `Cloudflare State Store '${scriptName}' torn down.`,
    );
  }).pipe(
    Effect.withSpan("state_store.teardown", {
      attributes: {
        "alchemy.state_store.op": "teardown",
        "alchemy.state_store.script_name":
          options.workerName ?? STATE_STORE_SCRIPT_NAME,
      },
    }),
  );

const deployStateStore = ({
  stage,
  state,
  force,
}: {
  stage: string;
  state: StateService;
  force?: boolean;
}) =>
  Effect.gen(function* () {
    yield* annotateAccountHash();
    // deploy it with local state (which we will then hoist into the Cloudflare state store)
    const stateLayer = Layer.succeed(State, Effect.succeed(state));
    const { url, authToken } = yield* deploy({
      // use the script name as the stage name (so the user can have multiple state stores)
      stage,
      force,
      stack: Alchemy.Stack(
        BOOTSTRAP_STACK,
        {
          providers: Layer.mergeAll(Cloudflare.providers(), RandomProvider()),
          state: stateLayer,
        },
        Effect.gen(function* () {
          const token = yield* TokenValue;
          const api = yield* Api;
          yield* AuthToken; // make sure it's in the Secrets Store

          // Surface the bearer token so tests and clients can authenticate
          // after deploy. The underlying value lives in the Cloudflare
          // Secrets Store; this output carries the same generated string.
          return {
            url: api.url.as<string>(),
            authToken: token.text.pipe(Output.map(Redacted.value)),
          };
        }),
      ),
    }).pipe(
      // The Cloudflare State Store is account-level infrastructure that
      // outlives any single deploy: its underlying Secrets Store and
      // auth-token secret may already exist from a previous (possibly
      // partially-failed) bootstrap. Opt in to adoption so the
      // resources reconcile in place instead of failing on conflict.
      adopt(true),
      // TODO(sam): we should not need to do this, but types do complain. fix deploy
      Effect.provide(stateLayer),
    );

    yield* writeCredentials(url, authToken);

    // Cloudflare's worker upload is eventually consistent: the deploy
    // call returns as soon as the script upload is accepted, but the
    // edge can keep serving the previous version for several seconds
    // afterwards. Block here until `/version` reports the version this
    // CLI was built against — otherwise downstream steps (syncing
    // local state into the deployed store, version probes during
    // adoption) end up talking to the old worker and may either
    // observe stale data or trip the staleness check and recurse into
    // another redeploy.
    yield* waitForStateStoreVersion(url);
    return { url, authToken };
  }).pipe(
    Effect.withSpan("state_store.deploy", {
      attributes: {
        "alchemy.state_store.op": "deploy",
      },
    }),
    recordStateStoreOp("deploy"),
  );

type StateStoreSecretName =
  | typeof AuthTokenSecretName
  | typeof EncryptionKeySecretName;

const STATE_STORE_SECRET_NAMES: ReadonlyArray<StateStoreSecretName> = [
  AuthTokenSecretName,
  EncryptionKeySecretName,
];

const isStateStoreSecretName = (name: string): name is StateStoreSecretName =>
  name === AuthTokenSecretName || name === EncryptionKeySecretName;

const BOOTSTRAP_STACK = "CloudflareStateStore";

/**
 * Logical ids of the `Random` resources in `Token.ts`, by the name of
 * the secret each one feeds. Both must match the ids passed to
 * `Random(...)` there.
 */
const BOOTSTRAP_SECRET_RESOURCE_IDS: Record<StateStoreSecretName, string> = {
  [AuthTokenSecretName]: "StateStoreAuthTokenValue",
  [EncryptionKeySecretName]: "StateStoreEncryptionKeyValue",
};

const findExistingStateStoreSecrets = (accountId: string) =>
  findStateStoreSecrets(accountId).pipe(
    Effect.mapError(
      (cause) =>
        new AuthError({
          message:
            "Cannot verify that this account has no Cloudflare State " +
            "Store secrets yet. Refusing to bootstrap.",
          cause,
        }),
    ),
  );

const refuseSecondStateStore = (accountId: string, scriptName: string) =>
  Effect.gen(function* () {
    const { secrets } = yield* findExistingStateStoreSecrets(accountId);
    if (secrets.length === 0) return;
    const existingNames = secrets.map((secret) => secret.name).join(", ");
    return yield* Effect.fail(
      new AuthError({
        message:
          `Cannot deploy a state store named '${scriptName}': secrets ` +
          `${existingNames} already exist in this account, so a ` +
          `'${STATE_STORE_SCRIPT_NAME}' store was deployed before. Every ` +
          "store shares the same secret names, so one Cloudflare State " +
          "Store per account is supported. Use the default worker name.",
      }),
    );
  });

/** The value one `Random` resource in the local bootstrap stack holds. */
const readLocalSecretValue = (
  localState: StateService,
  stage: string,
  resourceId: string,
) =>
  Effect.gen(function* () {
    const fqns = yield* localState.list({ stack: BOOTSTRAP_STACK, stage });
    const fqn = fqns.find(
      (candidate) => candidate.split("/").at(-1) === resourceId,
    );
    if (fqn === undefined) return undefined;
    const persisted = yield* localState.get({
      stack: BOOTSTRAP_STACK,
      stage,
      fqn,
    });
    if (!isResourceState(persisted)) return undefined;
    const text = persisted.attr?.text;
    if (!Redacted.isRedacted(text)) return undefined;
    const value = Redacted.value(text);
    return typeof value === "string" ? value : undefined;
  });

const clearLocalStackHint = (localStage: string) =>
  `run 'alchemy state clear --stack ${BOOTSTRAP_STACK} --stage ` +
  `${localStage} --local' or delete ` +
  `'.alchemy/state/${BOOTSTRAP_STACK}/${localStage}'`;

/**
 * A fresh bootstrap creates a new token and encryption key. When the
 * secrets already exist, a store was deployed before, and its state
 * becomes unreadable under a new key. A resume over existing secrets
 * is safe only when the local bootstrap stack holds the live values:
 * `Secret`'s diff compares `news.value` with `olds.value` and never
 * writes a value that did not change. A diff that compares with the
 * live secret instead would write the local values over the live ones.
 */
const refuseToReplaceExistingSecrets = (
  localState: StateService,
  localStage: string,
) =>
  Effect.gen(function* () {
    const { accountId } =
      yield* yield* CloudflareEnvironment.CloudflareEnvironment;
    const { store, secrets } = yield* findExistingStateStoreSecrets(accountId);
    if (store === undefined || secrets.length === 0) return;
    const existing = secrets.map((secret) => secret.name).join(", ");
    if (!(yield* hasLocalStack(localStage))) {
      return yield* Effect.fail(
        new AuthError({
          message:
            `Secrets ${existing} already exist in this account's Secrets ` +
            "Store, so a Cloudflare State Store was deployed before. A " +
            "fresh bootstrap would replace them and make every stack's " +
            "state unreadable. Use a token that can read Workers so the " +
            "store is found and adopted, or pass --force to rotate the " +
            "secrets on purpose.",
        }),
      );
    }
    const localAuthToken = yield* readLocalSecretValue(
      localState,
      localStage,
      BOOTSTRAP_SECRET_RESOURCE_IDS[AuthTokenSecretName],
    );
    const localEncryptionKey = yield* readLocalSecretValue(
      localState,
      localStage,
      BOOTSTRAP_SECRET_RESOURCE_IDS[EncryptionKeySecretName],
    );
    const localStackHasSecretValues =
      localAuthToken !== undefined && localEncryptionKey !== undefined;
    if (!localStackHasSecretValues) {
      return yield* Effect.fail(
        new AuthError({
          message:
            `Secrets ${existing} already exist in this account's Secrets ` +
            `Store, but the local bootstrap stack '${localStage}' does not ` +
            "hold their values. Finishing it would create new values and " +
            "make every stack's state unreadable. Clear the local stack " +
            `first: ${clearLocalStackHint(localStage)}.`,
        }),
      );
    }
    const liveEncryptionKey = yield* readSecretWithRetry(
      store.id,
      EncryptionKeySecretName,
    ).pipe(
      Effect.catchTag("EdgeSessionError", (cause) =>
        Effect.fail(
          new AuthError({
            message:
              `Cannot read the live ${EncryptionKeySecretName} to compare ` +
              `it with the local bootstrap stack '${localStage}'. Pass ` +
              "--force to upload the local values anyway.",
            cause,
          }),
        ),
      ),
    );
    if (liveEncryptionKey !== localEncryptionKey) {
      return yield* Effect.fail(
        new AuthError({
          message:
            `The local bootstrap stack '${localStage}' holds a different ` +
            `${EncryptionKeySecretName} than this account's Secrets Store. ` +
            "Another bootstrap replaced the secrets after this one was " +
            "interrupted. Finishing it would overwrite the live key and " +
            "make every stack's state unreadable. Clear the local stack to " +
            `adopt the live store (${clearLocalStackHint(localStage)}), or ` +
            "pass --force to overwrite the live secrets on purpose.",
        }),
      );
    }
  });

const deployWithLocalState = ({
  scriptName,
  isCI,
  force,
  profileName,
}: {
  scriptName: string;
  isCI: boolean;
  force: boolean;
  profileName: string;
}) =>
  Effect.gen(function* () {
    const localState = yield* makeLocalState();
    const localStage = `${profileName}_${scriptName}`;
    const remoteStage = scriptName;
    if (!force) {
      yield* refuseToReplaceExistingSecrets(localState, localStage);
    }
    const { authToken } = yield* deployStateStore({
      stage: localStage,
      state: localState,
      force,
    });

    const { url } = yield* loginWithCloudflare(profileName, force);
    const httpState = yield* makeCloudflareStateStore({ url, authToken });

    yield* hoistBootstrapStack({
      source: {
        state: localState,
        stage: localStage,
      },
      destination: {
        state: httpState,
        stage: remoteStage,
      },
    });

    yield* localState.deleteStack({
      stack: BOOTSTRAP_STACK,
      stage: localStage,
    });

    return httpState;
  }).pipe(
    Effect.withSpan("state_store.finish_bootstrap", {
      attributes: {
        "alchemy.state_store.op": "finish_bootstrap",
        "alchemy.state_store.ci": isCI,
      },
    }),
  );

/**
 * Writes against a *just-deployed* state-store worker can fail
 * transiently while Cloudflare propagates the script, its route, and
 * its Secrets Store bindings to the edge:
 *
 * - 404 — the workers.dev route isn't serving the new script yet
 * - 401 — the worker is up but its auth-token secret binding hasn't
 *   propagated, so token validation reads a stale/absent value
 * - 5xx — the Store DO dies while its encryption-key secret binding
 *   is still propagating
 * - transport errors (no response) — cold workers.dev host blips
 *
 * @internal exported for unit testing.
 */
export const isTransientBootstrapWriteError = (error: {
  cause?: unknown;
}): boolean => {
  const cause = error.cause;
  if (cause == null) return false;
  const tag = (cause as { _tag?: unknown })._tag;
  if (typeof tag === "string" && tag.startsWith("Unauthorized")) return true;
  if (isHttpClientError(cause)) {
    const status = cause.response?.status;
    return status === undefined || status === 404 || status >= 500;
  }
  return false;
};

/** True when a local bootstrap stack exists for `stage` (keyed by profile). */
const hasLocalStack = (stage: string) =>
  Effect.gen(function* () {
    const localState = yield* makeLocalState();
    return yield* Effect.map(localState.listStages(BOOTSTRAP_STACK), (stages) =>
      stages.includes(stage),
    );
  });

/**
 * Non-destructively copy every resource in the
 * `CloudflareStateStore/<scriptName>` stack from `source` into
 * `destination`, leaving every other stack in `destination` untouched.
 *
 * This intentionally does not delete anything from `destination`: at
 * bootstrap time the destination is the user's live remote state
 * store, and removing entries that happen to be missing locally would
 * be catastrophic.
 */
const hoistBootstrapStack = Effect.fn(function* ({
  source,
  destination,
}: {
  source: {
    state: StateService;
    stage: string;
  };
  destination: {
    state: StateService;
    stage: string;
  };
}) {
  const stack = BOOTSTRAP_STACK;
  const fqns = yield* source.state.list({ stack, stage: source.stage });
  yield* Effect.annotateCurrentSpan({
    "alchemy.state_store.stack": stack,
    "alchemy.state_store.stage": source.stage,
    "alchemy.state_store.resources.count": fqns.length,
  });
  yield* Effect.forEach(
    fqns,
    Effect.fn(function* (fqn) {
      const value = yield* source.state.get({
        stack,
        stage: source.stage,
        fqn,
      });
      if (value) {
        yield* destination.state
          .set({
            stack,
            stage: destination.stage,
            fqn,
            value,
          })
          .pipe(
            Effect.retry({
              while: isTransientBootstrapWriteError,
              // Bounded at ~30s: the freshly deployed worker (and its
              // Secrets Store bindings) can take a while to serve
              // consistently; anything persisting past that is a real
              // failure to surface, not to spin on.
              schedule: Schedule.max([
                Schedule.fixed(500),
                Schedule.recurs(60),
              ]),
            }),
          );
      }
    }),
    { concurrency: "unbounded" },
  );
}, Effect.withSpan("state_store.hoist_bootstrap_stack"));

/**
 * Log in to a Cloudflare-deployed HTTP state-store.
 *
 * 1. Find the single account-wide Secrets Store.
 * 2. Upload a short-lived edge-preview worker that binds the
 *    auth-token secret and returns its value.
 * 3. Derive the state-store worker URL from
 *    {@link STATE_STORE_SCRIPT_NAME} and the account's workers.dev
 *    subdomain.
 * 4. Persist `{ url, token }` under the `http-state-store`
 *    credentials file.
 *
 * Requirements are covered by the Cloudflare provider stack —
 * `CloudflareEnvironment`, `Credentials`, `HttpClient`, and
 * `FileSystem`.
 */
export const loginWithCloudflare = (profileName: string, force: boolean) =>
  Effect.gen(function* () {
    const credStore = yield* CredentialsStore;
    const isCI = yield* CI;
    const { accountId } =
      yield* yield* CloudflareEnvironment.CloudflareEnvironment;

    if (!force) {
      // try and read from the cached credentials first if not forcing (force will always refresh)
      const credentials = yield* credStore.read(
        profileName,
        CREDENTIALS_FILE,
        StoredStateStoreCredentials,
      );
      // Ignore a cache minted for a different account (or a legacy file with
      // no `accountId`) — reusing it would hand back the wrong account's
      // state-store URL. Fall through to re-derive against `accountId`.
      if (
        credentials &&
        !isStateStoreCredentialsStale(credentials, accountId)
      ) {
        return credentials;
      }
    }

    const interaction = yield* Interaction.Interaction;
    const credentials = yield* interaction.task(
      { label: "Refreshing Cloudflare State Store credentials" },
      Effect.gen(function* () {
        // 1. Locate the single Secrets Store on the account and confirm it
        //    holds the state-store token (the API lists names, not values).
        const { store, secrets } = yield* findStateStoreSecrets(accountId);
        if (!store) {
          return yield* Effect.fail(
            new AuthError({
              message:
                "No Secrets Store found on this account. Deploy the state store first.",
            }),
          );
        }
        if (!secrets.some((secret) => secret.name === AuthTokenSecretName)) {
          return yield* Effect.fail(
            new AuthError({
              message:
                `Secrets Store '${store.id}' has no ${AuthTokenSecretName}. ` +
                "Deploy the state store first.",
            }),
          );
        }

        // 2. Fetch the auth-token from Secrets Store with a temporary edge-preview worker.
        const authToken = yield* readSecretWithRetry(
          store.id,
          AuthTokenSecretName,
        );

        // 3. Derive the deployed worker URL.
        const { subdomain } = yield* workers.getSubdomain({ accountId });
        const url = `https://${STATE_STORE_SCRIPT_NAME}.${subdomain}.workers.dev`;
        const credentials = {
          url,
          authToken,
          accountId,
        };

        if (!isCI) {
          // 4. Persist credentials for subsequent invocations.
          yield* credStore
            .write(
              profileName,
              CREDENTIALS_FILE,
              StoredStateStoreCredentials,
              credentials,
            )
            .pipe(
              Effect.mapError(
                (e) =>
                  new AuthError({
                    message: "Failed to write credentials",
                    cause: e,
                  }),
              ),
            );
        }

        return credentials;
      }),
    );
    if (!isCI) yield* interaction.output.info(`  url:     ${credentials.url}`);
    return credentials;
  }).pipe(
    Effect.catchTag("EdgeSessionError", (e) =>
      Effect.fail(
        new AuthError({
          message: `Edge-preview secret read failed: ${e.message}`,
          cause: e.cause,
        }),
      ),
    ),
    Effect.withSpan("state_store.login", {
      attributes: {
        "alchemy.state_store.op": "login",
        "alchemy.state_store.script_name": STATE_STORE_SCRIPT_NAME,
      },
    }),
  );

/**
 * True when the worker exists and has at least one version. A worker
 * with no versions (a deploy interrupted before any content upload)
 * cannot serve, so it counts as absent and bootstrap redeploys it.
 */
const isStateStoreAvailable = (scriptName: string = STATE_STORE_SCRIPT_NAME) =>
  Effect.gen(function* () {
    const { accountId } =
      yield* yield* CloudflareEnvironment.CloudflareEnvironment;
    return yield* workers.getScriptSetting({ accountId, scriptName }).pipe(
      Effect.map((setting) => setting !== undefined),
      Effect.catchTag(
        ["WorkerNotFound", "InvalidRoute", "WorkerHasNoVersions"],
        () => Effect.succeed(false),
      ),
    );
  });

/**
 * Which state-store init path to take when no cached credentials exist.
 * A CI run never bootstraps: a bootstrap writes account-wide secrets.
 *
 * @internal exported for unit testing.
 */
export const decideStateStoreInit = ({
  serving,
  autoUpdate,
  isCI,
}: {
  serving: boolean;
  autoUpdate: boolean;
  isCI: boolean;
}): "login" | "bootstrap" | "refuse-ci" | "prompt" => {
  if (serving) return "login";
  if (isCI) return "refuse-ci";
  if (autoUpdate) return "bootstrap";
  return "prompt";
};

/** True when the state-store worker answers on `/version`. */
const isStateStoreServing = (accountId: string) =>
  Effect.gen(function* () {
    const url = yield* workers.getSubdomain({ accountId }).pipe(
      Effect.map(({ subdomain }) =>
        subdomain
          ? `https://${STATE_STORE_SCRIPT_NAME}.${subdomain}.workers.dev`
          : undefined,
      ),
      // Only a missing workers.dev subdomain proves that no store exists.
      // A permission or transport failure leaves the answer unknown.
      Effect.catchTag(["SubdomainNotFound", "InvalidRoute"], () =>
        Effect.succeed(undefined),
      ),
      Effect.mapError(
        (cause) =>
          new AuthError({
            message:
              "Cannot tell whether the Cloudflare State Store exists: the " +
              `workers.dev subdomain lookup failed (${cause._tag}). ` +
              "Refusing to bootstrap. Give the token Workers Scripts read " +
              "access, or run 'alchemy provider cloudflare bootstrap' from a workstation.",
            cause,
          }),
      ),
    );
    if (url === undefined) return false;
    const { observed } = yield* checkStateStoreVersion(url);
    return observed !== undefined;
  });

const makeCloudflareStateStore = Effect.fn(function* ({
  url,
  authToken,
}: {
  url: string;
  authToken: string;
}) {
  const access = yield* Access.Access;
  const accessHeaders = yield* access.getAccessHeaders(new URL(url).host);
  return yield* makeHttpStateStore({
    url,
    authToken,
    transformClient: HttpClientRequest.setHeaders(accessHeaders),
    id: "cloudflare-http",
  });
});

class StateStoreVersionNotReady extends Error {
  readonly _tag = "StateStoreVersionNotReady";
  constructor(
    readonly expected: number,
    readonly observed: number | undefined,
  ) {
    super(
      `Cloudflare State Store version not ready (expected v${expected}, observed v${observed ?? "unknown"}).`,
    );
  }
}

const waitForStateStoreVersion = (url: string) =>
  Effect.gen(function* () {
    const { matches, expected, observed } = yield* checkStateStoreVersion(url);
    if (!matches) {
      return yield* Effect.fail(
        new StateStoreVersionNotReady(expected, observed),
      );
    }
  }).pipe(
    Effect.retry({
      // The edge can serve the old version for a while after a redeploy.
      // A failed probe already spent its own retry budget, so it is final.
      while: (error) => error._tag === "StateStoreVersionNotReady",
      schedule: Schedule.max([
        Schedule.spaced("500 millis"),
        Schedule.recurs(60),
      ]),
    }),
    Effect.withSpan("state_store.wait_for_version", {
      attributes: {
        "alchemy.state_store.op": "wait_for_version",
        "alchemy.state_store.url": url,
        "alchemy.state_store.expected_version": STATE_STORE_VERSION,
      },
    }),
  );

/**
 * Probe `/version`. `observed` is `undefined` only when the route
 * returns 404 and the worker is absent. Every other failure means the
 * answer is unknown, and the probe fails with an AuthError instead of
 * collapsing to "not deployed" (which would trigger a fresh bootstrap
 * over a live store).
 */
const checkStateStoreVersion = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpApiClient.make(StateApi, { baseUrl: url });
    const isAvailable = yield* Effect.cached(
      isStateStoreAvailable(STATE_STORE_SCRIPT_NAME),
    );
    // A 404 on an existing worker is edge propagation after a deploy;
    // retry the probe for ~10s before giving up.
    const result = yield* client.version.getVersion().pipe(
      Effect.catchTag("HttpClientError", (error) => {
        if (error.response?.status !== 404) return Effect.fail(error);
        return isAvailable.pipe(
          Effect.flatMap((available) => {
            if (available) return Effect.fail(error);
            return Effect.succeed(undefined);
          }),
        );
      }),
      Effect.retry({
        schedule: Schedule.max([
          Schedule.spaced("250 millis"),
          Schedule.recurs(40),
        ]),
      }),
      Effect.mapError(
        (cause) =>
          new AuthError({
            message:
              "Cannot tell whether the Cloudflare State Store is serving: " +
              `the version probe at ${url} failed (${cause._tag}). ` +
              "Refusing to continue.",
            cause,
          }),
      ),
    );
    const matches = result?.version === STATE_STORE_VERSION;
    yield* Effect.annotateCurrentSpan({
      "alchemy.state_store.expected_version": STATE_STORE_VERSION,
      "alchemy.state_store.observed_version": result?.version ?? -1,
      "alchemy.state_store.version_match": matches,
    });
    return {
      matches,
      expected: STATE_STORE_VERSION,
      observed: result?.version,
    };
  }).pipe(
    Effect.withSpan("state_store.check_version", {
      attributes: { "alchemy.state_store.op": "check_version" },
    }),
  );

/**
 * Tiny ES-module worker that reads `env.SECRET.get()` and echoes it
 * back. Uploaded as an ephemeral edge-preview, called once, then
 * discarded — see {@link readSecretViaEdge}.
 */
const SECRET_PROBE_SOURCE = `export default {
  async fetch(_request, env) {
    try {
      const value = await env.SECRET.get();
      return new Response(value ?? "", { status: 200, headers: { "content-type": "text/plain" } });
    } catch (e) {
      return new Response("Error: " + (e && e.message ? e.message : String(e)), { status: 500 });
    }
  },
};`;

/**
 * Upload an ephemeral edge-preview build of the given (already
 * deployed) script that binds the requested Secrets Store secret,
 * call it once with the preview token, and return the decoded value.
 * The Cloudflare REST API deliberately hides secret values; only
 * worker bindings can resolve them, so this is the out-of-band path.
 *
 * `scriptName` MUST be a script that is already deployed on the
 * account with workers.dev enabled — the `cf-workers-preview-token`
 * header swaps our probe code in for an existing route, it does not
 * create one. Using an undeployed name (or a deployed script that
 * doesn't have workers.dev enabled) makes the workers.dev edge serve
 * a generic Cloudflare 400 HTML error page instead of routing to the
 * preview. The state-store script itself satisfies both conditions.
 */
const readSecretViaEdge = (
  scriptName: string,
  storeId: string,
  secretName: string,
) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const file = new File([SECRET_PROBE_SOURCE], "worker.js", {
      type: "application/javascript+module",
    });
    const session = yield* createEdgeSession({
      scriptName,
      files: [file],
      bindings: [
        { type: "secrets_store_secret", name: "SECRET", secretName, storeId },
      ],
    });
    const response = yield* http.get(session.url, {
      headers: session.headers,
    });
    if (response.status !== 200) {
      const body = yield* response.text.pipe(
        Effect.catch(() => Effect.succeed("")),
      );
      // TEMP(sam): dump the full body so we can capture the exact
      // Cloudflare error page when the probe fails in the wild. Drop
      // this once we've confirmed the routing fix covers all the
      // observed failure modes.
      yield* Effect.logWarning(
        `Secret probe failed (${response.status}) at ${session.url}\n${body}`,
      );
      return yield* Effect.fail(
        new EdgeSessionError({
          message: `Secret probe returned ${response.status}: ${body.slice(0, 200)}`,
        }),
      );
    }
    return yield* response.text;
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof EdgeSessionError
        ? cause
        : new EdgeSessionError({ message: "Failed to read secret", cause }),
    ),
    Effect.withSpan("state_store.read_secret_via_edge", {
      attributes: {
        "alchemy.state_store.op": "read_secret_via_edge",
        "alchemy.state_store.script_name": scriptName,
        "alchemy.state_store.secret_name": secretName,
      },
    }),
  );

/** Read one state-store secret through the edge probe, with retries. */
const readSecretWithRetry = (storeId: string, secretName: string) =>
  readSecretViaEdge(STATE_STORE_SCRIPT_NAME, storeId, secretName).pipe(
    Effect.retry({
      while: (error) =>
        isWorkersPreviewConfigurationError(error) ||
        isTransientEdgeSessionError(error),
      // Cap the exponential delay at 2s so 15 retries stay within
      // ~30s instead of doubling unboundedly.
      schedule: Schedule.max([
        Schedule.min([Schedule.exponential(200), Schedule.spaced("2 seconds")]),
        Schedule.recurs(15),
      ]),
    }),
    Effect.map((value) => value.trim()),
  );

/**
 * The account's Secrets Store and the state-store secrets it holds. The
 * API returns names only, never values.
 */
const findStateStoreSecrets = (accountId: string) =>
  Effect.gen(function* () {
    const store = yield* SecretsStore.listStores
      .items({ accountId })
      .pipe(Stream.runHead, Effect.map(Option.getOrUndefined));
    if (!store) return { store: undefined, secrets: [] };
    const secrets = yield* SecretsStore.listStoreSecrets
      .items({ accountId, storeId: store.id })
      .pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).filter((secret) =>
            isStateStoreSecretName(secret.name),
          ),
        ),
        Effect.catchTag("StoreNotFound", () => Effect.succeed([])),
      );
    return { store, secrets };
  });

export interface StateStoreSecrets {
  readonly accountId: string;
  readonly storeId: string;
  readonly url: string;
  readonly authToken: string;
  readonly encryptionKey: string;
}

/**
 * Read the live bearer token and encryption key through the edge probe.
 * Every resource state in the store is ciphertext under the key; a
 * rotation makes all of it unreadable.
 */
export const readStateStoreSecrets = Effect.fn("readStateStoreSecrets")(
  function* () {
    const { accountId } =
      yield* yield* CloudflareEnvironment.CloudflareEnvironment;
    const { store, secrets } = yield* findStateStoreSecrets(accountId);
    if (!store) {
      return yield* Effect.fail(
        new AuthError({ message: "No Secrets Store found on this account." }),
      );
    }
    const names = secrets.map((secret) => secret.name);
    const missing = STATE_STORE_SECRET_NAMES.filter(
      (name) => !names.includes(name),
    );
    if (missing.length > 0) {
      return yield* Effect.fail(
        new AuthError({
          message: `Secrets Store '${store.id}' has no ${missing.join(", ")}.`,
        }),
      );
    }
    const readSecret = (secretName: StateStoreSecretName) =>
      readSecretWithRetry(store.id, secretName);
    const [authToken, encryptionKey] = yield* Effect.all(
      [readSecret(AuthTokenSecretName), readSecret(EncryptionKeySecretName)],
      { concurrency: 2 },
    );
    const { subdomain } = yield* workers.getSubdomain({ accountId });
    return {
      accountId,
      storeId: store.id,
      url: `https://${STATE_STORE_SCRIPT_NAME}.${subdomain}.workers.dev`,
      authToken,
      encryptionKey,
    } satisfies StateStoreSecrets;
  },
);

/**
 * Write a backup of the token and encryption key back into the Secrets
 * Store. The Worker reads its bindings per request, so the store serves
 * the restored values at once. The cached credentials for the active
 * profile are deleted, so the next login reads the restored token.
 *
 * The two writes are not atomic. Between the first write and the second,
 * the store can read its state but does not accept the backup's token.
 * A repeated restore is safe.
 */
export const restoreStateStoreSecrets = Effect.fn("restoreStateStoreSecrets")(
  function* (backup: StateStoreSecrets) {
    const { accountId } =
      yield* yield* CloudflareEnvironment.CloudflareEnvironment;
    if (backup.accountId !== accountId) {
      return yield* Effect.fail(
        new AuthError({
          message:
            `The backup is for account '${backup.accountId}', but the active ` +
            `profile uses account '${accountId}'. Refusing to restore.`,
        }),
      );
    }
    const { store, secrets } = yield* findStateStoreSecrets(accountId);
    if (!store) {
      return yield* Effect.fail(
        new AuthError({ message: "No Secrets Store found on this account." }),
      );
    }
    if (backup.storeId !== store.id) {
      return yield* Effect.fail(
        new AuthError({
          message:
            `The backup is for Secrets Store '${backup.storeId}', but this ` +
            `account's Secrets Store is '${store.id}'. Refusing to restore.`,
        }),
      );
    }
    const secretValues: Record<StateStoreSecretName, string> = {
      [AuthTokenSecretName]: backup.authToken,
      [EncryptionKeySecretName]: backup.encryptionKey,
    };
    const findSecretId = (name: StateStoreSecretName) => {
      const found = secrets.find((secret) => secret.name === name);
      if (found) return Effect.succeed(found.id);
      return Effect.fail(
        new AuthError({
          message: `Secrets Store '${store.id}' has no ${name}; nothing to restore into.`,
        }),
      );
    };
    const encryptionKeyId = yield* findSecretId(EncryptionKeySecretName);
    const authTokenId = yield* findSecretId(AuthTokenSecretName);

    const patchSecret = (name: StateStoreSecretName, secretId: string) =>
      SecretsStore.patchStoreSecret({
        accountId,
        storeId: store.id,
        secretId,
        value: secretValues[name],
      }).pipe(
        Effect.andThen(
          Interaction.accessors.output.info(`Restored '${name}'.`),
        ),
      );

    yield* patchSecret(EncryptionKeySecretName, encryptionKeyId);
    yield* patchSecret(AuthTokenSecretName, authTokenId).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message:
              `Restored '${EncryptionKeySecretName}', but writing ` +
              `'${AuthTokenSecretName}' failed. Run the restore again; a ` +
              "repeat is safe.",
            cause,
          }),
      ),
    );

    const profileName = yield* currentProfileName;
    const credStore = yield* CredentialsStore;
    yield* credStore.delete(profileName, CREDENTIALS_FILE);
  },
);

const writeCredentials = (url: string, authToken: string) =>
  Effect.gen(function* () {
    const profileName = yield* currentProfileName;
    const credStore = yield* CredentialsStore;
    const { accountId } =
      yield* yield* CloudflareEnvironment.CloudflareEnvironment;
    yield* credStore.write(
      profileName,
      CREDENTIALS_FILE,
      StoredStateStoreCredentials,
      {
        url,
        authToken,
        accountId,
      },
    );
  });

const isWorkersPreviewConfigurationError = (error: unknown) =>
  error instanceof EdgeSessionError &&
  (error.message.includes("Invalid Workers Preview configuration") ||
    error.message.includes("Error 1031"));

/**
 * Edge-preview reads are flaky in ways that clear up on their own:
 * the workers.dev edge can serve a generic Cloudflare 400/502 HTML
 * page while preview routing propagates ("Secret probe returned
 * ..."), the session-create call can hit transient API blips, and the
 * probe fetch can fail at the transport level ("fetch failed").
 * Retry everything except causes that are clearly permanent
 * (bad credentials, invalid routes).
 *
 * @internal exported for unit testing.
 */
export const isTransientEdgeSessionError = (error: unknown): boolean => {
  if (!(error instanceof EdgeSessionError)) return false;
  // Non-200 probe responses are edge-propagation flakes, not client bugs.
  if (error.message.startsWith("Secret probe returned")) return true;
  const tag = (error.cause as { _tag?: unknown } | undefined)?._tag;
  if (
    typeof tag === "string" &&
    (tag.startsWith("Unauthorized") ||
      tag === "Forbidden" ||
      tag === "InvalidRoute" ||
      tag === "AuthError")
  ) {
    return false;
  }
  return true;
};

/**
 * SHA-256 hex digest of the Cloudflare account ID. Used as a stable
 * pseudonymous identifier on telemetry spans so the dashboard can
 * count distinct state-store deployments without leaking the raw
 * accountId. Mirrors the `alchemy.git.origin_hash` pattern in
 * `Telemetry/Attributes.ts`.
 */
const hashAccountId = (accountId: string) =>
  Effect.sync(() =>
    crypto.createHash("sha256").update(accountId).digest("hex"),
  );

/**
 * Best-effort Cloudflare-account-hash annotation on the current span.
 * Resolves the accountId from {@link CloudflareEnvironment} and
 * attaches `alchemy.cloudflare.account_hash` to whichever span is
 * active. Silently no-ops if the environment isn't resolvable so
 * State-store layer construction still succeeds in degraded paths.
 *
 * `noTrack` controls whether the hash is attached:
 *   - `true`  — never annotate (caller-level opt-out).
 *   - `false` — always annotate, regardless of env.
 *   - `undefined` — fall back to the `NO_TRACK` env var; default off.
 */
const annotateAccountHash = (noTrack?: boolean) =>
  Effect.gen(function* () {
    if (noTrack === true) return;
    if (noTrack === undefined) {
      const fromEnv = yield* Config.boolean("NO_TRACK").pipe(
        Config.withDefault(false),
      );
      if (fromEnv) return;
    }
    const env = yield* Effect.serviceOption(
      CloudflareEnvironment.CloudflareEnvironment,
    );
    if (env._tag !== "Some") return;
    const hash = yield* hashAccountId((yield* env.value).accountId);
    yield* Effect.annotateCurrentSpan("alchemy.cloudflare.account_hash", hash);
  }).pipe(Effect.catch(() => Effect.void));
