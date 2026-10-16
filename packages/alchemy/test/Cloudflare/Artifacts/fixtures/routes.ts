import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Stream from "effect/Stream";
import type { ReadWriteNamespaceClient } from "@/Cloudflare/Artifacts/ReadWriteNamespace.ts";

/** Small public repo used to seed git content for the read routes. */
export const IMPORT_URL = "https://github.com/octocat/Hello-World";

/**
 * Routes that exercise every method of {@link ReadWriteNamespaceClient} and its
 * repository handle over `fetch`. Every failure is surfaced as
 * `{ error: <_tag>, message }` with status 500 so the test sees which typed
 * error the binding produced.
 *
 * - `POST /create?name=`        create
 * - `GET  /list`                list (page of 1) + listAll
 * - `GET  /get?name=`           get + info → `{ found, info }` (`found: false` on `ArtifactsNotFound`)
 * - `DELETE /delete?name=`      delete
 * - `POST /import?name=`        import {@link IMPORT_URL} (depth 1)
 * - `POST /tokens?name=`        createToken → listTokens → revokeToken
 * - `POST /fork?name=&target=`  fork
 * - `GET  /content?name=`       log → readCommit → readTree → readBlob → readFile
 *
 * Returns `undefined` for unknown paths so the worker shell can 404.
 */
export const artifactsRoutes = (client: ReadWriteNamespaceClient, url: URL) => {
  const name = url.searchParams.get("name") ?? "";
  const route = (() => {
    switch (url.pathname) {
      case "/create":
        return client.create(name, { setDefaultBranch: "main", description: "binding test" }).pipe(
          Effect.map((repo) => ({
            name: repo.name,
            remote: repo.remote,
            defaultBranch: repo.defaultBranch,
            hasToken: typeof repo.token === "string" && repo.token.length > 0,
          })),
        );
      case "/list":
        return Effect.gen(function* () {
          const page = yield* client.list({ limit: 1 });
          const all = yield* client.listAll({ limit: 2 }).pipe(Stream.runCollect);
          return {
            pageSize: page.repos.length,
            hasCursor: page.cursor !== undefined,
            total: page.total,
            names: Array.from(all, (r) => r.name),
          };
        });
      case "/get":
        return client.get(name).pipe(
          Effect.flatMap((repo) => repo.info()),
          Effect.map((info) => ({ found: true, info })),
          Effect.catchTag("ArtifactsNotFound", () => Effect.succeed({ found: false })),
        );
      case "/delete":
        return client.delete(name).pipe(Effect.map((deleted) => ({ deleted })));
      case "/import":
        return client
          .import({
            source: { url: IMPORT_URL, depth: 1 },
            target: { name, opts: { description: "imported" } },
          })
          .pipe(Effect.map((repo) => ({ name: repo.name, remote: repo.remote })));
      case "/tokens":
        return Effect.gen(function* () {
          const repo = yield* client.get(name);
          const minted = yield* repo.createToken("read", 120);
          const listed = yield* repo.listTokens();
          const revoked = yield* repo.revokeToken(minted.id);
          const revokedUnknown = yield* repo.revokeToken("0000000000000000");
          yield* repo.dispose();
          return {
            scope: minted.scope,
            hasPlaintext: minted.plaintext.length > 0,
            listed: listed.tokens.some((t) => t.id === minted.id),
            revoked,
            revokedUnknown,
          };
        });
      case "/fork":
        return client.get(name).pipe(
          Effect.flatMap((repo) =>
            repo.fork(url.searchParams.get("target") ?? "", { defaultBranchOnly: true }),
          ),
          Effect.map((fork) => ({ name: fork.name, remote: fork.remote })),
        );
      case "/content":
        return Effect.gen(function* () {
          const repo = yield* client.get(name);
          const [head] = yield* repo.log({ limit: 1 });
          if (!head) return { empty: true };
          const commit = yield* repo.readCommit(head.hash);
          const tree = (yield* repo.readTree(head.treeHash)) ?? [];
          const entry = tree.find((e) => e.type === "blob");
          const blob = entry ? yield* repo.readBlob(entry.hash) : null;
          const file = entry ? yield* repo.readFile({ ref: head.hash, path: entry.name }) : null;
          const missingCommit = yield* repo.readCommit("0".repeat(40));
          const blobText = blob ? yield* Effect.promise(() => blob.text()) : null;
          const fileText = file ? yield* Effect.promise(() => file.text()) : null;
          return {
            empty: false,
            head: head.hash,
            commitMatches: commit?.hash === head.hash,
            entries: tree.map((e) => e.name),
            entry: entry?.name,
            blobMatchesFile: blobText !== null && blobText === fileText,
            fileType: file?.type,
            missingCommit,
          };
        });
      default:
        return undefined;
    }
  })();
  if (route === undefined) return Effect.succeed(undefined);
  return (route as unknown as Effect.Effect<unknown, { _tag: string; message: string }>).pipe(
    Effect.flatMap((body) => HttpServerResponse.json(body)),
    Effect.catch((error) =>
      HttpServerResponse.json({ error: error._tag, message: error.message }, { status: 500 }),
    ),
  );
};
