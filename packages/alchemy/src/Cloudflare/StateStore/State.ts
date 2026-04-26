import * as SecretsStore from "@distilled.cloud/cloudflare/secrets-store";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";

import * as Config from "effect/Config";
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
import { syncState } from "../../State/Sync.ts";
import * as Clank from "../../Util/Clank.ts";
import { CloudflareAuth } from "../Auth/AuthProvider.ts";
import { EdgeSessionError, createEdgeSession } from "../EdgeSession.ts";
import Api, { STATE_STORE_SCRIPT_NAME } from "./Api.ts";
import { AuthTokenSecretName, TokenValue } from "./Token.ts";

/** Filename used for stored credentials under the profile directory. */
const CREDENTIALS_FILE = "cloudflare-state-store";

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

      // TODO(sam): support upgrading state store, right now we only deploy once
      if (credentials) {
        // it's in the profile, let's go
        const httpState = yield* makeHttpStateStore(credentials);

        if (alchemyContext.updateStateStore) {
          yield* deployStateStore(scriptName, httpState);
        }

        return httpState;
      } else {
        // our profile does not contain a reference to the state store, let's try and resolve it
        const { accountId } =
          yield* CloudflareEnvironment.CloudflareEnvironment;
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
        } else if (isCI) {
          // TODO(sam): do we want to support bootstrapping the state store from CI?
          // for now - just die here
          return yield* Effect.die(
            new AuthError({
              message: `State store not found for script ${scriptName}. Deploy the state store first.`,
            }),
          );
        }

        const shouldDeploy = yield* Clank.confirm({
          message:
            "Cloudflare State Store not found. Do you want to deploy it?",
        });

        if (!shouldDeploy) {
          return yield* Effect.die(new Clank.PromptCancelled());
        }

        const { url, authToken, localState } =
          yield* deployStateStore(scriptName);

        const httpState = yield* makeHttpStateStore({ url, authToken });

        yield* syncState(localState, httpState);

        yield* writeCredentials<HttpStateStoreProps>(
          profileName,
          CREDENTIALS_FILE,
          {
            url,
            authToken,
          },
        );

        yield* localState.deleteStack({
          stack: "CloudflareStateStore",
          stage: scriptName,
        });

        return httpState;
      }
    }).pipe(Effect.orDie),
  ).pipe(
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(CloudflareEnvironment.fromProfile()),
    Layer.provideMerge(CloudflareAuth),
    Layer.orDie,
  );

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
      // TODO(sam): we should not need to do this, but types do complain. fix deploy
      Effect.provide(stateLayer),
    );
    return { url, authToken, localState };
  });

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
    const authToken = yield* readSecretViaEdge(store.id, AuthTokenSecretName);

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

/** Preview script name used by the edge-probe worker. */
const PROBE_SCRIPT_NAME = "alchemy-state-store-probe";

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
 * Upload a tiny edge-preview worker that binds the given Secrets
 * Store secret, call it once, and return the decoded value. The
 * Cloudflare REST API deliberately hides secret values; only worker
 * bindings can resolve them, so this is the out-of-band path.
 */
const readSecretViaEdge = (storeId: string, secretName: string) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const file = new File([SECRET_PROBE_SOURCE], "worker.js", {
      type: "application/javascript+module",
    });
    const session = yield* createEdgeSession({
      scriptName: PROBE_SCRIPT_NAME,
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
