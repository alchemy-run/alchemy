import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { readStoreCredentials } from "@alchemy.run/cloudflare/StateStore/CredentialsFile";
import { teardownStateStore } from "@alchemy.run/cloudflare/StateStore/State";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { CredentialsStore } from "alchemy/Auth/Credentials";
import { currentProfileName } from "alchemy/Auth/Profile";
import type { ResourceState } from "alchemy/State";
import { StateApi } from "alchemy/State/HttpStateApi";
import { makeHttpStateStore } from "alchemy/State/HttpStateStore";
import { State } from "alchemy/State/State";
import { SEALED_RECORD_MARKER } from "alchemy/State/StateEncryption";
import * as Effect from "effect/Effect";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: Cloudflare.providers() });

const record = (fqn: string, attr: Record<string, unknown>, status = "created") =>
  ({
    kind: "resource",
    resourceType: "Test.Resource",
    namespace: undefined,
    fqn,
    logicalId: fqn,
    instanceId: `instance-${fqn}`,
    providerVersion: 1,
    status,
    downstream: [],
    bindings: [],
    props: {},
    attr,
  }) as unknown as ResourceState;

// Cloudflare has no KMS: its state store's secrets are encrypted on the
// client with AWS KMS before they reach the Worker.
test.provider(
  "a Cloudflare state store keeps secrets encrypted with AWS KMS",
  () =>
    Effect.gen(function* () {
      // Its own Worker, so the account's default store keeps its version.
      const workerName = `alchemy-state-store-kms-${Test.defaultStage().replaceAll("_", "-")}`;
      const stack = "encrypted";
      const stage = "test";
      const secret = "cloudflare-kms-sealed-secret-0123456789";
      const sealed = record("Sealed", { password: Redacted.make(secret), name: "visible" });
      const replaced = record("Replaced", { token: Redacted.make(secret) }, "replaced");
      yield* teardownStateStore({ workerName });

      yield* Effect.gen(function* () {
        const state = yield* State.pipe(
          Effect.flatten,
          Effect.provide(
            Cloudflare.state({ workerName }).pipe(Layer.provide(AWS.stateEncryption())),
          ),
        );
        yield* state.set({ stack, stage, fqn: sealed.fqn, value: sealed });
        yield* state.set({ stack, stage, fqn: replaced.fqn, value: replaced });

        const read = (yield* state.get({ stack, stage, fqn: sealed.fqn })) as ResourceState;
        expect(Redacted.value(read.attr!.password as Redacted.Redacted<string>)).toBe(secret);
        expect(read.attr!.name).toBe("visible");
        // The Worker still finds replaced records by their status.
        const [found] = yield* state.getReplacedResources({ stack, stage });
        expect(Redacted.value(found!.attr!.token as Redacted.Redacted<string>)).toBe(secret);

        // What the Worker holds: the secret encrypted, the rest readable.
        const credentials = yield* readStoreCredentials(
          yield* CredentialsStore,
          yield* currentProfileName,
          workerName,
        );
        const unencrypted = yield* makeHttpStateStore({
          id: "cloudflare-http",
          url: credentials!.url,
          authToken: credentials!.authToken,
        });
        const refused = yield* unencrypted.get({ stack, stage, fqn: sealed.fqn }).pipe(Effect.flip);
        expect(refused.message).toContain("encrypted with 'aws-kms'");
        const client = yield* HttpApiClient.make(StateApi, {
          baseUrl: credentials!.url,
          transformClient: HttpClient.mapRequest(
            HttpClientRequest.bearerToken(credentials!.authToken),
          ),
        });
        const raw = (yield* client.state.getState({
          params: { stack, stage, fqn: sealed.fqn },
        })) as Record<string, unknown>;
        expect(JSON.stringify(raw)).not.toContain(secret);
        expect(raw.status).toBe("created");
        expect(raw[SEALED_RECORD_MARKER]).toMatchObject({ by: "aws-kms" });
      }).pipe(Effect.ensuring(teardownStateStore({ workerName }).pipe(Effect.ignore)));
    }),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:statestore",
      "provider:aws",
      "provider:aws:kms",
      "live",
    ],
    timeout: 300_000,
  },
);
