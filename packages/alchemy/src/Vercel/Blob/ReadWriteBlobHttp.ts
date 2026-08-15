import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { FunctionEnvironment } from "../Functions/FunctionBridge.ts";
import { makeBlobHttpBinding } from "./BlobHttp.ts";
import { makeReadBlobClient } from "./ReadBlobHttp.ts";
import { makeWriteBlobClient } from "./WriteBlobHttp.ts";
import { ReadWriteBlob, type ReadWriteBlobClient } from "./ReadWriteBlob.ts";

/**
 * HTTP (data-plane) implementation of {@link ReadWriteBlob} — composes the
 * read and write client builders over one shared scope.
 *
 * Deploy half: contributes the host Function's project onto the store's
 * binding contract (the store's reconciler creates the connection, which
 * makes the platform inject `BLOB_READ_WRITE_TOKEN`). Runtime half: the
 * full read/write client over `https://blob.vercel-storage.com`.
 *
 * ## Runtime authorization
 *
 * Deployed compute is authorized by the **platform-injected
 * `BLOB_READ_WRITE_TOKEN`** provisioned via the store↔project connection
 * the deploy half declares — alchemy never mints or syncs a Blob
 * credential itself, and the token is exactly the store-scoped read-write
 * authority this binding's client exposes.
 *
 * Provide on the Function's init Effect:
 * `Effect.provide(Vercel.ReadWriteBlobHttp)`.
 */
export const ReadWriteBlobHttp: Layer.Layer<
  ReadWriteBlob,
  never,
  HttpClient.HttpClient | FunctionEnvironment
> = Layer.effect(
  ReadWriteBlob,
  Effect.gen(function* () {
    const context = yield* Effect.context<HttpClient.HttpClient>();
    return yield* makeBlobHttpBinding({
      makeClient: (scope): ReadWriteBlobClient => ({
        ...makeReadBlobClient(scope, context),
        ...makeWriteBlobClient(scope, context),
      }),
    });
  }),
);
