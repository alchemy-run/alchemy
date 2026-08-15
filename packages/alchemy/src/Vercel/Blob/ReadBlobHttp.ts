import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { FunctionEnvironment } from "../Functions/FunctionBridge.ts";
import {
  getBlobRaw,
  headBlobRaw,
  listBlobsRaw,
  makeBlobHttpBinding,
  type BlobScope,
} from "./BlobHttp.ts";
import { ReadBlob, type ReadBlobClient } from "./ReadBlob.ts";
import type { ListBlobsOptions } from "./BlobTypes.ts";

/**
 * Build a {@link ReadBlobClient} over a resolved data-plane scope. The
 * `HttpClient` context is captured once; every operation resolves the scope
 * lazily (so the platform-injected token is read from the live env).
 */
export const makeReadBlobClient = (
  scope: Effect.Effect<BlobScope>,
  context: Context.Context<HttpClient.HttpClient>,
): ReadBlobClient => ({
  head: (pathname: string) =>
    scope.pipe(
      Effect.flatMap((s) => headBlobRaw(s, pathname)),
      // Reads cannot conflict on create or fail an etag precondition —
      // those tags are impossible by construction; a hit is a defect.
      Effect.catchTag(
        ["Vercel.Blob.AlreadyExists", "Vercel.Blob.PreconditionFailed"],
        (e) => Effect.die(e),
      ),
      Effect.provideContext(context),
    ),
  get: (pathname: string) =>
    scope.pipe(
      Effect.flatMap((s) => getBlobRaw(s, pathname)),
      Effect.catchTag(
        ["Vercel.Blob.AlreadyExists", "Vercel.Blob.PreconditionFailed"],
        (e) => Effect.die(e),
      ),
      Effect.provideContext(context),
    ),
  list: (options?: ListBlobsOptions) =>
    scope.pipe(
      Effect.flatMap((s) => listBlobsRaw(s, options)),
      Effect.catchTag(
        [
          "Vercel.Blob.AlreadyExists",
          "Vercel.Blob.NotFound",
          "Vercel.Blob.PreconditionFailed",
        ],
        (e) => Effect.die(e),
      ),
      Effect.provideContext(context),
    ),
});

/**
 * HTTP (data-plane) implementation of {@link ReadBlob}.
 *
 * Deploy half: contributes the host Function's project onto the store's
 * binding contract (the store's reconciler creates the connection, which
 * makes the platform inject `BLOB_READ_WRITE_TOKEN`). Runtime half: the
 * read-only client over `https://blob.vercel-storage.com`.
 *
 * ## Runtime authorization
 *
 * Deployed compute is authorized by the **platform-injected
 * `BLOB_READ_WRITE_TOKEN`** that Vercel provisions when the store is
 * connected to the Function's project — alchemy never mints, stores, or
 * syncs a Blob credential itself; the deploy half only declares the
 * store↔project connection. The token is store-scoped but read-write: the
 * platform offers no read-only variant, so this binding's least-privilege
 * guarantee is enforced at the **client surface** (no `put`/`del` methods
 * exist on {@link ReadBlobClient}), not at the credential.
 *
 * Provide on the Function's init Effect:
 * `Effect.provide(Vercel.ReadBlobHttp)`.
 */
export const ReadBlobHttp: Layer.Layer<
  ReadBlob,
  never,
  HttpClient.HttpClient | FunctionEnvironment
> = Layer.effect(
  ReadBlob,
  Effect.gen(function* () {
    const context = yield* Effect.context<HttpClient.HttpClient>();
    return yield* makeBlobHttpBinding({
      makeClient: (scope) => makeReadBlobClient(scope, context),
    });
  }),
);
