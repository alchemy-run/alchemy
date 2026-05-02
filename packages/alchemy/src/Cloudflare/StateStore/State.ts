import * as SecretsStore from "@distilled.cloud/cloudflare/secrets-store";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";

import * as Config from "effect/Config";
import { adopt } from "../../AdoptPolicy.ts";
import { AuthError } from "../../Auth/AuthProvider.ts";
import { readCredentials, writeCredentials } from "../../Auth/Credentials.ts";
import { ALCHEMY_PROFILE } from "../../Auth/Profile.ts";
import * as Cloudflare from "../../Cloudflare/Providers.ts";
import { deploy } from "../../Deploy.ts";
import * as Alchemy from "../../Stack.ts";
import {
  makeHttpStateStore,
  type HttpStateStoreProps,
} from "../../State/HttpStateStore.ts";
import * as CloudflareEnvironment from "../CloudflareEnvironment.ts";
import * as Credentials from "../Credentials.ts";

import { AlchemyContext } from "../../AlchemyContext.ts";
import { makeLocalState } from "../../State/LocalState.ts";
import { State, type StateService } from "../../State/State.ts";
import { recordStateStoreOp } from "../../Telemetry/Metrics.ts";
import * as Clank from "../../Util/Clank.ts";
import * as Access from "../Access.ts";
import { CloudflareAuth } from "../Auth/AuthProvider.ts";
import { EdgeSessionError, createEdgeSession } from "../EdgeSession.ts";
import Api, { STATE_STORE_SCRIPT_NAME } from "./Api.ts";
import { AuthTokenSecretName, TokenValue } from "./Token.ts";

/** Filename used for stored credentials under the profile directory. */
const CREDENTIALS_FILE = "cloudflare-state-store";

export interface BootstrapOptions {
  /**
   * The name of the script to use for the state store.
   * @default "alchemy-state-store"
   */
  workerName?: string;
  /**
   * Re-run the deploy even if the worker already exists in Cloudflare.
   *
   * Without this flag, an already-deployed worker is **adopted**: the
   * auth-token secret is re-fetched via an edge probe and the local
   * credentials file is refreshed, but no new code is uploaded. With
   * `force: true` the full deploy runs again, redeploying the worker
   * code and reconciling every resource in place.
   */
  force?: boolean;
}

/**
 * Manually bootstrap (or repair) the Cloudflare-hosted HTTP State
 * Store. Used by `alchemy bootstrap cloudflare`.
 *
 * The flow mirrors what {@link state} does on first use, but is
 * exposed as a standalone effect so users can trigger it (or recover
 * from a partially-failed previous deploy) explicitly:
 *
 *   1. Resume any in-progress local `CloudflareStateStore` stack.
 *   2. If the worker already exists in Cloudflare and `force` is not
 *      set, adopt it: read the auth token via an edge-preview probe
 *      and persist credentials.
 *   3. Otherwise run the full deploy with adoption enabled, sync local
 *      state into the deployed store, persist credentials, and delete
 *      the local stack.
 */
export const bootstrap = (options: BootstrapOptions = {}) =>
  Effect.gen(function* () {
    const isCI = yield* Config.boolean("CI").pipe(Config.withDefault(false));
    const profileName = yield* ALCHEMY_PROFILE;
    const scriptName = options.workerName ?? STATE_STORE_SCRIPT_NAME;
    const force = options.force ?? false;

    const localState = yield* makeLocalState();
    const hasLocalStack = yield* Effect.map(
      localState.listStages("CloudflareStateStore"),
      (stages) => stages.includes(scriptName),
    );

    if (hasLocalStack) {
      yield* Clank.info(
        `Resuming Cloudflare State Store '${scriptName}' deployment...`,
      );
      yield* finishBootstrap({ scriptName, profileName, localState, isCI });
      yield* Clank.success(`Cloudflare State Store '${scriptName}' is ready.`);
      return;
    }

    const { accountId } = yield* CloudflareEnvironment.CloudflareEnvironment;
    const workerExists = yield* workers
      .getScriptSetting({ accountId, scriptName })
      .pipe(
        Effect.map((setting) => setting !== undefined),
        Effect.catchTag("WorkerNotFound", () => Effect.succeed(false)),
      );

    if (workerExists && !force) {
      yield* Clank.info(
        `Worker '${scriptName}' already exists; adopting and refreshing credentials. ` +
          `Use --force to redeploy.`,
      );
      const credentials = yield* loginWithCloudflare();
      if (!isCI) {
        yield* writeCredentials<HttpStateStoreProps>(
          profileName,
          CREDENTIALS_FILE,
          credentials,
        );
      }
      yield* Clank.success(`Cloudflare State Store '${scriptName}' is ready.`);
      return;
    }

    if (workerExists) {
      yield* Clank.info(
        `Forcing redeploy of Cloudflare State Store '${scriptName}'...`,
      );
    } else {
      yield* Clank.info(`Deploying Cloudflare State Store '${scriptName}'...`);
    }

    yield* finishBootstrap({ scriptName, profileName, localState, isCI });
    yield* Clank.success(`Cloudflare State Store '${scriptName}' is ready.`);
  });

export const state = (props?: {
  /**
   * The name of the script to use for the state store.
   * @default "alchemy-state-store"
   */
  workerName?: string;
}) =>
  Layer.effect(
    State,
    Effect.gen(function* () {
      const isCI = yield* Config.boolean("CI").pipe(Config.withDefault(false));
      const alchemyContext = yield* AlchemyContext;
      const profileName = yield* ALCHEMY_PROFILE;
      const credentials = yield* readCredentials<HttpStateStoreProps>(
        profileName,
        CREDENTIALS_FILE,
      );

      const scriptName = props?.workerName ?? STATE_STORE_SCRIPT_NAME;

      // The bootstrap of the Cloudflare State Store is only considered
      // successful once two invariants hold:
      //   1. the worker has been deployed and the credentials persisted
      //   2. the local CloudflareStateStore stack has been synced into
      //      the HTTP store and removed from disk
      //
      // If a previous run failed anywhere between deploying the worker
      // and deleting the local stack (e.g. the worker got created but
      // sync/credential-write/delete never ran) we will detect the
      // leftover local stack here and resume the bootstrap. This loop
      // re-runs deploy (idempotent over already-applied resources) and
      // finishes the sync/credential/cleanup steps until both
      // invariants are satisfied.
      const localState = yield* makeLocalState();

      const hasLocalStack = yield* Effect.map(
        localState.listStages("CloudflareStateStore"),
        (stages) => stages.includes(scriptName),
      );

      if (hasLocalStack) {
        yield* Clank.info(
          `Resuming Cloudflare State Store '${scriptName}' deployment...`,
        );
        return yield* finishBootstrap({
          scriptName,
          profileName,
          localState,
          isCI,
        });
      }

      // TODO(sam): support upgrading state store, right now we only deploy once
      if (credentials) {
        // it's in the profile, let's go
        const httpState = yield* makeHttpStateStore(credentials);

        if (alchemyContext.updateStateStore) {
          yield* deployStateStore(scriptName, httpState);
        }

        return httpState;
      }

      // our profile does not contain a reference to the state store, let's try and resolve it
      const { accountId } = yield* CloudflareEnvironment.CloudflareEnvironment;
      const workerExists = yield* workers
        .getScriptSetting({
          accountId,
          scriptName,
        })
        .pipe(
          Effect.map((setting) => setting !== undefined),
          Effect.catchTag("WorkerNotFound", () => Effect.succeed(false)),
        );

      if (workerExists) {
        // it exists, so fetch the secret token
        const credentials = yield* loginWithCloudflare();
        if (!isCI) {
          yield* writeCredentials<HttpStateStoreProps>(
            profileName,
            CREDENTIALS_FILE,
            credentials,
          );
        }
        const httpState = yield* makeHttpStateStore(credentials);

        if (alchemyContext.updateStateStore) {
          yield* deployStateStore(scriptName, httpState);
        }

        return httpState;
      }

      if (isCI) {
        // TODO(sam): do we want to support bootstrapping the state store from CI?
        // for now - just die here
        return yield* Effect.die(
          new AuthError({
            message: `State store not found for script ${scriptName}. Deploy the state store first.`,
          }),
        );
      }

      const shouldDeploy = yield* Clank.confirm({
        message: "Cloudflare State Store not found. Do you want to deploy it?",
      });

      if (!shouldDeploy) {
        return yield* Effect.die(new Clank.PromptCancelled());
      }

      return yield* finishBootstrap({
        scriptName,
        profileName,
        localState,
        isCI,
      });
    }).pipe(Effect.orDie),
  ).pipe(
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(CloudflareEnvironment.fromProfile()),
    Layer.provideMerge(CloudflareAuth),
    Layer.provideMerge(Access.AccessLive),
    Layer.orDie,
  );

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
const hoistBootstrapStack = Effect.fnUntraced(function* (
  source: StateService,
  destination: StateService,
  scriptName: string,
) {
  const stack = "CloudflareStateStore";
  const stage = scriptName;
  const fqns = yield* source.list({ stack, stage });
  yield* Effect.forEach(
    fqns,
    Effect.fnUntraced(function* (fqn) {
      const value = yield* source.get({ stack, stage, fqn });
      if (value) {
        yield* destination.set({ stack, stage, fqn, value });
      }
    }),
    { concurrency: "unbounded" },
  );
});

/**
 * Finish (or resume) the bootstrap of the Cloudflare State Store using
 * the provided local state as the source of truth. This is idempotent
 * and safe to re-run: any resources already applied during a previous
 * partial run will be reconciled, the local stack will be synced into
 * the deployed HTTP store, credentials persisted, and finally the
 * local stack removed - which is what marks the bootstrap as complete.
 */
const finishBootstrap = ({
  scriptName,
  profileName,
  localState,
  isCI,
}: {
  scriptName: string;
  profileName: string;
  localState: StateService;
  isCI: boolean;
}) =>
  Effect.gen(function* () {
    yield* deployStateStore(scriptName, localState);

    // Don't trust the `authToken` returned by `deploy(...)`: when
    // adoption kicks in (the Secrets Store secret already existed),
    // the locally-generated `Random` value won't match the value
    // actually persisted in Cloudflare, and any HTTP call to the
    // worker would 401. Re-read the live token from the deployed
    // worker via the same edge-preview probe `loginWithCloudflare`
    // uses, so the credentials we persist always reflect what is
    // actually deployed. `loginWithCloudflare` also persists the
    // credentials file (skipping the write in CI), so we don't need
    // to do that explicitly here.
    const { url, authToken } = yield* loginWithCloudflare();
    const httpState = yield* makeHttpStateStore({ url, authToken });
    // `profileName` is intentionally unused here — `loginWithCloudflare`
    // resolves it itself. Reference it to keep the surrounding API
    // explicit and to avoid an unused-parameter lint.
    void profileName;
    void isCI;

    // Copy the freshly-deployed CloudflareStateStore stack into the
    // remote store. We deliberately do NOT call `syncState` here:
    // syncState is a *mirror* that deletes everything in the
    // destination that is not in the source, which would wipe every
    // user stack in the remote store on any subsequent bootstrap
    // (resume / --force / partial-failure recovery), since by that
    // point local state only contains the bootstrap stack itself.
    yield* hoistBootstrapStack(localState, httpState, scriptName);

    yield* localState.deleteStack({
      stack: "CloudflareStateStore",
      stage: scriptName,
    });

    return httpState;
  });

const deployStateStore = (scriptName: string, state?: StateService) =>
  Effect.gen(function* () {
    const localState = state ?? (yield* makeLocalState());
    // deploy it with local state (which we will then hoist into the Cloudflare state store)
    const stateLayer = Layer.succeed(State, localState);
    const { url, authToken } = yield* deploy({
      // use the script name as the stage name (so the user can have multiple state stores)
      stage: scriptName,
      stack: Alchemy.Stack(
        "CloudflareStateStore",
        {
          providers: Cloudflare.providers(),
          state: stateLayer,
        },
        Effect.gen(function* () {
          const token = yield* TokenValue;
          const api = yield* Api;

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
    return { url, authToken, localState };
  }).pipe(
    Effect.withSpan("state_store.deploy", {
      attributes: {
        "alchemy.state_store.script_name": scriptName,
        "alchemy.state_store.op": "deploy",
      },
    }),
    recordStateStoreOp("deploy"),
  );

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
export const loginWithCloudflare = () =>
  Effect.gen(function* () {
    const isCI = yield* Config.boolean("CI").pipe(Config.withDefault(false));
    const profileName = yield* ALCHEMY_PROFILE;
    const { accountId } = yield* CloudflareEnvironment.CloudflareEnvironment;

    // 1. Locate the single Secrets Store on the account.
    const stores = yield* SecretsStore.listStores({ accountId });
    const store = stores.result[0];
    if (!store) {
      return yield* Effect.fail(
        new AuthError({
          message:
            "No Secrets Store found on this account. Deploy the state store first.",
        }),
      );
    }

    // 2. Fetch the auth-token value via an edge-preview worker.
    //    We piggy-back on the already-deployed state-store script so the
    //    `cf-workers-preview-token` header has a real workers.dev route to
    //    swap onto. Uploading the probe under a brand-new script name fails
    //    on accounts where that script has never been deployed (or where
    //    workers.dev preview URLs are off by default — the post-2024
    //    Cloudflare default for new accounts) because the host doesn't
    //    resolve and Cloudflare's edge serves a 400 HTML error page
    //    instead of routing to the preview.
    const authToken = yield* readSecretViaEdge(
      STATE_STORE_SCRIPT_NAME,
      store.id,
      AuthTokenSecretName,
    );

    // 3. Derive the deployed worker URL.
    const { subdomain } = yield* workers.getSubdomain({ accountId });
    const url = `https://${STATE_STORE_SCRIPT_NAME}.${subdomain}.workers.dev`;

    if (!isCI) {
      // 4. Persist credentials. The profile entry is managed by
      //    `loadOrConfigure` when this is invoked through `configure`.
      yield* writeCredentials<HttpStateStoreProps>(
        profileName,
        CREDENTIALS_FILE,
        {
          url,
          authToken: authToken.trim(),
        },
      ).pipe(
        Effect.mapError(
          (e) =>
            new AuthError({ message: "Failed to write credentials", cause: e }),
        ),
      );

      yield* Clank.success(
        `HTTP state store credentials saved for '${profileName}'.`,
      );
      yield* Clank.info(`  url:     ${url}`);
    }

    return {
      url,
      authToken: authToken.trim(),
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
  );
