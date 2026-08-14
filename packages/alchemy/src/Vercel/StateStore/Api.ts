import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";
import { createHash, timingSafeEqual } from "node:crypto";
import { RuntimeContext } from "../../RuntimeContext.ts";
import {
  BearerTokenValidator,
  StateApi,
  StateAuthLive,
} from "../../State/HttpStateApi.ts";
import { BlobStore } from "../Blob/BlobStore.ts";
import { ReadWriteBlob } from "../Blob/ReadWriteBlob.ts";
import { ReadWriteBlobHttp } from "../Blob/ReadWriteBlobHttp.ts";
import { Function } from "../Functions/Function.ts";
import { FunctionEnvironment } from "../Functions/FunctionBridge.ts";
import { decryptRow, encryptRow, importStateKey } from "./Codec.ts";
import {
  outputKey,
  parseRowKey,
  parseStackIndexKey,
  rowKey,
  STACK_INDEX_PREFIX,
  stackIndexKey,
  stackOutputsPrefix,
  stackRowsPrefix,
  stagePrefix,
} from "./Keys.ts";
import { STATE_ENCRYPTION_KEY_ENV, STATE_TOKEN_ENV } from "./Token.ts";

/**
 * Deterministic name of the state-store Vercel project (and of its
 * private Blob store). Deterministic so `loginWithVercel` can find the
 * deployed store without any local state. Overridable via
 * `ALCHEMY_VERCEL_STATE_PROJECT` (advanced — parallel stores / tests).
 */
export const STATE_STORE_PROJECT_NAME =
  process.env.ALCHEMY_VERCEL_STATE_PROJECT ?? "alchemy-state";

/**
 * Version of the deployed Vercel State Store function contract.
 *
 * Bump this whenever the wire format or runtime behaviour changes in a
 * way an older deployed copy can no longer satisfy. Clients query
 * `/version` on the deployed function and compare against this constant;
 * a mismatch (or 404) triggers a redeploy via the bootstrap flow.
 */
export const STATE_STORE_VERSION = 1 as const;

/**
 * The private Blob store holding one encrypted JSON blob per state row.
 * Bound to the state Function through the `ReadWriteBlob` capability,
 * which transparently connects the Function's project (injecting the
 * data-plane token env) — the store itself is deployed by the same
 * bootstrap stack.
 */
export const StateBlob = BlobStore("Store", {
  name: STATE_STORE_PROJECT_NAME,
  access: "private",
});

/** Content type stored with every state row (framed base64 text). */
const ROW_CONTENT_TYPE = "text/plain";

/** Hard page cap for prefix listings (1000 rows per page). */
const MAX_LIST_PAGES = 200;

/**
 * Constant-time string comparison (fixed-length sha256 digests close the
 * per-char timing leak; the trailing `===` guards the astronomically
 * unlikely digest collision). Mirrors the bridge's cron-secret check.
 */
const timingSafeStringEqual = (a: string, b: string): boolean => {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB) && a === b;
};

/**
 * The state-store Vercel Function (DESIGN §13): implements the shared
 * {@link StateApi} HttpApi contract — bearer auth via
 * {@link BearerTokenValidator}, unauthenticated `/version` pinned to
 * {@link STATE_STORE_VERSION} — over the private {@link StateBlob}
 * store, with AES-CTR row encryption keyed from the
 * `ALCHEMY_STATE_ENCRYPTION_KEY` project env var. Deployed by alchemy's
 * own Vercel deploy engine from `Vercel.state()` / `alchemy vercel
 * bootstrap`.
 */
export default class Api extends Function<Api>()(
  "Api",
  {
    name: STATE_STORE_PROJECT_NAME,
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const blob = yield* ReadWriteBlob(StateBlob);
    const env = yield* FunctionEnvironment;

    // The Blob capability's runtime ops are colored with RuntimeContext;
    // inside the deployed Function that requirement is definitionally
    // satisfied.
    const runtime = Effect.provide(RuntimeContext.phantom);

    // Import the AES-CTR key once per instance, lazily on first use (the
    // env record is empty at plan time, so nothing may read it eagerly).
    const cryptoKey = yield* Effect.cached(
      Effect.suspend(() => {
        const hex = env[STATE_ENCRYPTION_KEY_ENV];
        if (hex === undefined || hex === "") {
          return Effect.die(
            new Error(
              `Vercel state store: ${STATE_ENCRYPTION_KEY_ENV} is not set — ` +
                "the bootstrap stack binds it as a project env var; redeploy via 'alchemy vercel bootstrap'.",
            ),
          );
        }
        return importStateKey(hex);
      }),
    );

    const bearerTokenValidator = Layer.succeed(
      BearerTokenValidator,
      BearerTokenValidator.of({
        validate: Effect.fn(function* (token) {
          const expected = env[STATE_TOKEN_ENV];
          return !!expected &&
            timingSafeStringEqual(token.trim(), expected.trim())
            ? yield* Effect.void
            : yield* new HttpApiError.Unauthorized();
        }),
      }),
    );

    /** Every pathname under `prefix`, across pagination (bounded). */
    const listAll = Effect.fn(function* (prefix: string) {
      const pathnames: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const result = yield* blob
          .list({ prefix, limit: 1000, cursor })
          .pipe(runtime, Effect.orDie);
        for (const row of result.blobs) pathnames.push(row.pathname);
        if (!result.hasMore || result.cursor === undefined) break;
        cursor = result.cursor;
      }
      return pathnames;
    });

    /** Read + decrypt a row; `undefined` when absent. */
    const readRow = (pathname: string) =>
      blob.get(pathname).pipe(
        Effect.flatMap((got) => got.text),
        Effect.flatMap((framed) =>
          Effect.flatMap(cryptoKey, (key) => decryptRow(key, framed)),
        ),
        Effect.catchTag("Vercel.Blob.NotFound", () =>
          Effect.succeed(undefined),
        ),
        runtime,
        Effect.orDie,
      );

    /** Encrypt + write a row (whole-blob PUT — atomic per key). */
    const writeRow = (pathname: string, value: unknown) =>
      Effect.flatMap(cryptoKey, (key) => encryptRow(key, value)).pipe(
        Effect.flatMap((framed) =>
          blob.put(pathname, framed, { contentType: ROW_CONTENT_TYPE }),
        ),
        Effect.asVoid,
        runtime,
        Effect.orDie,
      );

    /** Idempotent batch delete. */
    const removeRows = (pathnames: readonly string[]) =>
      pathnames.length === 0
        ? Effect.void
        : blob.del(pathnames).pipe(runtime, Effect.orDie);

    /** Register a stack in the global index (idempotent overwrite). */
    const registerStack = (stack: string) =>
      blob
        .put(stackIndexKey(stack), "1", { contentType: ROW_CONTENT_TYPE })
        .pipe(Effect.asVoid, runtime, Effect.orDie);

    const versionApi = HttpApiBuilder.group(StateApi, "version", (handlers) =>
      handlers.handle("getVersion", () =>
        Effect.succeed({ version: STATE_STORE_VERSION }).pipe(
          Effect.withSpan("state_store.getVersion", {
            attributes: { "alchemy.state_store.op": "getVersion" },
          }),
        ),
      ),
    );

    const stateApi = HttpApiBuilder.group(StateApi, "state", (handlers) =>
      handlers
        .handle("listStacks", () =>
          listAll(STACK_INDEX_PREFIX).pipe(
            Effect.map((pathnames) =>
              pathnames.flatMap((pathname) => {
                const stack = parseStackIndexKey(pathname);
                return stack === undefined ? [] : [stack];
              }),
            ),
            Effect.withSpan("state_store.listStacks", {
              attributes: { "alchemy.state_store.op": "listStacks" },
            }),
          ),
        )
        .handle("listStages", ({ params }) =>
          listAll(stackRowsPrefix(params.stack)).pipe(
            Effect.map((pathnames) => {
              const stages = new Set<string>();
              for (const pathname of pathnames) {
                const parsed = parseRowKey(pathname);
                if (parsed?.stack === params.stack) stages.add(parsed.stage);
              }
              return [...stages];
            }),
            Effect.withSpan("state_store.listStages", {
              attributes: {
                "alchemy.state_store.op": "listStages",
                "alchemy.state_store.stack": params.stack,
              },
            }),
          ),
        )
        .handle("listResources", ({ params }) =>
          listAll(stagePrefix(params.stack, params.stage)).pipe(
            Effect.map((pathnames) =>
              pathnames.flatMap((pathname) => {
                const parsed = parseRowKey(pathname);
                return parsed === undefined ? [] : [parsed.fqn];
              }),
            ),
            Effect.withSpan("state_store.listResources", {
              attributes: {
                "alchemy.state_store.op": "listResources",
                "alchemy.state_store.stack": params.stack,
                "alchemy.state_store.stage": params.stage,
              },
            }),
          ),
        )
        .handle("getState", ({ params }) => {
          const fqn = decodeURIComponent(params.fqn);
          return readRow(rowKey(params.stack, params.stage, fqn)).pipe(
            Effect.withSpan("state_store.getState", {
              attributes: {
                "alchemy.state_store.op": "getState",
                "alchemy.state_store.stack": params.stack,
                "alchemy.state_store.stage": params.stage,
                "alchemy.state_store.fqn": fqn,
              },
            }),
          );
        })
        .handle("setState", ({ params, payload }) => {
          const fqn = decodeURIComponent(params.fqn);
          return writeRow(
            rowKey(params.stack, params.stage, fqn),
            payload,
          ).pipe(
            Effect.andThen(registerStack(params.stack)),
            Effect.map(() => payload),
            Effect.withSpan("state_store.setState", {
              attributes: {
                "alchemy.state_store.op": "setState",
                "alchemy.state_store.stack": params.stack,
                "alchemy.state_store.stage": params.stage,
                "alchemy.state_store.fqn": fqn,
              },
            }),
          );
        })
        .handle("deleteState", ({ params }) => {
          const fqn = decodeURIComponent(params.fqn);
          return removeRows([rowKey(params.stack, params.stage, fqn)]).pipe(
            Effect.withSpan("state_store.deleteState", {
              attributes: {
                "alchemy.state_store.op": "deleteState",
                "alchemy.state_store.stack": params.stack,
                "alchemy.state_store.stage": params.stage,
                "alchemy.state_store.fqn": fqn,
              },
            }),
          );
        })
        .handle("getReplacedResources", ({ params }) =>
          listAll(stagePrefix(params.stack, params.stage)).pipe(
            Effect.flatMap((pathnames) =>
              Effect.forEach(pathnames, readRow, {
                concurrency: 8,
              }),
            ),
            Effect.map((rows) =>
              rows.filter(
                (row): row is { status: string } =>
                  typeof row === "object" &&
                  row !== null &&
                  (row as { status?: unknown }).status === "replaced",
              ),
            ),
            Effect.withSpan("state_store.getReplacedResources", {
              attributes: {
                "alchemy.state_store.op": "getReplacedResources",
                "alchemy.state_store.stack": params.stack,
                "alchemy.state_store.stage": params.stage,
              },
            }),
          ),
        )
        .handle("getStackOutput", ({ params }) =>
          readRow(outputKey(params.stack, params.stage)).pipe(
            Effect.withSpan("state_store.getStackOutput", {
              attributes: {
                "alchemy.state_store.op": "getStackOutput",
                "alchemy.state_store.stack": params.stack,
                "alchemy.state_store.stage": params.stage,
              },
            }),
          ),
        )
        .handle("setStackOutput", ({ params, payload }) =>
          writeRow(outputKey(params.stack, params.stage), payload).pipe(
            Effect.andThen(registerStack(params.stack)),
            Effect.map(() => payload),
            Effect.withSpan("state_store.setStackOutput", {
              attributes: {
                "alchemy.state_store.op": "setStackOutput",
                "alchemy.state_store.stack": params.stack,
                "alchemy.state_store.stage": params.stage,
              },
            }),
          ),
        )
        .handle("deleteStack", ({ params, query }) =>
          Effect.gen(function* () {
            if (query.stage !== undefined) {
              const rows = yield* listAll(
                stagePrefix(params.stack, query.stage),
              );
              yield* removeRows([
                ...rows,
                outputKey(params.stack, query.stage),
              ]);
            } else {
              const rows = yield* listAll(stackRowsPrefix(params.stack));
              const outputs = yield* listAll(stackOutputsPrefix(params.stack));
              yield* removeRows([
                ...rows,
                ...outputs,
                stackIndexKey(params.stack),
              ]);
            }
          }).pipe(
            Effect.withSpan("state_store.deleteStack", {
              attributes: {
                "alchemy.state_store.op": "deleteStack",
                "alchemy.state_store.stack": params.stack,
                "alchemy.state_store.stage": query.stage ?? "",
                "alchemy.state_store.scope":
                  query.stage === undefined ? "stack" : "stage",
              },
            }),
          ),
        ),
    );

    return {
      fetch: HttpApiBuilder.layer(StateApi).pipe(
        Layer.provide(stateApi),
        Layer.provide(versionApi),
        Layer.provide(StateAuthLive),
        Layer.provide(bearerTokenValidator),
        // The state-store function never serves files, so HttpPlatform's
        // file-response surface is stubbed (mirrors the Cloudflare store).
        Layer.provide([Etag.layer, HttpPlatformStub, Path.layer]),
        HttpRouter.toHttpEffect,
      ),
    };
  }).pipe(Effect.provide(ReadWriteBlobHttp)),
) {}

/**
 * Stub `HttpPlatform`: the state API never issues file responses, so
 * both surface methods die if invoked.
 */
const HttpPlatformStub = Layer.succeed(HttpPlatform.HttpPlatform, {
  platform: "web",
  compression: {
    algorithms: new Set<HttpPlatform.CompressionAlgorithm>(),
    compressResponse: (response) => Effect.succeed(response),
  },
  fileResponse: () => Effect.die("HttpPlatform.fileResponse not supported"),
  fileWebResponse: () =>
    Effect.die("HttpPlatform.fileWebResponse not supported"),
});
