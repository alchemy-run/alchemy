import * as Cloudflare from "@alchemy.run/cloudflare";
import { STATE_STORE_VERSION } from "@alchemy.run/cloudflare/StateStore/Api";
import { readStoreCredentials } from "@alchemy.run/cloudflare/StateStore/CredentialsFile";
import { teardownStateStore } from "@alchemy.run/cloudflare/StateStore/State";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { CredentialsStore } from "alchemy/Auth/Credentials";
import { currentProfileName } from "alchemy/Auth/Profile";
import { StateApi } from "alchemy/State/HttpStateApi";
import { makeHttpStateStore } from "alchemy/State/HttpStateStore";
import { passphraseEncryption } from "alchemy/State/PassphraseEncryption";
import { StateEncryption } from "alchemy/State/StateEncryption";
import * as Effect from "effect/Effect";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Redacted from "effect/Redacted";
import {
  current,
  deployArgs,
  fails,
  planLine,
  released,
  RELEASED,
  succeeds,
  workdir,
  type RunOptions,
} from "./Harness.ts";
import {
  expectPlaintext,
  expectSealedJson,
  secretsOfTexts,
  secretsThroughStore,
  STACK,
} from "./Records.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const PASSPHRASE = "state upgrade test passphrase";

test.provider(
  `a Cloudflare store deployed by ${RELEASED} upgrades in place without losing state`,
  () =>
    Effect.gen(function* () {
      // Its own Worker, so the account's default store keeps its version.
      const workerName = `alchemy-state-upgrade-${Test.defaultStage().replaceAll("_", "-")}`;
      yield* teardownStateStore({ workerName });

      yield* Effect.gen(function* () {
        const cwd = yield* workdir("cloudflare");
        const old = yield* released();
        const next = yield* current();
        const on = (overrides: Record<string, string> = {}): RunOptions => ({
          cwd,
          env: { UPGRADE_STORE: "cloudflare", UPGRADE_CF_WORKER: workerName, ...overrides },
        });

        // The released version deploys its store Worker and the stage.
        yield* succeeds(old, deployArgs("one"), on());

        // Both versions keep the store's URL and token in the profile's credentials.
        const credentials = yield* readStoreCredentials(
          yield* CredentialsStore,
          yield* currentProfileName,
          workerName,
        );
        const raw = yield* HttpApiClient.make(StateApi, {
          baseUrl: credentials!.url,
          transformClient: HttpClient.mapRequest(
            HttpClientRequest.bearerToken(credentials!.authToken),
          ),
        });
        const plain = yield* makeHttpStateStore({
          id: "cloudflare-http",
          url: credentials!.url,
          authToken: credentials!.authToken,
        });
        /** What the Worker holds for the stage's records and output, as JSON text. */
        const stored = Effect.gen(function* () {
          const records = yield* Effect.forEach(["Secret", "Token"], (fqn) =>
            raw.state.getState({ params: { stack: STACK, stage: "one", fqn } }),
          );
          const output = yield* raw.state.getStackOutput({
            params: { stack: STACK, stage: "one" },
          });
          return [...records, output].map((value) => JSON.stringify(value));
        });
        expect(yield* plain.getVersion()).toBe(8);
        const original = yield* stored;
        const secrets = secretsOfTexts(original);
        expect(secrets).toHaveLength(4);

        // The new version upgrades the Worker in place and changes nothing in the stack.
        const upgraded = yield* succeeds(next, deployArgs("one"), on());
        expect(planLine(upgraded)).toBe("Plan: no changes");
        expect(yield* plain.getVersion()).toBe(STATE_STORE_VERSION);
        expect(yield* stored).toEqual(original);

        // The released version refuses the newer store instead of
        // redeploying its own Worker over it.
        const refused = yield* fails(old, deployArgs("one"), on());
        expect(refused.output).toContain("newer than this");
        expect(yield* plain.getVersion()).toBe(STATE_STORE_VERSION);

        // A layer seals the records on the client: the Worker holds ciphertext.
        const withPassphrase = (encryption: string) =>
          on({ UPGRADE_ENCRYPTION: encryption, ALCHEMY_STATE_PASSPHRASE: PASSPHRASE });
        yield* succeeds(next, deployArgs("one"), withPassphrase("passphrase"));
        expectSealedJson(yield* stored, secrets);
        const sealedStore = makeHttpStateStore({
          id: "cloudflare-http",
          url: credentials!.url,
          authToken: credentials!.authToken,
        }).pipe(
          Effect.provideServiceEffect(
            StateEncryption,
            StateEncryption.pipe(
              Effect.provide(passphraseEncryption({ passphrase: Redacted.make(PASSPHRASE) })),
            ),
          ),
        );
        expect(yield* secretsThroughStore(sealedStore, "one")).toEqual(secrets);

        // `disable` opens them again.
        yield* succeeds(next, deployArgs("one"), withPassphrase("passphrase-disable"));
        const decrypted = yield* stored;
        expectPlaintext(decrypted);
        expect(secretsOfTexts(decrypted)).toEqual(secrets);
      }).pipe(Effect.ensuring(teardownStateStore({ workerName }).pipe(Effect.ignore)));
    }),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:statestore", "live"],
    timeout: 600_000,
  },
);
