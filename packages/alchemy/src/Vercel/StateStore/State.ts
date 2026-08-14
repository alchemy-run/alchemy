import * as projects from "@distilled.cloud/vercel/projects";
import {
  createStorageStoreConnection,
  deleteStorageStoreConnection,
  deleteStorageStoresBlobById,
  getStorageStoreConnections,
  getStorageStores,
} from "@distilled.cloud/vercel/storage";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { isHttpClientError } from "effect/unstable/http/HttpClientError";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import { adopt } from "../../AdoptPolicy.ts";
import { AlchemyContext } from "../../AlchemyContext.ts";
import { AuthError } from "../../Auth/AuthProvider.ts";
import { CredentialsStore } from "../../Auth/Credentials.ts";
import { ALCHEMY_PROFILE } from "../../Auth/Profile.ts";
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
import { State, type StateService } from "../../State/State.ts";
import {
  recordStateStoreInit,
  recordStateStoreOp,
} from "../../Telemetry/Metrics.ts";
import * as Clank from "../../Util/Clank.ts";
import {
  DEFAULT_BLOB_API_URL,
  deleteBlobsRaw,
  listBlobsRaw,
  type BlobScope,
} from "../Blob/BlobHttp.ts";
import type { BlobStoreAccess } from "../Blob/BlobStore.ts";
import { BLOB_TOKEN_ENV } from "../Blob/BlobTypes.ts";
import {
  deleteProjectByIdOrName,
  ensureProject,
  observeProject,
  readAssignedProductionUrl,
  readProductionUrl,
} from "../Deploy/Engine.ts";
import * as VercelProviders from "../Providers.ts";
import { VercelEnvironment } from "../VercelEnvironment.ts";
import Api, { STATE_STORE_PROJECT_NAME, STATE_STORE_VERSION } from "./Api.ts";
import {
  CREDENTIALS_FILE,
  isStateStoreCredentialsStale,
  type StoredStateStoreCredentials,
} from "./CredentialsFile.ts";
import {
  EncryptionKeyValue,
  STATE_ENCRYPTION_KEY_ENV,
  STATE_TOKEN_ENV,
  TokenValue,
} from "./Token.ts";

const CI = Config.boolean("CI").pipe(Config.withDefault(false));

/** Alchemy stack name of the self-deployed state store. */
export const STATE_STORE_STACK = "VercelStateStore" as const;

/**
 * Vercel-hosted state store: a self-deployed Vercel Function
 * (`alchemy-state`) implementing the shared HTTP state contract over a
 * private Blob store (one AES-CTR-encrypted JSON blob per state row).
 *
 * On first use the layer deploys the store via alchemy's own Vercel
 * deploy engine (prompting, or automatically with `--yes` / in CI via
 * `alchemy vercel bootstrap`), caches `{ url, authToken }` under
 * `~/.alchemy/credentials/{profile}/vercel-state.json`, and detects
 * contract drift through the store's unauthenticated `/version` probe.
 * If the local credentials cache is lost, the bearer token is recovered
 * out-of-band from the state project's `encrypted`
 * `ALCHEMY_STATE_TOKEN` env var via the management API.
 *
 * @resource
 *
 * @section Using the Vercel State Store
 * Pass `Vercel.state()` as the `state` option of a Stack.
 *
 * @example Stack backed by the Vercel state store
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Vercel from "alchemy/Vercel";
 * import * as Effect from "effect/Effect";
 *
 * export default Alchemy.Stack(
 *   "my-stack",
 *   { providers: Vercel.providers(), state: Vercel.state() },
 *   Effect.gen(function* () {
 *     // ...
 *   }),
 * );
 * ```
 *
 * @section Bootstrapping from CI
 * The interactive deploy prompt only appears in local runs. In CI,
 * deploy or upgrade the store explicitly (or pass `--yes` to deploy):
 *
 * @example Deploy the store non-interactively
 * ```sh
 * alchemy vercel bootstrap --profile ci
 * ```
 */
export const state = () =>
  Layer.effect(
    State,
    Effect.gen(function* () {
      const isCI = yield* CI;
      const projectName = STATE_STORE_PROJECT_NAME;
      const profileName = yield* ALCHEMY_PROFILE;
      const localStage = `${profileName}_${projectName}`;
      const credStore = yield* CredentialsStore;
      // `deploy --yes` flows in here (via AlchemyContext.updateStateStore) to
      // auto-accept an out-of-date state store upgrade instead of prompting.
      const autoUpdateStateStore =
        Option.getOrUndefined(yield* Effect.serviceOption(AlchemyContext))
          ?.updateStateStore ?? false;
      const context = yield* Effect.context<Effect.Services<typeof init>>();

      const init = Effect.gen(function* () {
        if (yield* hasLocalStack(localStage)) {
          // A local bootstrap stack still exists — the previous bootstrap
          // never finished hoisting; resume it.
          return yield* deployWithLocalState({
            projectName,
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
                  message: `Vercel State Store '${projectName}' is not available. Do you want to deploy it?`,
                }));
              if (shouldDeploy) {
                return yield* bootstrap({ profile: profileName });
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
                `Vercel State Store '${projectName}' is out of date ` +
                  `(expected v${expected}, observed v${observed ?? "unknown"}); upgrading...`,
              );
              const stateStoreOptions = yield* deployStateStore({
                stage: projectName,
                profileName,
                state: httpState,
                force: false,
              });
              return yield* makeVercelStateStore(stateStoreOptions);
            });

            if (autoUpdateStateStore) {
              return yield* upgrade;
            } else if (isCI) {
              return yield* Effect.die(
                new AuthError({
                  message:
                    `Vercel State store is out of date ` +
                    `(expected v${expected}, observed v${observed ?? "unknown"}). ` +
                    `Run 'alchemy vercel bootstrap --profile <your-ci-profile>' to upgrade it first, or pass --yes.`,
                }),
              );
            } else {
              const shouldDeploy = yield* Clank.confirm({
                message:
                  `Vercel State Store '${projectName}' is out of date ` +
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
                `Vercel State store authentication failed, refreshing credentials...`,
              );
              const refreshed = yield* loginWithVercel(profileName, true);
              if (!(yield* checkHttpStateStoreAuth(refreshed))) {
                return yield* Effect.die(
                  new AuthError({
                    message: `Vercel State store authentication failed, after refreshing credentials.`,
                  }),
                );
              }
              return yield* makeVercelStateStore(refreshed);
            }
            return yield* makeVercelStateStore(credentials);
          });

        const { teamId } = yield* VercelEnvironment.current;

        const credentials = yield* credStore.read<StoredStateStoreCredentials>(
          profileName,
          CREDENTIALS_FILE,
        );
        if (credentials) {
          // The cached `url`/`authToken` are minted per-team. If the active
          // team changed since they were written, trusting the cache would
          // silently read/write state in the wrong team — discard and
          // re-derive from the current scope.
          if (isStateStoreCredentialsStale(credentials, teamId)) {
            yield* Clank.info(
              `Vercel State Store credentials were minted for a different ` +
                `Vercel team; re-deriving for the current scope.`,
            );
            yield* credStore
              .delete(profileName, CREDENTIALS_FILE)
              .pipe(Effect.ignore);
          } else {
            return yield* ensureLatest(credentials);
          }
        }
        if (yield* isStateStoreServing()) {
          return yield* ensureLatest(
            yield* loginWithVercel(profileName, false),
          );
        } else if (autoUpdateStateStore) {
          // `--yes`: deploy the missing state store automatically (also CI).
          return yield* bootstrap({ profile: profileName });
        } else if (isCI) {
          return yield* Effect.die(
            new AuthError({
              message: `Vercel State store not found. Run 'alchemy vercel bootstrap --profile <your-ci-profile>' to deploy it first, or pass --yes.`,
            }),
          );
        } else {
          return yield* Clank.confirm({
            message: "Vercel State Store not found. Do you want to deploy it?",
          }).pipe(
            Effect.flatMap((shouldDeploy) =>
              shouldDeploy
                ? bootstrap({ profile: profileName })
                : Effect.die(new Clank.PromptCancelled()),
            ),
          );
        }
      }).pipe(recordStateStoreInit, Effect.orDie);

      return yield* Effect.cached(init.pipe(Effect.provideContext(context)));
    }),
  ).pipe(
    // The Vercel API foundation shared with `providers()` — credentials,
    // environment (team scope), auth, profile + credential store, HTTP
    // client. `provide` (not `provideMerge`) so the foundation stays out
    // of this layer's public type.
    Layer.provide(VercelProviders.VercelApiLive()),
    Layer.orDie,
  );

export interface BootstrapOptions {
  /**
   * Override the state-store project name. Advanced: the deployed
   * Function's project name is pinned to
   * {@link STATE_STORE_PROJECT_NAME} (set `ALCHEMY_VERCEL_STATE_PROJECT`
   * to change both consistently).
   * @default "alchemy-state"
   */
  projectName?: string;
  /** @default false */
  force?: boolean;
  /** @default "default" */
  profile?: string;
}

/**
 * Deploy (or upgrade) the Vercel state store: the `alchemy vercel
 * bootstrap` entrypoint. Non-interactive — resumes an interrupted
 * bootstrap, adopts an already-serving store (refreshing credentials),
 * and otherwise deploys with local state and hoists it into the newly
 * deployed store.
 */
export const bootstrap = (options: BootstrapOptions = {}) =>
  Effect.gen(function* () {
    const isCI = yield* CI;
    const profileName = options.profile ?? (yield* ALCHEMY_PROFILE);
    const projectName = options.projectName ?? STATE_STORE_PROJECT_NAME;
    const force = options.force ?? false;
    const localStage = `${profileName}_${projectName}`;
    yield* Effect.annotateCurrentSpan({
      "alchemy.state_store.project_name": projectName,
      "alchemy.state_store.profile": profileName,
      "alchemy.state_store.force": force,
      "alchemy.state_store.ci": isCI,
    });

    if (yield* hasLocalStack(localStage)) {
      // A local stack that wasn't hoisted — finish the bootstrap.
      yield* Clank.info(
        `Resuming Vercel State Store '${projectName}' deployment...`,
      );
      return yield* deployWithLocalState({
        projectName,
        profileName,
        isCI,
        force,
      }).pipe(
        Effect.tap(() =>
          Clank.success(`Vercel State Store '${projectName}' is ready.`),
        ),
      );
    }
    if (yield* isStateStoreServing()) {
      // Regular update: check version drift and refresh credentials.
      if (!force) {
        yield* Clank.info(
          `Vercel project '${projectName}' already serves a state store; ` +
            `adopting and refreshing credentials. Use --force to redeploy.`,
        );
      }
      const { url, authToken } = yield* loginWithVercel(profileName, true);
      const { matches, expected, observed } =
        yield* checkStateStoreVersion(url);
      const httpState = yield* makeVercelStateStore({ url, authToken });
      if (!matches || force) {
        if (matches && force) {
          yield* Clank.info(
            `Vercel State Store '${projectName}' is up to date; force redeploying...`,
          );
        } else {
          yield* Clank.info(
            `Vercel State Store '${projectName}' is out of date ` +
              `(expected v${expected}, observed v${observed ?? "unknown"}); redeploying...`,
          );
        }
        return yield* makeVercelStateStore(
          yield* deployStateStore({
            stage: projectName,
            profileName,
            state: httpState,
            force,
          }),
        );
      } else {
        return httpState;
      }
    } else {
      yield* Clank.info(`Deploying Vercel State Store '${projectName}'...`);
      return yield* deployWithLocalState({
        projectName,
        profileName,
        isCI,
        force,
      }).pipe(
        Effect.tap(() =>
          Clank.success(`Vercel State Store '${projectName}' is ready.`),
        ),
      );
    }
  }).pipe(
    Effect.withSpan("state_store.bootstrap", {
      attributes: {
        "alchemy.state_store.op": "bootstrap",
        "alchemy.state_store.project_name":
          options.projectName ?? STATE_STORE_PROJECT_NAME,
      },
    }),
  );

export interface TeardownOptions {
  /** @default "alchemy-state" */
  projectName?: string;
  /** @default "default" */
  profile?: string;
}

/**
 * The inverse of {@link bootstrap}: tear down the Vercel-deployed state
 * store. Deletes the state-store project (and with it every deployment
 * and the injected env vars), disconnects and deletes the private Blob
 * store (and with it every state row), and drops the locally cached
 * state-store credentials plus any leftover local bootstrap state.
 *
 * Idempotent — missing resources are treated as already-gone.
 */
export const teardownStateStore = (options: TeardownOptions = {}) =>
  Effect.gen(function* () {
    const profileName = options.profile ?? (yield* ALCHEMY_PROFILE);
    const projectName = options.projectName ?? STATE_STORE_PROJECT_NAME;
    const { teamId } = yield* VercelEnvironment.current;

    yield* Effect.annotateCurrentSpan({
      "alchemy.state_store.project_name": projectName,
      "alchemy.state_store.profile": profileName,
    });

    // 1. Drop cached credentials + any leftover local bootstrap stack
    //    FIRST: a cloud-side failure below must never leave a stale local
    //    bootstrap stack behind (a later bootstrap would "resume" it and
    //    plan noops against resources this teardown deletes).
    const credStore = yield* CredentialsStore;
    yield* credStore.delete(profileName, CREDENTIALS_FILE).pipe(Effect.ignore);
    const localState = yield* makeLocalState();
    yield* localState
      .deleteStack({
        stack: STATE_STORE_STACK,
        stage: `${profileName}_${projectName}`,
      })
      .pipe(Effect.ignore);

    // 2. Empty + delete the private Blob store BEFORE deleting the
    //    project: Vercel refuses to delete a non-empty store (409
    //    `not_empty`), and purging blobs needs the data-plane token that
    //    only a project connection injects — harvested through the state
    //    project while it still exists.
    const { stores } = yield* getStorageStores({ teamId });
    const store = stores.find(
      (row) => row.type === "blob" && row.name === projectName,
    );
    if (store !== undefined) {
      yield* Clank.info(
        `Purging and deleting state store blob store '${store.id}'...`,
      );
      yield* purgeAndDeleteStore({
        storeId: store.id,
        access: store.access as BlobStoreAccess,
        projectName,
      });
    }

    // 3. Delete the state-store project (deployments + env rows go with it).
    const project = yield* observeProject(projectName);
    if (project !== undefined) {
      yield* Clank.info(`Deleting state store project '${projectName}'...`);
      yield* deleteProjectByIdOrName(project.id);
    } else {
      yield* Clank.info(`  Project '${projectName}' not found (already gone).`);
    }

    yield* Clank.success(`Vercel State Store '${projectName}' torn down.`);
  }).pipe(
    Effect.withSpan("state_store.teardown", {
      attributes: {
        "alchemy.state_store.op": "teardown",
        "alchemy.state_store.project_name":
          options.projectName ?? STATE_STORE_PROJECT_NAME,
      },
    }),
  );

/**
 * Read a project's platform-injected `BLOB_READ_WRITE_TOKEN` via the
 * management API's single-env GET (the injected row is `encrypted`, so
 * the GET returns the plaintext). Bounded retry — injection can lag the
 * connect call by a moment.
 */
const readBlobTokenFromProject = (projectId: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* VercelEnvironment.current;
    const envsBody = yield* projects.filterProjectEnvs({
      idOrName: projectId,
      teamId,
    });
    const rows = (
      Array.isArray(envsBody)
        ? envsBody
        : typeof envsBody === "object" &&
            envsBody !== null &&
            "envs" in envsBody
          ? (envsBody as { envs: unknown[] }).envs
          : []
    ) as Array<{ key?: string; id?: string }>;
    const tokenRow = rows.find((row) => row.key === BLOB_TOKEN_ENV);
    if (tokenRow?.id === undefined) return undefined;
    const decrypted = yield* projects.getProjectEnv({
      idOrName: projectId,
      id: tokenRow.id,
      teamId,
    });
    return typeof decrypted === "object" &&
      decrypted !== null &&
      "value" in decrypted &&
      typeof decrypted.value === "string" &&
      decrypted.value !== ""
      ? decrypted.value
      : undefined;
  });

class BlobTokenNotInjected extends Error {
  readonly _tag = "BlobTokenNotInjected";
}

/**
 * Empty a state blob store via the data plane, then disconnect every
 * project and delete the store. The data-plane token is harvested
 * through the state project's connection (re-creating it if needed),
 * falling back to a throwaway `-reaper` project when the state project
 * is already gone.
 */
const purgeAndDeleteStore = ({
  storeId,
  access,
  projectName,
}: {
  storeId: string;
  access: BlobStoreAccess;
  projectName: string;
}) =>
  Effect.gen(function* () {
    const { teamId } = yield* VercelEnvironment.current;

    // 1. A project to harvest the injected data-plane token from.
    let project = yield* observeProject(projectName);
    let reaper = false;
    if (project === undefined) {
      reaper = true;
      project = yield* ensureProject({ name: `${projectName}-reaper` });
    }

    // 2. Ensure the project is connected (the connect injects the token).
    const observed = yield* getStorageStoreConnections({
      storeId,
      teamId,
    }).pipe(
      Effect.catchTag("NotFound", () =>
        Effect.succeed({
          connections: [] as Array<{ id: string; projectId: string }>,
        }),
      ),
    );
    if (
      !observed.connections.some(
        (connection) => connection.projectId === project.id,
      )
    ) {
      yield* createStorageStoreConnection({
        storeId,
        projectId: project.id,
        envVarEnvironments: ["production", "preview", "development"],
        type: "integration",
        teamId,
      }).pipe(
        // Already-connected race (`store_project_connection_not_unique`):
        // trust observation.
        Effect.catchTag("BadRequest", (error) =>
          getStorageStoreConnections({ storeId, teamId }).pipe(
            Effect.flatMap((after) =>
              after.connections.some(
                (connection) => connection.projectId === project.id,
              )
                ? Effect.void
                : Effect.fail(error),
            ),
          ),
        ),
      );
    }

    // 3. Read the injected token (bounded retry — injection can lag).
    const token = yield* readBlobTokenFromProject(project.id).pipe(
      Effect.flatMap((value) =>
        value === undefined
          ? Effect.fail(new BlobTokenNotInjected())
          : Effect.succeed(value),
      ),
      Effect.retry({
        while: (error) => error instanceof BlobTokenNotInjected,
        schedule: Schedule.max([
          Schedule.spaced("1 second"),
          Schedule.recurs(15),
        ]),
      }),
    );

    // 4. Purge every blob (batched by page; bounded).
    const scope: BlobScope = {
      token: Redacted.make(token),
      storeId,
      access,
      apiUrl: DEFAULT_BLOB_API_URL,
    };
    for (let page = 0; page < 100; page++) {
      const listed = yield* listBlobsRaw(scope, { limit: 1000 });
      if (listed.blobs.length === 0) break;
      // Delete by canonical URL so re-encoding pathnames can't mismatch.
      yield* deleteBlobsRaw(
        scope,
        listed.blobs.map((row) => row.url),
      );
      if (!listed.hasMore) break;
    }

    // 5. Disconnect everything and delete the store.
    const remaining = yield* getStorageStoreConnections({
      storeId,
      teamId,
    }).pipe(
      Effect.catchTag("NotFound", () =>
        Effect.succeed({
          connections: [] as Array<{ id: string; projectId: string }>,
        }),
      ),
    );
    for (const connection of remaining.connections) {
      yield* deleteStorageStoreConnection({
        storeId,
        connectionId: connection.id,
        teamId,
      }).pipe(Effect.catchTag("NotFound", () => Effect.void));
    }
    yield* deleteStorageStoresBlobById({ id: storeId, teamId }).pipe(
      Effect.catchTag("NotFound", () => Effect.void),
    );

    // 6. Reap the throwaway project.
    if (reaper) {
      yield* deleteProjectByIdOrName(project.id);
    }
  }).pipe(
    Effect.withSpan("state_store.purge_store", {
      attributes: { "alchemy.state_store.op": "purge_store" },
    }),
  );

/**
 * Deploy the state-store stack (Function + private Blob store + the two
 * persisted Random secrets) with the given backing state, write the
 * refreshed credentials, and block until `/version` serves the version
 * this CLI was built against.
 */
const deployStateStore = ({
  stage,
  profileName,
  state,
  force,
}: {
  stage: string;
  profileName: string;
  state: StateService;
  force?: boolean;
}) =>
  Effect.gen(function* () {
    const stateLayer = Layer.succeed(State, Effect.succeed(state));
    const { url, authToken } = yield* deploy({
      // the project name doubles as the stage so multiple stores coexist
      stage,
      force,
      stack: Alchemy.Stack(
        STATE_STORE_STACK,
        {
          providers: Layer.mergeAll(
            VercelProviders.providers(),
            RandomProvider(),
          ),
          state: stateLayer,
        },
        Effect.gen(function* () {
          const token = yield* TokenValue;
          const key = yield* EncryptionKeyValue;
          const api = yield* Api;

          // Deliver the bearer token + AES key as `encrypted` project env
          // vars (plain strings — NOT Redacted/sensitive) so
          // `loginWithVercel` can recover them out-of-band via the
          // management API's single-env GET when the local cache is lost.
          yield* api.bind("StateStoreSecrets", {
            env: {
              [STATE_TOKEN_ENV]: token.text.pipe(Output.map(Redacted.value)),
              [STATE_ENCRYPTION_KEY_ENV]: key.text.pipe(
                Output.map(Redacted.value),
              ),
            },
          });

          return {
            url: api.url.as<string>(),
            authToken: token.text.pipe(Output.map(Redacted.value)),
          };
        }),
      ),
    }).pipe(
      // The state store is team-level infrastructure that outlives any
      // single deploy: its project and Blob store may already exist from a
      // previous (possibly partially-failed) bootstrap. Opt in to adoption
      // so the resources reconcile in place instead of failing on conflict.
      adopt(true),
      Effect.provide(stateLayer),
    );

    yield* writeCredentials(profileName, url, authToken);

    // Block until the freshly deployed function serves the expected
    // /version — downstream steps (hoisting local state, adoption version
    // probes) must not race edge propagation of the new deployment.
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

/**
 * Greenfield bootstrap: deploy the store with LOCAL state under a
 * profile-scoped stage, then hoist that state into the deployed store
 * itself and delete the local copy.
 */
const deployWithLocalState = ({
  projectName,
  profileName,
  isCI,
  force,
}: {
  projectName: string;
  profileName: string;
  isCI: boolean;
  force: boolean;
}) =>
  Effect.gen(function* () {
    const localState = yield* makeLocalState();
    const localStage = `${profileName}_${projectName}`;
    const remoteStage = projectName;
    const { url, authToken } = yield* deployStateStore({
      stage: localStage,
      profileName,
      state: localState,
      force,
    });
    const httpState = yield* makeVercelStateStore({ url, authToken });

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
      stack: STATE_STORE_STACK,
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
 * Writes against a just-deployed state-store function can fail
 * transiently while Vercel propagates the deployment:
 *
 * - 404 — the production alias isn't serving the new deployment yet
 * - 401 — the function is up but its env binding hasn't landed on the
 *   serving deployment yet
 * - 5xx / transport errors — cold-start blips
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

/** Is there a local bootstrap stack that wasn't properly hoisted? */
const hasLocalStack = (stage: string) =>
  Effect.gen(function* () {
    const localState = yield* makeLocalState();
    return yield* Effect.map(
      localState.listStages(STATE_STORE_STACK),
      // key off the profile name to avoid conflicts with other profiles
      (stages) => stages.includes(stage),
    );
  });

/**
 * Non-destructively copy every resource in the bootstrap stack from
 * `source` into `destination`, leaving every other stack in
 * `destination` untouched (the destination is the user's live remote
 * store — deleting entries missing locally would be catastrophic).
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
  const stack = STATE_STORE_STACK;
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
              // Bounded at ~30s: propagation of the fresh deployment can
              // take a while; anything persisting past that is a real
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
 * Recover `{ url, authToken }` for the deployed state store from the
 * management API alone (no local state): find the deterministic
 * `alchemy-state` project, read the bearer token back from its
 * `encrypted` `ALCHEMY_STATE_TOKEN` env row (Vercel's single-env GET
 * returns the plaintext of `encrypted` rows), and read back the
 * project's production URL. Persists the credentials for the profile
 * (outside CI).
 */
export const loginWithVercel = (profileName: string, force: boolean) =>
  Effect.gen(function* () {
    const credStore = yield* CredentialsStore;
    const isCI = yield* CI;
    const { teamId } = yield* VercelEnvironment.current;

    if (!force) {
      const credentials = yield* credStore.read<StoredStateStoreCredentials>(
        profileName,
        CREDENTIALS_FILE,
      );
      if (credentials && !isStateStoreCredentialsStale(credentials, teamId)) {
        return credentials;
      }
    }

    const project = yield* observeProject(STATE_STORE_PROJECT_NAME);
    if (project === undefined) {
      return yield* Effect.fail(
        new AuthError({
          message: `No Vercel project '${STATE_STORE_PROJECT_NAME}' found in this scope. Deploy the state store first ('alchemy vercel bootstrap').`,
        }),
      );
    }

    const envsBody = yield* projects.filterProjectEnvs({
      idOrName: project.id,
      teamId,
    });
    const rows = (
      Array.isArray(envsBody)
        ? envsBody
        : typeof envsBody === "object" &&
            envsBody !== null &&
            "envs" in envsBody
          ? (envsBody as { envs: unknown[] }).envs
          : []
    ) as Array<{ key?: string; id?: string }>;
    const tokenRow = rows.find((row) => row.key === STATE_TOKEN_ENV);
    if (tokenRow?.id === undefined) {
      return yield* Effect.fail(
        new AuthError({
          message:
            `Vercel project '${STATE_STORE_PROJECT_NAME}' has no ${STATE_TOKEN_ENV} env var — ` +
            `it does not look like a state store deployment. Re-run 'alchemy vercel bootstrap --force'.`,
        }),
      );
    }
    const decrypted = yield* projects.getProjectEnv({
      idOrName: project.id,
      id: tokenRow.id,
      teamId,
    });
    const authToken =
      typeof decrypted === "object" &&
      decrypted !== null &&
      "value" in decrypted &&
      typeof decrypted.value === "string"
        ? decrypted.value
        : undefined;
    if (authToken === undefined || authToken === "") {
      return yield* Effect.fail(
        new AuthError({
          message: `Failed to read the ${STATE_TOKEN_ENV} value from Vercel project '${STATE_STORE_PROJECT_NAME}'.`,
        }),
      );
    }

    const url =
      readProductionUrl(project) ??
      (yield* readAssignedProductionUrl(project.id));
    if (url === undefined) {
      return yield* Effect.fail(
        new AuthError({
          message: `Vercel project '${STATE_STORE_PROJECT_NAME}' has no production URL to reach the state store at.`,
        }),
      );
    }

    const credentials: StoredStateStoreCredentials = {
      url,
      authToken: authToken.trim(),
      ...(teamId !== undefined ? { teamId } : {}),
    };

    if (!isCI) {
      yield* credStore
        .write<StoredStateStoreCredentials>(
          profileName,
          CREDENTIALS_FILE,
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
      yield* Clank.success(
        `Vercel state store credentials saved for '${profileName}'.`,
      );
      yield* Clank.info(`  url:     ${url}`);
    }

    return credentials;
  }).pipe(
    Effect.withSpan("state_store.login", {
      attributes: {
        "alchemy.state_store.op": "login",
        "alchemy.state_store.project_name": STATE_STORE_PROJECT_NAME,
      },
    }),
  );

/**
 * Does this scope have a functioning state-store function, verified by
 * probing the /version endpoint of the deterministic project's
 * production URL?
 */
const isStateStoreServing = () =>
  Effect.gen(function* () {
    const project = yield* observeProject(STATE_STORE_PROJECT_NAME).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (project === undefined) return false;
    const url =
      readProductionUrl(project) ??
      (yield* readAssignedProductionUrl(project.id).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      ));
    if (url === undefined) return false;
    const { observed } = yield* checkStateStoreVersion(url);
    return observed !== undefined;
  });

const makeVercelStateStore = Effect.fn(function* ({
  url,
  authToken,
}: {
  url: string;
  authToken: string;
}) {
  return yield* makeHttpStateStore({
    url,
    authToken,
    id: "vercel-http",
  });
});

class StateStoreVersionNotReady extends Error {
  readonly _tag = "StateStoreVersionNotReady";
  constructor(
    readonly expected: number,
    readonly observed: number | undefined,
  ) {
    super(
      `Vercel State Store version not ready (expected v${expected}, observed v${observed ?? "unknown"}).`,
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
      while: (error) => error instanceof StateStoreVersionNotReady,
      // Alias propagation is usually fast, but poll for ~30s before
      // failing loudly.
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

const checkStateStoreVersion = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpApiClient.make(StateApi, { baseUrl: url });
    const isAvailable = yield* Effect.cached(
      observeProject(STATE_STORE_PROJECT_NAME).pipe(
        Effect.map((project) => project !== undefined),
        Effect.catch(() => Effect.succeed(false)),
      ),
    );
    // The /version route can 404 transiently right after a deploy while
    // the production alias moves over, and can blip at the transport
    // level. Retry the probe for ~10s before collapsing to `undefined`
    // (which callers treat as "not serving").
    const result = yield* client.version.getVersion().pipe(
      Effect.catchTag("HttpClientError", (e) =>
        e.response?.status === 404
          ? isAvailable.pipe(
              Effect.flatMap((available) =>
                // Project exists → assume propagation and retry; no
                // project → there is no store, report unknown.
                available ? Effect.fail(e) : Effect.succeed(undefined),
              ),
            )
          : Effect.fail(e),
      ),
      Effect.retry({
        schedule: Schedule.max([
          Schedule.spaced("250 millis"),
          Schedule.recurs(40),
        ]),
      }),
      Effect.catch(() => Effect.succeed(undefined)),
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

const writeCredentials = (
  profileName: string,
  url: string,
  authToken: string,
) =>
  Effect.gen(function* () {
    const isCI = yield* CI;
    // CI file systems are ephemeral — don't bother persisting there.
    if (isCI) return;
    const credStore = yield* CredentialsStore;
    const { teamId } = yield* VercelEnvironment.current;
    yield* credStore.write<StoredStateStoreCredentials>(
      profileName,
      CREDENTIALS_FILE,
      {
        url,
        authToken,
        ...(teamId !== undefined ? { teamId } : {}),
      },
    );
  });
