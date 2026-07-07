import * as Cloudflare from "@/Cloudflare/index.ts";
import { isBindingTargetNotFound } from "@/Cloudflare/Workers/WorkerProvider.ts";
import * as Test from "@/Test/Vitest";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Cloudflare.providers() });

const script = `export default { fetch() { return new Response("ok"); } };`;

/**
 * Deploy-time binding validation rejects a script upload whose bindings
 * reference a resource that doesn't exist.
 *
 * The Durable Object cross-script binding is the one deterministic
 * engine-level trigger: `scriptName` is a plain string, so a stack can
 * name a script that was never deployed. Every other binding type can
 * only reference a resource declared in the stack, and its reconciler
 * heals a missing target before the Worker deploys — those hit
 * not-found only through propagation races (a just-created target not
 * yet visible to validation), which is exactly what
 * `putWorkerScript`'s bounded retry exists for. The predicate matrix
 * below covers the full family hermetically.
 */
test.provider(
  "durable object binding to a script that doesn't exist surfaces the typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("do-consumer-worker", {
              script,
              env: {
                Counter: Cloudflare.DurableObject("Counter", {
                  scriptName: "alchemy-test-nonexistent-do-host",
                }),
              },
            });
          }),
        )
        .pipe(Effect.flip);

      expect(error._tag).toEqual("DurableObjectClassNotFound");
      expect(isBindingTargetNotFound(error)).toBe(true);

      yield* stack.destroy();
    }),
  { timeout: 240_000 },
);

/**
 * The retry predicate across the full family of typed
 * binding-target-not-found errors. Each code was captured verbatim
 * from the live API by uploading probe workers with bindings
 * referencing missing targets; the deploy above exercises one member
 * through a real stack.
 */
describe("isBindingTargetNotFound", () => {
  const notFound = [
    new workers.KVNamespaceNotFound({
      code: 10041,
      message: "KV namespace '00000000000000000000000000000000' not found.",
    }),
    new workers.R2BucketNotFound({
      code: 10085,
      message: "R2 bucket 'missing-bucket' not found.",
    }),
    new workers.D1DatabaseNotFound({
      code: 10181,
      message:
        "D1 binding 'DB' references database '00000000-0000-0000-0000-000000000000' which was not found.",
    }),
    new workers.QueueNotFound({
      code: 11000,
      message: "Queue 'missing-queue' not found.",
    }),
    new workers.ServiceBindingNotFound({
      code: 10144,
      message:
        "Service binding 'SVC' references environment 'production' on Worker 'missing-worker' which was not found.",
    }),
    new workers.DurableObjectClassNotFound({
      code: 10061,
      message:
        "Cannot create binding for class 'Foo' that is not exported by script 'some-script'.",
    }),
    new workers.HyperdriveConfigNotFound({
      code: 10157,
      message:
        "Hyperdrive binding 'HD' references config '00000000000000000000000000000000' which was not found.",
    }),
    new workers.VectorizeIndexNotFound({
      code: 10159,
      message:
        "Vectorize binding 'VEC' references index 'missing-index' which was not found.",
    }),
    new workers.DispatchNamespaceNotFound({
      code: 100119,
      message:
        "The specified dispatch namespace does not exist on this account.",
    }),
    new workers.MtlsCertificateNotFound({
      code: 100143,
      message:
        "mTLS certificate '00000000-0000-0000-0000-000000000000' not found.",
    }),
    new workers.SecretsStoreBindingNotFound({
      code: 10182,
      message:
        "Secrets Store binding 'SECRET' references store '00000000000000000000000000000000' and secret 'missing' which were not found.",
    }),
  ];

  for (const error of notFound) {
    it(`retries ${error._tag}`, () => {
      expect(isBindingTargetNotFound(error)).toBe(true);
    });
  }

  it("does not retry non-binding upload failures", () => {
    expect(
      isBindingTargetNotFound(
        new workers.InvalidWorkerScript({
          code: 10068,
          message: "Uncaught SyntaxError: Unexpected token",
        }),
      ),
    ).toBe(false);
  });
});
