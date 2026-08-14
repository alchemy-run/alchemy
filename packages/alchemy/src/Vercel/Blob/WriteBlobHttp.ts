import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { FunctionEnvironment } from "../Functions/FunctionBridge.ts";
import {
  deleteBlobsRaw,
  makeBlobHttpBinding,
  putBlobRaw,
  type BlobScope,
} from "./BlobHttp.ts";
import { WriteBlob, type WriteBlobClient } from "./WriteBlob.ts";
import type { PutBlobBody, PutBlobOptions } from "./BlobTypes.ts";

/**
 * Build a {@link WriteBlobClient} over a resolved data-plane scope. The
 * `HttpClient` context is captured once; every operation resolves the scope
 * lazily (so the platform-injected token is read from the live env).
 */
export const makeWriteBlobClient = (
  scope: Effect.Effect<BlobScope>,
  context: Context.Context<HttpClient.HttpClient>,
): WriteBlobClient => ({
  put: (pathname: string, body: PutBlobBody, options?: PutBlobOptions) =>
    scope.pipe(
      Effect.flatMap((s) => putBlobRaw(s, pathname, body, options)),
      Effect.provideContext(context),
    ),
  del: (pathnames: string | readonly string[]) =>
    scope.pipe(
      Effect.flatMap((s) =>
        deleteBlobsRaw(
          s,
          typeof pathnames === "string" ? [pathnames] : pathnames,
        ),
      ),
      Effect.provideContext(context),
    ),
});

/**
 * HTTP (data-plane) implementation of {@link WriteBlob}.
 *
 * Deploy half: contributes the host Function's project onto the store's
 * binding contract (the store's reconciler creates the connection, which
 * makes the platform inject `BLOB_READ_WRITE_TOKEN`). Runtime half: the
 * write-only client over `https://blob.vercel-storage.com`.
 *
 * Provide on the Function's init Effect:
 * `Effect.provide(Vercel.WriteBlobHttp)`.
 */
export const WriteBlobHttp: Layer.Layer<
  WriteBlob,
  never,
  HttpClient.HttpClient | FunctionEnvironment
> = Layer.effect(
  WriteBlob,
  Effect.gen(function* () {
    const context = yield* Effect.context<HttpClient.HttpClient>();
    return yield* makeBlobHttpBinding({
      makeClient: (scope) => makeWriteBlobClient(scope, context),
    });
  }),
);
