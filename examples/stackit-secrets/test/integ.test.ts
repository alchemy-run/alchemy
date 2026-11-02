import { describe, expect } from "bun:test";
import * as Stackit from "@alchemy.run/stackit";
import * as Test from "@alchemy.run/test/Bun";
import * as kms from "@distilled.cloud/stackit/kms";
import * as secretsManager from "@distilled.cloud/stackit/secrets_manager";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Stackit.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

// Out-of-band calls resolve the same profile the deploy uses.
const StackitCloud = Layer.mergeAll(Stackit.StackitAuth, Stackit.fromAuthProvider()).pipe(
  Layer.provideMerge(FetchHttpClient.layer),
);

/** A POST that has to answer `status`, retried while a fresh function and its grants settle. */
const post = (url: string, body: unknown, status: number, apiKey?: string) =>
  HttpClient.execute(
    HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeaders(apiKey === undefined ? {} : { "x-api-key": apiKey }),
      HttpClientRequest.bodyJsonUnsafe(body),
    ),
  ).pipe(
    Effect.timeout("30 seconds"),
    Effect.flatMap((response) =>
      response.status === status
        ? Effect.succeed(response)
        : Effect.fail(`HTTP ${response.status}`),
    ),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
  );

describe("stackit-secrets", () => {
  const stack = beforeAll(deploy(Stack), { timeout: 1_200_000 });

  afterAll.skipIf(!!process.env.NO_DESTROY)(
    Effect.gen(function* () {
      const deployed = yield* stack;
      yield* destroy(Stack);

      // A failed deploy returns nothing, but the destroy above still removes what it made.
      if (deployed === undefined) return;
      const { projectId, region, instanceId, keyRingId, keyId } = deployed;

      const instance = yield* secretsManager.getInstance({ projectId, instanceId }).pipe(
        Effect.as("found"),
        Effect.catchTag("NotFound", () => Effect.succeed("gone")),
        Effect.provide(StackitCloud),
      );
      expect(instance).toEqual("gone");

      // A deleted key stays readable until its grace period ends.
      const key = yield* kms.getKey({ projectId, regionId: region, keyRingId, keyId }).pipe(
        Effect.map((found) =>
          found.state === "deleted" || found.deletionDate !== undefined
            ? "scheduled for deletion"
            : "found",
        ),
        Effect.catchTag("NotFound", () => Effect.succeed("scheduled for deletion")),
        Effect.provide(StackitCloud),
      );
      expect(key).toEqual("scheduled for deletion");
    }),
    { timeout: 900_000 },
  );

  test(
    "rejects a request with no key or the wrong one",
    Effect.gen(function* () {
      const { url } = yield* stack;
      yield* post(`${url}/encrypt`, { plaintext: "secret" }, 401);
      yield* post(`${url}/encrypt`, { plaintext: "secret" }, 401, "wrong");
    }),
    { timeout: 300_000 },
  );

  test(
    "encrypts and decrypts with the key from Secrets Manager",
    Effect.gen(function* () {
      const { url, apiKey } = yield* stack;
      const key = Redacted.value(apiKey);
      const plaintext = "hello from a STACKIT Function";

      const encrypted = yield* post(`${url}/encrypt`, { plaintext }, 200, key);
      const body = (yield* encrypted.json) as { ciphertext: string; version: number };
      expect(body.ciphertext).not.toContain(plaintext);
      expect(body.version).toBe(1);

      const decrypted = yield* post(`${url}/decrypt`, body, 200, key);
      expect((yield* decrypted.json) as { plaintext: string }).toEqual({ plaintext });
    }),
    { timeout: 300_000 },
  );

  test(
    "the instance and the key exist where the stack says",
    Effect.gen(function* () {
      const { projectId, region, instanceId, keyRingId, keyId } = yield* stack;
      const instance = yield* secretsManager
        .getInstance({ projectId, instanceId })
        .pipe(Effect.provide(StackitCloud));
      expect(instance.id).toEqual(instanceId);

      const key = yield* kms
        .getKey({ projectId, regionId: region, keyRingId, keyId })
        .pipe(Effect.provide(StackitCloud));
      expect(key.purpose).toEqual("symmetric_encrypt_decrypt");
    }),
    { timeout: 120_000 },
  );
});
