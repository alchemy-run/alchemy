import * as SecretsStore from "@distilled.cloud/cloudflare/secrets-store";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
import { ALCHEMY_PROFILE } from "../../Auth/Profile.ts";
import * as Cloudflare from "../../Cloudflare/Providers.ts";
import { deploy } from "../../Deploy.ts";
import * as Output from "../../Output.ts";
import { RandomProvider } from "../../Random.ts";
import * as Alchemy from "../../Stack.ts";
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
import * as Clank from "../../Util/Clank.ts";
import * as Access from "../Access.ts";
import * as CloudflareEnvironment from "../CloudflareEnvironment.ts";
import { EdgeSessionError, createEdgeSession } from "../EdgeSession.ts";
import Api, { STATE_STORE_SCRIPT_NAME, STATE_STORE_VERSION } from "./Api.ts";
import {
  CREDENTIALS_FILE,
  type StoredStateStoreCredentials,
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
      const profileName = yield* ALCHEMY_PROFILE;
      const localStage = `${profileName}_${scriptName}`;
      const credStore = yield* CredentialsStore;
      // `deploy --yes` sets `updateStateStore`. Callers without an
      // AlchemyContext keep the prompt.
      const autoUpdateStateStore =
        Option.getOrUndefined(yield* Effect.serviceOption(AlchemyContext))
          ?.updateStateStore ?? false;
      const context = yield* Effect.context<Effect.Services<typeof init>>();

      const init = Effect.gen(function* () {
        if (yield* hasLocalStack(localStage)) {
          // A local stack means an earlier bootstrap did not finish.
          return yield* deployWithLocalState({
            scriptName,
            profileName,
            isCI,
            force: false,
          });
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
                (yield* Clank.confirm({
                  message: `Cloudflare State Store '${scriptName}' is not available. Do you want to deploy it?`,
                }));
              if (shouldDeploy) {
                return yield* bootstrap({
                  workerName: scriptName,
                  profile: profileName,
                });
              } else {
                return yield* Effect.die(new Clank.PromptCancelled());
              }
            }

            const httpState = yield* ensureAccess({ url, authToken });
            if (matches) {
              return httpState;
            }

            // The store is out of date. Upgrade it in place.
            const upgrade = Effect.gen(function* () {
              yield* Clank.info(
                `Cloudflare State Store '${scriptName}' is out of date ` +
                  `(expected v${expected}, observed v${observed ?? "unknown"}); upgrading...`,
              );
              const stateStoreOptions = yield* deployStateStore({
                stage: scriptName,
                state: httpState,
                force: false,
              });
              return yield* makeCloudflareStateStore(stateStoreOptions);
            });

            if (autoUpdateStateStore) {
              // `--yes`: upgrade automatically (also unblocks CI).
              return yield* upgrade;
            } else if (isCI) {
              return yield* Effect.die(
                new AuthError({
                  message:
                    `Cloudflare State store is out of date ` +
                    `(expected v${expected}, observed v${observed ?? "unknown"}). ` +
                    `Run 'alchemy bootstrap cloudflare --profile <your-ci-profile>' to upgrade it first, or pass --yes.`,
                }),
              );
            } else {
              const shouldDeploy = yield* Clank.confirm({
                message:
                  `Cloudflare State Store '${scriptName}' is out of date ` +
                  `(expected v${expected}, observed v${observed ?? "unknown"})`,
              });
              if (shouldDeploy) {
                return yield* upgrade;
              } else {
                return yield* Effect.die(new Clank.PromptCancelled());
              }
            }
          });

        const ensureAccess = (credentials: HttpStateStoreCredentials) =>
          Effect.gen(function* () {
            const isAuth = yield* checkHttpStateStoreAuth(credentials);
            if (!isAuth) {
              // our token is wrong, force a refresh
              yield* Clank.info(
                `Cloudflare State store authentication failed, refreshing credentials...`,
              );
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

        const credentials = yield* credStore.read<StoredStateStoreCredentials>(
          profileName,
          CREDENTIALS_FILE,
        );
        if (credentials) {
          // The cached `url` and `authToken` belong to one account. A
          // cache from a different account would read and write state in
          // the wrong account.
          if (isStateStoreCredentialsStale(credentials, accountId)) {
            yield* Clank.info(
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
        switch (decision) {
          case "login":
            return yield* ensureLatest(
              yield* loginWithCloudflare(profileName, false),
            );
          case "bootstrap":
            return yield* bootstrap();
          case "refuse-ci":
            return yield* Effect.die(
              new AuthError({
                message:
                  "Cloudflare State store not found. A CI deploy does not " +
                  "bootstrap it. Run 'alchemy bootstrap cloudflare --profile " +
                  "<profile>' from a workstation first.",
              }),
            );
          case "prompt": {
            const shouldDeploy = yield* Clank.confirm({
              message:
                "Cloudflare State Store not found. Do you want to deploy it?",
            });
            if (shouldDeploy) {
              return yield* bootstrap();
            }
            return yield* Effect.die(new Clank.PromptCancelled());
          }
        }
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

export const bootstrap = (options: BootstrapOptions = {}) =>
  Effect.gen(function* () {
    const isCI = yield* CI;
    const profileName = options.profile ?? (yield* ALCHEMY_PROFILE);
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
      yield* Clank.info(
        `Resuming Cloudflare State Store '${scriptName}' deployment...`,
      );
      return yield* deployWithLocalState({
        scriptName,
        profileName,
        isCI,
        force,
      }).pipe(
        Effect.tap(() =>
          Clank.success(`Cloudflare State Store '${scriptName}' is ready.`),
        ),
      );
    }
    if (scriptName !== STATE_STORE_SCRIPT_NAME) {
      yield* refuseSecondStateStore(accountId, scriptName);
    }
    if (yield* isStateStoreServing(accountId)) {
      if (!force) {
        yield* Clank.info(
          `Worker '${scriptName}' already exists; adopting and refreshing credentials. ` +
            `Use --force to redeploy.`,
        );
      }
      const credentials = yield* loginWithCloudflare(profileName, true);
      const { url, authToken } = credentials;
      if (!isCI) {
        // The CI file system does not outlive the job.
        const store = yield* CredentialsStore;
        yield* store.write<StoredStateStoreCredentials>(
          profileName,
          CREDENTIALS_FILE,
          credentials,
        );
      }
      const { matches, expected, observed } =
        yield* checkStateStoreVersion(url);
      const httpState = yield* makeCloudflareStateStore({ url, authToken });
      if (!matches || force) {
        if (matches && force) {
          yield* Clank.info(
            `Cloudflare State Store '${scriptName}' is up to date; force redeploying...`,
          );
        } else {
          yield* Clank.info(
            `Cloudflare State Store '${scriptName}' is out of date ` +
              `(expected v${expected}, observed v${observed ?? "unknown"}); redeploying...`,
          );
        }
        return yield* makeCloudflareStateStore(
          yield* deployStateStore({
            stage: scriptName,
            state: httpState,
            force,
          }),
        );
      } else {
        return httpState;
      }
    } else {
      yield* Clank.info(`Deploying Cloudflare State Store '${scriptName}'...`);
      return yield* deployWithLocalState({
        scriptName,
        profileName,
        isCI,
        force,
      }).pipe(
        Effect.tap(() =>
          Clank.success(`Cloudflare State Store '${scriptName}' is ready.`),
        ),
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
    const profileName = options.profile ?? (yield* ALCHEMY_PROFILE);
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
    yield* Clank.info(`Deleting state store worker '${scriptName}'...`);
    yield* workers.deleteScript({ accountId, scriptName, force: true }).pipe(
      Effect.asVoid,
      Effect.catchTag("WorkerNotFound", () =>
        Clank.info(`  Worker '${scriptName}' not found (already gone).`),
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
        yield* Clank.info(`Deleting secret '${secret.name}'...`);
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
        yield* Clank.info(`Deleting empty secrets store '${store.id}'...`);
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
        yield* Clank.info(
          `Secrets store '${store.id}' still has ${remaining} other ` +
            `secret(s); leaving it in place.`,
        );
      }
    }

    // 3. Drop the locally cached state-store credentials for this profile.
    const credStore = yield* CredentialsStore;
    yield* credStore.delete(profileName, CREDENTIALS_FILE).pipe(Effect.ignore);

    yield* Clank.success(`Cloudflare State Store '${scriptName}' torn down.`);
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
        "CloudflareStateStore",
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

const BOOTSTRAP_STACK = "CloudflareStateStore";

/**
 * Logical ids of the `Random` resources in `Token.ts`. Both must match
 * the ids passed to `Random(...)` there.
 */
const BOOTSTRAP_RANDOM_IDS = [
  "StateStoreAuthTokenValue",
  "StateStoreEncryptionKeyValue",
] as const;

/**
 * A fresh bootstrap mints a new token and encryption key. When the
 * secrets already exist, a store was deployed before, and its state
 * becomes unreadable under a new key. A local stack that already holds
 * both random values re-uploads the same values, so it is safe.
 *
 * @internal exported for unit testing.
 */
export const shouldRefuseFreshBootstrap = ({
  hasLocalRandoms,
  force,
  existingNames,
}: {
  hasLocalRandoms: boolean;
  force: boolean;
  existingNames: ReadonlyArray<string>;
}): boolean => {
  if (force) return false;
  if (existingNames.length === 0) return false;
  return !hasLocalRandoms;
};

const findExistingSecretNames = (accountId: string) =>
  findStateStoreSecrets(accountId).pipe(
    Effect.map((existing) => existing.names),
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
    const existingNames = yield* findExistingSecretNames(accountId);
    if (existingNames.length === 0) return;
    return yield* Effect.fail(
      new AuthError({
        message:
          `Cannot deploy a state store named '${scriptName}': secrets ` +
          `${existingNames.join(", ")} already exist in this account, so a ` +
          `'${STATE_STORE_SCRIPT_NAME}' store was deployed before. Every ` +
          "store shares the same secret names, so one Cloudflare State " +
          "Store per account is supported. Use the default worker name.",
      }),
    );
  });

/** True when the local bootstrap stack holds both persisted random values. */
const hasPersistedBootstrapRandoms = (
  localState: StateService,
  stage: string,
) =>
  Effect.gen(function* () {
    const fqns = yield* localState.list({ stack: BOOTSTRAP_STACK, stage });
    for (const id of BOOTSTRAP_RANDOM_IDS) {
      const fqn = fqns.find((candidate) => candidate.split("/").at(-1) === id);
      if (fqn === undefined) return false;
      const persisted = yield* localState.get({
        stack: BOOTSTRAP_STACK,
        stage,
        fqn,
      });
      if (!isResourceState(persisted)) return false;
      if (persisted.attr?.text === undefined) return false;
    }
    return true;
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
      const { accountId } =
        yield* yield* CloudflareEnvironment.CloudflareEnvironment;
      const existingNames = yield* findExistingSecretNames(accountId);
      const hasLocal = yield* hasLocalStack(localStage);
      const hasLocalRandoms =
        hasLocal &&
        (yield* hasPersistedBootstrapRandoms(localState, localStage));
      if (
        shouldRefuseFreshBootstrap({ hasLocalRandoms, force, existingNames })
      ) {
        const existing = existingNames.join(", ");
        if (hasLocal) {
          return yield* Effect.fail(
            new AuthError({
              message:
                `Secrets ${existing} already exist in this account's Secrets ` +
                `Store, but the local bootstrap stack '${localStage}' does not ` +
                "hold their values. Finishing it would mint new values and make " +
                "every stack's state unreadable. Clear the local stack first: " +
                `run 'alchemy state clear --stack ${BOOTSTRAP_STACK} --stage ` +
                `${localStage} --local' or delete ` +
                `'.alchemy/state/${BOOTSTRAP_STACK}/${localStage}'.`,
            }),
          );
        }
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
 * Writes to a just-deployed worker can fail while Cloudflare propagates
 * the script, its route, and its Secrets Store bindings to the edge:
 *
 * - 404: the workers.dev route does not serve the new script yet
 * - 401: the auth-token secret binding is not propagated yet
 * - 5xx: the encryption-key secret binding is not propagated yet
 * - no response: transport failure on a cold workers.dev host
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

/** True when a local bootstrap stack exists for `stage`. */
const hasLocalStack = (stage: string) =>
  Effect.gen(function* () {
    const localState = yield* makeLocalState();
    return yield* Effect.map(localState.listStages(BOOTSTRAP_STACK), (stages) =>
      stages.includes(stage),
    );
  });

/**
 * Copy every resource of the bootstrap stack from `source` into
 * `destination`. Nothing is deleted from `destination`: it is the live
 * remote store.
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
 * Log in to the deployed state store: read the bearer token out of the
 * account's Secrets Store, derive the worker URL from the workers.dev
 * subdomain, and cache both for the profile.
 */
export const loginWithCloudflare = (profileName: string, force: boolean) =>
  Effect.gen(function* () {
    const credStore = yield* CredentialsStore;
    const isCI = yield* CI;
    const { accountId } =
      yield* yield* CloudflareEnvironment.CloudflareEnvironment;

    if (!force) {
      const credentials = yield* credStore.read<StoredStateStoreCredentials>(
        profileName,
        CREDENTIALS_FILE,
      );
      if (
        credentials &&
        !isStateStoreCredentialsStale(credentials, accountId)
      ) {
        return credentials;
      }
    }

    const { store, names } = yield* findStateStoreSecrets(accountId);
    if (!store) {
      return yield* Effect.fail(
        new AuthError({
          message:
            "No Secrets Store found on this account. Deploy the state store first.",
        }),
      );
    }
    if (!names.includes(AuthTokenSecretName)) {
      return yield* Effect.fail(
        new AuthError({
          message:
            `Secrets Store '${store.id}' has no ${AuthTokenSecretName}. ` +
            "Deploy the state store first.",
        }),
      );
    }

    const authToken = yield* readSecretWithRetry(store.id, AuthTokenSecretName);

    const { subdomain } = yield* workers.getSubdomain({ accountId });
    const url = `https://${STATE_STORE_SCRIPT_NAME}.${subdomain}.workers.dev`;

    if (!isCI) {
      yield* credStore
        .write<StoredStateStoreCredentials>(profileName, CREDENTIALS_FILE, {
          url,
          authToken,
          accountId,
        })
        .pipe(
          Effect.mapError(
            (e) =>
              new AuthError({
                message: "Failed to write credentials",
                cause: e,
              }),
          ),
        );

      yield* Clank.success(
        `HTTP state store credentials saved for '${profileName}'.`,
      );
      yield* Clank.info(`  url:     ${url}`);
    }

    return {
      url,
      authToken,
      accountId,
    };
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

/** True when the worker exists and has at least one version. */
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

/**
 * Only a missing workers.dev subdomain proves that no store exists. A
 * permission or transport failure leaves the answer unknown.
 *
 * @internal exported for unit testing.
 */
export const isSubdomainAbsence = (error: { readonly _tag: string }): boolean =>
  error._tag === "SubdomainNotFound" || error._tag === "InvalidRoute";

/** True when the state-store worker answers on `/version`. */
const isStateStoreServing = (accountId: string) =>
  Effect.gen(function* () {
    const url = yield* workers.getSubdomain({ accountId }).pipe(
      Effect.map(({ subdomain }) =>
        subdomain
          ? `https://${STATE_STORE_SCRIPT_NAME}.${subdomain}.workers.dev`
          : undefined,
      ),
      Effect.catchIf(isSubdomainAbsence, () => Effect.succeed(undefined)),
      Effect.mapError(
        (cause) =>
          new AuthError({
            message:
              "Cannot tell whether the Cloudflare State Store exists: the " +
              `workers.dev subdomain lookup failed (${cause._tag}). ` +
              "Refusing to bootstrap. Give the token Workers Scripts read " +
              "access, or run 'alchemy bootstrap cloudflare' from a workstation.",
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
      // The edge can serve the old version, or no version, for a while
      // after a redeploy.
      while: (error) =>
        error instanceof StateStoreVersionNotReady ||
        error._tag === "AuthError",
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
 * answer is unknown, and the probe fails with an AuthError.
 */
const checkStateStoreVersion = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpApiClient.make(StateApi, { baseUrl: url });
    const isAvailable = yield* Effect.cached(
      isStateStoreAvailable(STATE_STORE_SCRIPT_NAME),
    );
    // A 404 on an existing worker is edge propagation after a deploy.
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

/** Worker source for {@link readSecretViaEdge}: it returns `env.SECRET`. */
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
 * Read a Secrets Store value through an edge-preview worker. The REST
 * API never returns secret values; only a worker binding can.
 *
 * `scriptName` must be deployed with workers.dev enabled. The preview
 * token swaps the probe code into an existing route; it does not create
 * one.
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
      schedule: Schedule.max([
        Schedule.min([Schedule.exponential(200), Schedule.spaced("2 seconds")]),
        Schedule.recurs(15),
      ]),
    }),
    Effect.map((value) => value.trim()),
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

/**
 * The account's Secrets Store and the state-store secrets it holds. The
 * API returns names only, never values.
 */
const findStateStoreSecrets = (accountId: string) =>
  Effect.gen(function* () {
    const store = yield* SecretsStore.listStores
      .items({ accountId })
      .pipe(Stream.runHead, Effect.map(Option.getOrUndefined));
    if (!store) return { store: undefined, secrets: [], names: [] };
    const secrets = yield* SecretsStore.listStoreSecrets
      .items({ accountId, storeId: store.id })
      .pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).filter((s) => isStateStoreSecretName(s.name)),
        ),
        Effect.catchTag("StoreNotFound", () => Effect.succeed([])),
      );
    const names = secrets.map((s) => s.name).filter(isStateStoreSecretName);
    return { store, secrets, names };
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
    const { store, names } = yield* findStateStoreSecrets(accountId);
    if (!store) {
      return yield* Effect.fail(
        new AuthError({ message: "No Secrets Store found on this account." }),
      );
    }
    const missing = STATE_STORE_SECRET_NAMES.filter((n) => !names.includes(n));
    if (missing.length > 0) {
      return yield* Effect.fail(
        new AuthError({
          message: `Secrets Store '${store.id}' has no ${missing.join(", ")}.`,
        }),
      );
    }
    const readSecret = (secretName: StateStoreSecretName) =>
      readSecretWithRetry(store.id, secretName);
    const authToken = yield* readSecret(AuthTokenSecretName);
    const encryptionKey = yield* readSecret(EncryptionKeySecretName);
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
      const secret = secrets.find((s) => s.name === name);
      if (secret) return Effect.succeed(secret.id);
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
      }).pipe(Effect.andThen(Clank.info(`Restored '${name}'.`)));

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

    const profileName = yield* ALCHEMY_PROFILE;
    const credStore = yield* CredentialsStore;
    yield* credStore.delete(profileName, CREDENTIALS_FILE);
  },
);

const writeCredentials = (url: string, authToken: string) =>
  Effect.gen(function* () {
    const profileName = yield* ALCHEMY_PROFILE;
    const credStore = yield* CredentialsStore;
    const { accountId } =
      yield* yield* CloudflareEnvironment.CloudflareEnvironment;
    yield* credStore.write<StoredStateStoreCredentials>(
      profileName,
      CREDENTIALS_FILE,
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
 * Edge-preview reads fail in ways that clear up on their own: an HTML
 * error page while preview routing propagates, a session-create blip,
 * or a transport failure. Only auth and route causes are permanent.
 *
 * @internal exported for unit testing.
 */
export const isTransientEdgeSessionError = (error: unknown): boolean => {
  if (!(error instanceof EdgeSessionError)) return false;
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
