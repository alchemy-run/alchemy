import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/**
 * Fixtures for the `preserveExistingValue` integration test: two secrets
 * declared with the SAME program value, one opted into
 * `preserveExistingValue`. The test seeds both names out-of-band with a
 * different value first, then deploys with `adopt(true)` — the state-store
 * bootstrap's exact situation — and reads both back through a Worker.
 */
export const PRESERVED_SECRET_NAME = "PreserveTestPreservedKey";
export const CONTROL_SECRET_NAME = "PreserveTestControlKey";
export const PROGRAM_VALUE = "sk-program-value";

export const PreserveStore = Cloudflare.SecretsStore.Store(
  "PreserveSecretStore",
);

/** Opted in: an already-existing secret keeps its stored value. */
export const Preserved = Effect.gen(function* () {
  const store = yield* PreserveStore;
  return yield* Cloudflare.SecretsStore.Secret("PreserveTestPreserved", {
    store,
    name: PRESERVED_SECRET_NAME,
    value: Redacted.make(PROGRAM_VALUE),
    preserveExistingValue: true,
  });
});

/** Control: default behavior overwrites an adopted secret's value. */
export const Control = Effect.gen(function* () {
  const store = yield* PreserveStore;
  return yield* Cloudflare.SecretsStore.Secret("PreserveTestControl", {
    store,
    name: CONTROL_SECRET_NAME,
    value: Redacted.make(PROGRAM_VALUE),
  });
});
