/**
 * THE WHOLE TREE, at once — `GET /api/forge/repos/:owner/:repo/tree`.
 *
 * The v1 git API pages tree by tree (one request per directory), which
 * is the wrong shape for a code browser: the UI wants the entire file
 * list in one response and a client-side tree. We own the server, so
 * the forge walks the commit's tree graph server-side — breadth-first
 * over the SAME Durable Objects the git routes read — and answers
 * every path in one JSON body, cached per commit oid (a commit's tree
 * is immutable, so the cache can never be stale; a push moves the ref
 * to a NEW commit and misses the cache by construction).
 */
import {
  HasherInline,
  Operations,
  OperationsLive,
  RegistryDurableObject,
  ReposDurableObject,
} from "alchemy/Git";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { GitBlobStore } from "./GitServer.ts";

const TreeOps = OperationsLive.pipe(
  Layer.provide(ReposDurableObject),
  Layer.provide(RegistryDurableObject),
  Layer.provide(HasherInline),
  Layer.provide(GitBlobStore),
);

export interface TreeFile {
  readonly path: string;
  /** blob | exec | link | submodule — the UI mostly cares blob-vs-not. */
  readonly kind: string;
}

interface Snapshot {
  readonly commit: string;
  readonly files: ReadonlyArray<TreeFile>;
}

/** One snapshot per commit oid — immutable, so never invalidated. */
const cache = new Map<string, Snapshot>();
const CACHE_KEYS = 24;

/** A repo big enough to hit this is a digest, not a browser target. */
const MAX_FILES = 50_000;

export const TreeApi = Effect.gen(function* () {
  const context = yield* Layer.build(TreeOps);
  const ops = Context.get(context, Operations);

  return HttpRouter.add(
    "GET",
    "/api/forge/repos/:owner/:repo/tree",
    Effect.gen(function* () {
      const { owner, repo } = (yield* HttpRouter.params) as {
        owner: string;
        repo: string;
      };
      const request = yield* HttpServerRequest;
      const ref =
        new URL(request.url, "http://x").searchParams.get("ref") ?? "HEAD";

      // the ref's tip — log(limit 1) answers the commit AND its tree
      const tip = yield* ops.objects
        .log({ params: { owner, repo }, query: { ref, limit: 1 } })
        .pipe(Effect.orDie);
      const head = tip.items[0];
      if (head === undefined) {
        return yield* HttpServerResponse.json(
          { error: "empty repository" },
          { status: 404 },
        );
      }

      const key = `${owner}/${repo}@${head.oid}`;
      const cached = cache.get(key);
      if (cached !== undefined) {
        return yield* HttpServerResponse.json({
          ref,
          commit: cached.commit,
          files: cached.files,
        });
      }

      // BFS the tree graph, one level of directories per round,
      // sibling directories read concurrently
      const files: TreeFile[] = [];
      type Node = { prefix: string; oid: typeof head.tree };
      let level: Array<Node> = [{ prefix: "", oid: head.tree }];
      while (level.length > 0 && files.length < MAX_FILES) {
        const next: Array<Node> = [];
        const trees = yield* Effect.forEach(
          level,
          (node) =>
            ops.objects.tree({ params: { owner, repo, oid: node.oid } }).pipe(
              Effect.map((tree) => ({ node, tree })),
              Effect.orDie,
            ),
          { concurrency: 12 },
        );
        for (const { node, tree } of trees) {
          for (const entry of tree.entries) {
            const path = `${node.prefix}${entry.name}`;
            if (entry.type === "tree") {
              next.push({ prefix: `${path}/`, oid: entry.oid });
            } else {
              files.push({ path, kind: entry.type });
            }
          }
        }
        level = next;
      }
      files.sort((a, b) => a.path.localeCompare(b.path));

      const snapshot: Snapshot = { commit: head.oid, files };
      cache.set(key, snapshot);
      if (cache.size > CACHE_KEYS) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      return yield* HttpServerResponse.json({
        ref,
        commit: snapshot.commit,
        files: snapshot.files,
      });
    }),
  );
});
