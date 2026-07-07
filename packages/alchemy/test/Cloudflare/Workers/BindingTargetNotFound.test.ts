import { isBindingTargetNotFound } from "@/Cloudflare/Workers/WorkerProvider.ts";
import {
  Credentials,
  apiTokenCredentials,
} from "@distilled.cloud/cloudflare/Credentials";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as wfp from "@distilled.cloud/cloudflare/workers-for-platforms";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

/**
 * Every deploy-time "binding references a resource that doesn't exist"
 * rejection `putScript` / `putDispatchNamespaceScript` can produce must
 * decode to its resource-specific typed tag, and `putWorkerScript`'s
 * bounded retry must recognise all of them (a bound resource created
 * moments earlier can be invisible to Cloudflare's validation for a
 * few seconds).
 *
 * Each `code` + message below was captured verbatim from the live API
 * by uploading a probe worker with a binding referencing a missing
 * target — the codes are resource-specific (not one shared
 * "binding not found" code), which is what makes the per-tag patches
 * sound.
 */
const CASES: { tag: string; code: number; message: string }[] = [
  {
    tag: "KVNamespaceNotFound",
    code: 10041,
    message:
      "KV namespace '00000000000000000000000000000000' not found. Verify the namespace exists in your account and that the namespace_id is correct.",
  },
  {
    tag: "R2BucketNotFound",
    code: 10085,
    message:
      "R2 bucket 'missing-bucket' not found. Verify the bucket exists in your account and that the bucket_name is correct.",
  },
  {
    tag: "D1DatabaseNotFound",
    code: 10181,
    message:
      "D1 binding 'DB' references database '00000000-0000-0000-0000-000000000000' which was not found.",
  },
  {
    tag: "QueueNotFound",
    code: 11000,
    message:
      "Queue 'missing-queue' not found. Please verify it exists and try again.",
  },
  {
    tag: "ServiceBindingNotFound",
    code: 10144,
    message:
      "Service binding 'SVC' references environment 'production' on Worker 'missing-worker' which was not found.",
  },
  {
    tag: "DurableObjectClassNotFound",
    code: 10061,
    message:
      "Cannot create binding for class 'Foo' that is not exported by script 'some-script'.",
  },
  {
    tag: "HyperdriveConfigNotFound",
    code: 10157,
    message:
      "Hyperdrive binding 'HD' references config '00000000000000000000000000000000' which was not found.",
  },
  {
    tag: "VectorizeIndexNotFound",
    code: 10159,
    message:
      "Vectorize binding 'VEC' references index 'missing-index' which was not found.",
  },
  {
    tag: "DispatchNamespaceNotFound",
    code: 100119,
    message: "The specified dispatch namespace does not exist on this account.",
  },
  {
    tag: "MtlsCertificateNotFound",
    code: 100143,
    message:
      "mTLS certificate '00000000-0000-0000-0000-000000000000' not found.",
  },
  {
    tag: "SecretsStoreBindingNotFound",
    code: 10182,
    message:
      "Secrets Store binding 'SECRET' references store '00000000000000000000000000000000' and secret 'missing' which were not found.",
  },
];

/** Serve the exact Cloudflare error envelope the live API returns. */
const stubApi = (code: number, message: string) =>
  Layer.mergeAll(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() =>
          HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                success: false,
                errors: [{ code, message }],
                messages: [],
                result: null,
              }),
              {
                status: 400,
                headers: { "content-type": "application/json" },
              },
            ),
          ),
        ),
      ),
    ),
    Layer.succeed(
      Credentials,
      Effect.succeed(apiTokenCredentials({ apiToken: "test-token" })),
    ),
  );

const putScriptParams = {
  accountId: "00000000000000000000000000000000",
  scriptName: "binding-test",
  metadata: { mainModule: "worker.js" },
  files: [
    new File(["export default {};"], "worker.js", {
      type: "application/javascript+module",
    }),
  ],
};

describe("putScript binding-target-not-found errors", () => {
  for (const { tag, code, message } of CASES) {
    it.effect(`decodes code ${code} as ${tag} and retries it`, () =>
      Effect.gen(function* () {
        const error = yield* workers
          .putScript(putScriptParams)
          .pipe(Effect.flip);
        expect(error._tag).toBe(tag);
        expect(isBindingTargetNotFound(error)).toBe(true);
      }).pipe(Effect.provide(stubApi(code, message))),
    );
  }

  it.effect(
    "decodes the same envelope from the dispatch-namespace upload path",
    () =>
      Effect.gen(function* () {
        const error = yield* wfp
          .putDispatchNamespaceScript({
            ...putScriptParams,
            dispatchNamespace: "test-namespace",
          })
          .pipe(Effect.flip);
        expect(error._tag).toBe("KVNamespaceNotFound");
        expect(isBindingTargetNotFound(error)).toBe(true);
      }).pipe(
        Effect.provide(
          stubApi(
            10041,
            "KV namespace '00000000000000000000000000000000' not found.",
          ),
        ),
      ),
  );

  it.effect("does not retry non-binding upload failures", () =>
    Effect.gen(function* () {
      const error = yield* workers.putScript(putScriptParams).pipe(Effect.flip);
      expect(error._tag).toBe("InvalidWorkerScript");
      expect(isBindingTargetNotFound(error)).toBe(false);
    }).pipe(
      Effect.provide(stubApi(10068, "Uncaught SyntaxError: Unexpected token")),
    ),
  );
});
