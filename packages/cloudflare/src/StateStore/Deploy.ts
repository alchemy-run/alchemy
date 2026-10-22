import crypto from "node:crypto";
import { DEFAULT_COMPATIBILITY_DATE } from "@alchemy.run/cloudflare-runtime/core/internal/constants";
import * as durableObjects from "@distilled.cloud/cloudflare/durable-objects";
import * as secretsStore from "@distilled.cloud/cloudflare/secrets-store";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { waitForSecretActive } from "../SecretsStore/Secret.ts";
import { getCompatibility } from "../Workers/Compatibility.ts";
import { WorkerBundle } from "../Workers/Sources/Rolldown.ts";
import { contentTypeForModule, putWorkerScript } from "../Workers/WorkerProvider.ts";
import { API_MAIN } from "./Api.ts";
import {
  AuthTokenBinding,
  AuthTokenSecretName,
  EncryptionKeyBinding,
  EncryptionKeySecretName,
  stateStoreSecretName,
} from "./Token.ts";

/** The Durable Object class holding every store's state. Its name must never change. */
const STORE_CLASS = "Store";

/** The stack name the Worker's runtime reports, kept from the stack-deployed era. */
const RUNTIME_STACK_NAME = "CloudflareStateStore";

/**
 * Deploy a Cloudflare State Store Worker with direct API calls.
 *
 * Every step is idempotent and only ever adds what is missing: the account's
 * Secrets Store and the two state-store secrets are created when absent and
 * never updated or deleted, so redeploying cannot rotate the auth token or
 * lose the encryption key. The Worker itself is re-uploaded on every call
 * with the same `Store` Durable Object class, keeping its stored state.
 *
 * Returns the Worker's URL, and the auth token when this call created it
 * (an existing token can only be read back through a Worker binding).
 */
export const deployStateStoreWorker = Effect.fn("state_store.deploy_worker")(function* ({
  accountId,
  scriptName,
}: {
  accountId: string;
  scriptName: string;
}) {
  yield* Effect.annotateCurrentSpan({ "alchemy.state_store.script_name": scriptName });
  const storeId = yield* ensureSecretsStore(accountId);
  const authToken = yield* ensureSecret({
    accountId,
    storeId,
    name: stateStoreSecretName(AuthTokenSecretName, scriptName),
  });
  yield* ensureSecret({
    accountId,
    storeId,
    name: stateStoreSecretName(EncryptionKeySecretName, scriptName),
  });

  const compatibility = getCompatibility({
    main: API_MAIN,
    compatibility: { date: DEFAULT_COMPATIBILITY_DATE },
  });
  const bundler = yield* WorkerBundle;
  const bundle = yield* bundler.build({
    id: "Api",
    main: API_MAIN,
    compatibility,
    entry: {
      kind: "effect",
      // The entry only needs the class name to export the Durable Object bridge.
      exports: {
        [STORE_CLASS]: {
          kind: "durableObject",
          constructor: Effect.never,
          services: Context.empty(),
        },
      },
    },
    stack: { name: RUNTIME_STACK_NAME, stage: scriptName },
    extraOptions: undefined,
  });

  yield* putWorkerScript({
    accountId,
    scriptName,
    dispatchNamespace: undefined,
    metadata: {
      mainModule: bundle.files[0]!.path,
      compatibilityDate: compatibility.date,
      compatibilityFlags: compatibility.flags,
      bindings: [
        { type: "plain_text", name: "ALCHEMY_PHASE", text: "runtime" },
        { type: "plain_text", name: "ALCHEMY_WORKER_NAME", text: scriptName },
        { type: "plain_text", name: "ALCHEMY_STACK_NAME", text: RUNTIME_STACK_NAME },
        { type: "plain_text", name: "ALCHEMY_STAGE", text: scriptName },
        { type: "plain_text", name: "ALCHEMY_CLOUDFLARE_ACCOUNT_ID", text: accountId },
        {
          type: "secrets_store_secret",
          name: AuthTokenBinding,
          storeId,
          secretName: stateStoreSecretName(AuthTokenSecretName, scriptName),
        },
        {
          type: "secrets_store_secret",
          name: EncryptionKeyBinding,
          storeId,
          secretName: stateStoreSecretName(EncryptionKeySecretName, scriptName),
        },
        { type: "durable_object_namespace", name: STORE_CLASS, className: STORE_CLASS },
      ],
      exports: {
        [STORE_CLASS]: {
          type: "durable-object",
          storage: yield* observedStoreStorage(accountId, scriptName),
        },
      },
      observability: { enabled: true, logs: { enabled: true, invocationLogs: true } },
    },
    files: bundle.files.map(
      (file) =>
        new File([file.content as BlobPart], file.path, {
          type: contentTypeForModule(file.path),
        }),
    ),
  });

  yield* workers.createScriptSubdomain({
    accountId,
    scriptName,
    enabled: true,
    previewsEnabled: true,
  });
  const { subdomain } = yield* workers.getSubdomain({ accountId });
  return { url: `https://${scriptName}.${subdomain}.workers.dev`, authToken };
});

/** The account's Secrets Store (Cloudflare allows one), created when missing. */
const ensureSecretsStore = Effect.fn(function* (accountId: string) {
  const first = secretsStore.listStores
    .items({ accountId })
    .pipe(Stream.runHead, Effect.map(Option.getOrUndefined));
  const existing = yield* first;
  if (existing) return existing.id;
  const created = yield* secretsStore
    .createStore({ accountId, name: "default_secrets_store" })
    .pipe(
      // A concurrent bootstrap created it first.
      Effect.catchTag("MaximumStoresExceeded", () => Effect.succeed(undefined)),
    );
  if (created) return created.id;
  const raced = yield* first;
  if (raced) return raced.id;
  return yield* Effect.die(
    new Error(`Cloudflare reports a Secrets Store on account ${accountId} but lists none.`),
  );
});

/**
 * Create a secret holding 32 random hex-encoded bytes, unless one with this
 * name exists. Returns the value only when this call created it; an existing
 * secret is left exactly as it is.
 */
const ensureSecret = Effect.fn(function* ({
  accountId,
  storeId,
  name,
}: {
  accountId: string;
  storeId: string;
  name: string;
}) {
  const exists = yield* secretsStore.listStoreSecrets.items({ accountId, storeId }).pipe(
    Stream.filter((secret) => secret.name === name),
    Stream.runHead,
    Effect.map(Option.isSome),
  );
  if (exists) return undefined;
  const value = yield* Effect.sync(() => crypto.randomBytes(32).toString("hex"));
  const created = yield* secretsStore
    .createStoreSecret({
      accountId,
      storeId,
      body: [{ name, scopes: ["workers"], value, comment: "Alchemy Cloudflare State Store" }],
    })
    .pipe(
      // A concurrent bootstrap created it first; keep theirs.
      Effect.catchTag("SecretNameAlreadyExists", () => Effect.succeed(undefined)),
    );
  if (!created) return undefined;
  const secret = created.result[0]!;
  yield* waitForSecretActive({ accountId, storeId, secretId: secret.id }, "pending");
  return value;
});

/** The `Store` class's storage backend as deployed; SQLite for a new store. */
const observedStoreStorage = (accountId: string, scriptName: string) =>
  durableObjects.listNamespaces.items({ accountId }).pipe(
    Stream.filter((ns) => ns.script === scriptName && ns.class === STORE_CLASS),
    Stream.runHead,
    Effect.map((ns) =>
      Option.isSome(ns) && ns.value.useSqlite === false
        ? ("legacy-kv" as const)
        : ("sqlite" as const),
    ),
  );
