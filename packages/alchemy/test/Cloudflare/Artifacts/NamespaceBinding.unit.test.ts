import { makeArtifactsNamespaceClient } from "@/Cloudflare/Artifacts/NamespaceBinding.ts";
import {
  InvalidNamespaceError,
  Namespace,
  type Namespace as ArtifactsNamespace,
} from "@/Cloudflare/Artifacts/Namespace.ts";
import type {
  CommitMetadata,
  RepoHandle,
  TreeEntry,
} from "@/Cloudflare/Artifacts/ReadWriteNamespace.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
import { Stack, type StackSpec } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import { describe, expect, it } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

const tags = [
  "unit",
  "provider:cloudflare",
  "provider:cloudflare:artifacts",
  "local",
];

const namespace: ArtifactsNamespace = {
  kind: "Cloudflare.Artifacts.Namespace",
  name: "Repos",
  namespace: "repos",
};

const commit: CommitMetadata = {
  hash: "a".repeat(40),
  treeHash: "b".repeat(40),
  message: "Save version 2",
  author: { name: "Ada", email: "ada@example.com" },
  committer: { name: "Ada", email: "ada@example.com" },
  parents: ["c".repeat(40)],
  authoredAt: 1_790_000_000,
  committedAt: 1_790_000_000,
};

const tree: TreeEntry[] = [
  { name: "workbook.json", mode: "100644", hash: "d".repeat(40), type: "blob" },
  { name: "sheets", mode: "40000", hash: "e".repeat(40), type: "tree" },
];

/** The shape workerd throws from the binding: an Error with `code`. */
const platformError = (code: string, numericCode: number, message: string) =>
  Object.assign(new Error(message), {
    name: "ArtifactsError",
    code,
    numericCode,
  });

const unexpected = (): never => {
  throw new Error("unexpected call");
};

/** A repo handle whose methods record their arguments. */
const fakeRepo = (overrides: Partial<RepoHandle> = {}) => {
  const calls: Array<[string, unknown[]]> = [];
  const record =
    <A extends unknown[], R>(method: string, result: () => R) =>
    async (...args: A): Promise<R> => {
      calls.push([method, args]);
      return result();
    };
  const repo: RepoHandle = {
    info: record("info", () => ({
      id: "repo-id",
      name: "book",
      description: null,
      defaultBranch: "main",
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
      lastPushAt: null,
      source: null,
      readOnly: false,
      remote: "https://example.artifacts.cloudflare.net/repos/book.git",
    })),
    log: record("log", () => [commit]),
    readCommit: record("readCommit", () => commit),
    readTree: record("readTree", () => tree),
    readBlob: record("readBlob", () => new Blob(["{}"])),
    readFile: record(
      "readFile",
      () => new Blob(["{}"], { type: "application/json" }),
    ),
    listTokens: record("listTokens", () => ({ tokens: [], total: 0 })),
    createToken: record("createToken", () => ({
      id: "token-id",
      plaintext: "secret",
      scope: "read" as const,
      expiresAt: "2026-10-02T00:00:00Z",
    })),
    revokeToken: record("revokeToken", () => true),
    fork: record("fork", unexpected),
    ...overrides,
  };
  return { repo, calls };
};

/** A namespace binding whose `get` resolves through `get`. */
const fakeBinding = (get: (name: string) => Promise<unknown>) =>
  makeArtifactsNamespaceClient(
    {
      Repos: {
        get,
        create: unexpected,
        list: unexpected,
        delete: unexpected,
        import: unexpected,
      },
    },
    namespace,
  );

const runtime = Effect.provide(RuntimeContext.phantom);

describe("Artifacts repo reads", { tags }, () => {
  it.effect("forwards every read method to the repo handle", () =>
    Effect.gen(function* () {
      const { repo, calls } = fakeRepo();
      const client = fakeBinding(async () => repo);
      const handle = yield* client.get("book");

      expect((yield* handle.info()).defaultBranch).toBe("main");
      expect(yield* handle.log({ ref: "main", limit: 10, offset: 5 })).toEqual([
        commit,
      ]);
      expect(yield* handle.readCommit(commit.hash)).toEqual(commit);
      expect(yield* handle.readTree(commit.treeHash)).toEqual(tree);
      const blob = yield* handle.readBlob(tree[0]!.hash);
      expect(yield* Effect.promise(() => blob!.text())).toBe("{}");
      const file = yield* handle.readFile({
        ref: commit.hash,
        path: "workbook.json",
      });
      expect(file?.type).toContain("application/json");

      expect(calls).toEqual([
        ["info", []],
        ["log", [{ ref: "main", limit: 10, offset: 5 }]],
        ["readCommit", [commit.hash]],
        ["readTree", [commit.treeHash]],
        ["readBlob", [tree[0]!.hash]],
        ["readFile", [{ ref: commit.hash, path: "workbook.json" }]],
      ]);
    }).pipe(runtime),
  );

  it.effect("passes a missing object through as null", () =>
    Effect.gen(function* () {
      const { repo } = fakeRepo({
        readCommit: async () => null,
        readTree: async () => null,
        readBlob: async () => null,
        readFile: async () => null,
      });
      const handle = yield* fakeBinding(async () => repo).get("book");

      expect(yield* handle.readCommit(commit.hash)).toBeNull();
      expect(yield* handle.readTree(commit.treeHash)).toBeNull();
      expect(yield* handle.readBlob(commit.hash)).toBeNull();
      expect(yield* handle.readFile({ ref: "main", path: "nope" })).toBeNull();
    }).pipe(runtime),
  );

  it.effect("keeps the write methods on a read-write handle", () =>
    Effect.gen(function* () {
      const { repo, calls } = fakeRepo();
      const handle = yield* fakeBinding(async () => repo).get("book");

      expect((yield* handle.createToken("read", 3600)).plaintext).toBe(
        "secret",
      );
      expect(yield* handle.revokeToken("token-id")).toBe(true);
      expect(calls).toEqual([
        ["createToken", ["read", 3600]],
        ["revokeToken", ["token-id"]],
      ]);
    }).pipe(runtime),
  );
});

describe("ArtifactsError", { tags }, () => {
  it.effect("carries the platform code of a failed read", () =>
    Effect.gen(function* () {
      const { repo } = fakeRepo({
        readBlob: async () => {
          throw platformError("MEMORY_LIMIT", 10402, "blob too large");
        },
      });
      const handle = yield* fakeBinding(async () => repo).get("book");

      const error = yield* Effect.flip(handle.readBlob(commit.hash));
      expect(error._tag).toBe("ArtifactsError");
      expect(error.code).toBe("MEMORY_LIMIT");
      expect(error.numericCode).toBe(10402);
      expect(error.message).toBe("blob too large");
    }).pipe(runtime),
  );

  it.effect("tells a missing repo from an outage on get", () =>
    Effect.gen(function* () {
      const client = fakeBinding(async (name) => {
        if (name === "missing") {
          throw platformError("NOT_FOUND", 10200, "Repository not found");
        }
        throw platformError("INTERNAL_ERROR", 10400, "Internal error");
      });

      const lookup = (name: string) =>
        client.get(name).pipe(
          Effect.as("found" as const),
          Effect.catchTag("ArtifactsError", (e) =>
            e.code === "NOT_FOUND"
              ? Effect.succeed("missing" as const)
              : Effect.fail(e),
          ),
        );

      expect(yield* lookup("missing")).toBe("missing");
      const outage = yield* Effect.flip(lookup("other"));
      expect(outage.code).toBe("INTERNAL_ERROR");
      expect(outage.numericCode).toBe(10400);
    }).pipe(runtime),
  );

  it.effect("reports a null repo as NOT_FOUND", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        fakeBinding(async () => null).get("book"),
      );
      expect(error.code).toBe("NOT_FOUND");
      expect(error.numericCode).toBe(10200);
      expect(error.message).toContain("'book'");
    }).pipe(runtime),
  );

  it.effect("leaves code undefined when the failure carries none", () =>
    Effect.gen(function* () {
      const plain = yield* Effect.flip(
        fakeBinding(async () => {
          throw new Error("Network connection lost.");
        }).get("book"),
      );
      expect(plain.code).toBeUndefined();
      expect(plain.numericCode).toBeUndefined();
      expect(plain.message).toBe("Network connection lost.");

      const unknownCode = yield* Effect.flip(
        fakeBinding(async () => {
          throw platformError("SOMETHING_NEW", 10999, "new failure");
        }).get("book"),
      );
      expect(unknownCode.code).toBeUndefined();
      expect(unknownCode.numericCode).toBe(10999);
    }).pipe(runtime),
  );
});

const stack: Omit<StackSpec, "output"> = {
  name: "artifacts-test",
  stage: "test",
  resources: {},
  bindings: {},
  actions: {},
};

const declare = (name: string, namespaceName?: string) =>
  Namespace(
    name,
    namespaceName === undefined ? undefined : { namespace: namespaceName },
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(Stack, stack),
        Layer.succeed(Stage, stack.stage),
      ),
    ),
    Effect.exit,
  );

describe("Artifacts Namespace name validation", { tags }, () => {
  it.effect("accepts every name the platform accepts", () =>
    Effect.gen(function* () {
      for (const name of [
        "ab",
        "starter-repos",
        "Tenant_42.prod",
        "9lives",
        "a".repeat(63),
      ]) {
        const exit = yield* declare("Repos", name);
        expect(Exit.isSuccess(exit)).toBe(true);
      }
      const derived = yield* declare("Repos");
      expect(Exit.isSuccess(derived) && derived.value.namespace).toBe("repos");
    }),
  );

  it.effect("rejects names the platform rejects", () =>
    Effect.gen(function* () {
      for (const name of [
        "a",
        "-repos",
        ".repos",
        "repos/prod",
        "repos prod",
        "a".repeat(64),
      ]) {
        const exit = yield* declare("Repos", name);
        expect(
          Exit.isFailure(exit) &&
            Cause.squash(exit.cause) instanceof InvalidNamespaceError,
        ).toBe(true);
      }
    }),
  );
});
