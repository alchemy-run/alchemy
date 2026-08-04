import { AlchemyContext } from "@/AlchemyContext.ts";
import { InstanceId } from "@/InstanceId.ts";
import * as Provider from "@/Provider.ts";
import * as SpacetimeDB from "@/SpacetimeDB";
import { Database, DatabaseProviderLive } from "@/SpacetimeDB/Database.ts";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "alchemy-test";
import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

const WASM_BYTES = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
]);

const writeTempWasm = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectory({ prefix: "alchemy-stdb-" });
  const file = path.join(dir, "module.wasm");
  yield* fs.writeFile(file, WASM_BYTES);
  return file;
});

type Row = {
  databaseIdentity: string;
  ownerIdentity: string;
  hostType: string;
  initialProgram: string;
  names: string[];
};

type Store = {
  byIdentity: Map<string, Row>;
  nameToIdentity: Map<string, string>;
  nextId: number;
};

const emptyStore = (): Store => ({
  byIdentity: new Map(),
  nameToIdentity: new Map(),
  nextId: 1,
});

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const resolveId = (store: Store, nameOrIdentity: string) =>
  store.byIdentity.get(nameOrIdentity)?.databaseIdentity ??
  store.nameToIdentity.get(nameOrIdentity);

const mockHttpForStore = (store: Store): HttpClient.HttpClient =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      const method = request.method;
      const parts = url.pathname.split("/").filter(Boolean);

      const json = (status: number, body: unknown) =>
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          }),
        );

      const text = (status: number, body: string) =>
        HttpClientResponse.fromWeb(request, new Response(body, { status }));

      if (
        parts[0] === "v1" &&
        parts[1] === "identity" &&
        parts[3] === "databases"
      ) {
        return json(200, { identities: [...store.byIdentity.keys()] });
      }

      if (parts[0] === "v1" && parts[1] === "database") {
        const nameOrIdentity = decodeURIComponent(parts[2] ?? "");
        const sub = parts[3];

        if (method === "GET" && sub === "names") {
          const id = resolveId(store, nameOrIdentity);
          if (!id) return text(404, "not found");
          return json(200, { names: store.byIdentity.get(id)!.names });
        }

        if (method === "POST" && sub === "names") {
          const id = resolveId(store, nameOrIdentity);
          if (!id) return text(404, "not found");
          // Body isn't easily readable from the request in this mock; the
          // provider's rename path is covered by the create/update flow.
          return json(200, {
            Success: { domain: "ignored", database_result: id },
          });
        }

        if (method === "GET" && !sub) {
          const id = resolveId(store, nameOrIdentity);
          if (!id) return text(404, "not found");
          const row = store.byIdentity.get(id)!;
          return json(200, {
            database_identity: row.databaseIdentity,
            owner_identity: row.ownerIdentity,
            host_type: row.hostType,
            initial_program: row.initialProgram,
          });
        }

        if (method === "PUT" && !sub) {
          const existingId = resolveId(store, nameOrIdentity);
          const clear = url.searchParams.get("clear") === "true";
          const identity = existingId ?? `id-${store.nextId++}`;
          const programHash = createHash("sha256")
            .update(
              `prog-${identity}-${clear ? "cleared" : "kept"}-${store.byIdentity.size}`,
            )
            .digest("hex")
            .slice(0, 16);
          const existing = existingId
            ? store.byIdentity.get(existingId)!
            : undefined;
          const names =
            existing?.names ??
            (NAME_RE.test(nameOrIdentity) ? [nameOrIdentity] : []);
          const row: Row = {
            databaseIdentity: identity,
            ownerIdentity: "owner-test",
            hostType: "wasm",
            initialProgram: programHash,
            names,
          };
          store.byIdentity.set(identity, row);
          for (const n of names) store.nameToIdentity.set(n, identity);
          return json(200, {
            Success: {
              database_identity: identity,
              domain: names[0] ?? null,
              op: existingId ? "updated" : "created",
            },
          });
        }

        if (method === "DELETE" && !sub) {
          const id = resolveId(store, nameOrIdentity);
          if (!id) return text(404, "not found");
          const row = store.byIdentity.get(id)!;
          store.byIdentity.delete(id);
          for (const n of row.names) store.nameToIdentity.delete(n);
          return text(200, "");
        }
      }

      return text(500, `unhandled ${method} ${url.pathname}`);
    }),
  );

const testLayer = (store: Store) =>
  Layer.mergeAll(
    // Unit tests exercise the live HTTP path only (no spacetime CLI).
    DatabaseProviderLive(),
    SpacetimeDB.fromToken("test-token", {
      host: "https://maincloud.spacetimedb.com",
    }),
    Layer.succeed(HttpClient.HttpClient, mockHttpForStore(store)),
    Layer.succeed(Stage, "test"),
    Layer.succeed(Stack, {
      name: "test",
      stage: "test",
      resources: {},
      bindings: {},
      actions: {},
    }),
    Layer.succeed(AlchemyContext, {
      dev: false,
      adopt: false,
      dotAlchemy: ".alchemy",
    }),
    Layer.succeed(InstanceId, "0123456789abcdef0123456789abcdef"),
    NodeServices.layer,
  );

const reconcileInput = (
  news: SpacetimeDB.DatabaseProps,
  output?: SpacetimeDB.DatabaseAttributes,
  olds?: SpacetimeDB.DatabaseProps,
) =>
  ({
    id: "Game",
    fqn: "Game",
    news,
    olds,
    output,
    bindings: [],
  }) as any;

const deleteInput = (output: SpacetimeDB.DatabaseAttributes) =>
  ({
    id: "Game",
    fqn: "Game",
    output,
    props: { name: output.databaseName },
  }) as any;

describe("SpacetimeDB.Database provider", () => {
  it.effect("reconcile creates a database and returns connection attrs", () => {
    const store = emptyStore();
    return Effect.gen(function* () {
      const wasmPath = yield* writeTempWasm;
      const provider = yield* Provider.findProvider(Database);

      const created = yield* provider.reconcile(
        reconcileInput({ name: "my-game", binPath: wasmPath }),
      );

      expect(created.databaseName).toBe("my-game");
      expect(created.databaseIdentity).toMatch(/^id-/);
      expect(created.host).toBe("https://maincloud.spacetimedb.com");
      expect(created.uri).toBe("wss://maincloud.spacetimedb.com");
      expect(created.moduleContentHash).toBe(
        createHash("sha256").update(WASM_BYTES).digest("hex"),
      );
      expect(created.dashboardUrl).toBe("https://spacetimedb.com/my-game");
      expect(created.ownerIdentity).toBe("owner-test");
      expect(created.moduleSource).toEqual({
        kind: "binPath",
        path: wasmPath,
      });
      expect(store.byIdentity.size).toBe(1);
    }).pipe(Effect.provide(testLayer(store)));
  });

  it.effect("reconcile update keeps identity and delete is idempotent", () => {
    const store = emptyStore();
    return Effect.gen(function* () {
      const wasmPath = yield* writeTempWasm;
      const provider = yield* Provider.findProvider(Database);

      const created = yield* provider.reconcile(
        reconcileInput({ name: "my-game", binPath: wasmPath }),
      );

      const updated = yield* provider.reconcile(
        reconcileInput(
          { name: "my-game", binPath: wasmPath, clearData: true },
          created,
          { name: "my-game", binPath: wasmPath },
        ),
      );
      expect(updated.databaseIdentity).toBe(created.databaseIdentity);
      expect(store.byIdentity.size).toBe(1);

      yield* provider.delete(deleteInput(updated));
      expect(store.byIdentity.size).toBe(0);

      // Idempotent — second delete must not fail.
      yield* provider.delete(deleteInput(updated));
    }).pipe(Effect.provide(testLayer(store)));
  });

  it.effect("read returns undefined for missing databases", () => {
    const store = emptyStore();
    return Effect.gen(function* () {
      const provider = yield* Provider.findProvider(Database);
      const result = yield* provider.read!({
        id: "Game",
        fqn: "Game",
        output: {
          databaseIdentity: "missing-id",
          databaseName: "nope",
          host: "https://maincloud.spacetimedb.com",
          uri: "wss://maincloud.spacetimedb.com",
          moduleHash: "",
          moduleContentHash: "",
          ownerIdentity: "",
          hostType: "wasm",
          dashboardUrl: undefined,
          moduleSource: { kind: "binPath", path: "" },
        },
        olds: { name: "nope" },
      } as any);
      expect(result).toBeUndefined();
    }).pipe(Effect.provide(testLayer(store)));
  });

  it.effect(
    "diff flags host change as replace and module change as update",
    () => {
      const store = emptyStore();
      return Effect.gen(function* () {
        const wasmPath = yield* writeTempWasm;
        const provider = yield* Provider.findProvider(Database);
        const created = yield* provider.reconcile(
          reconcileInput({ name: "my-game", binPath: wasmPath }),
        );

        const hostReplace = yield* provider.diff!({
          id: "Game",
          fqn: "Game",
          news: { name: "my-game", binPath: wasmPath, host: "local" },
          olds: { name: "my-game", binPath: wasmPath },
          output: created,
        } as any);
        expect(hostReplace).toEqual({ action: "replace" });

        // Rewrite the wasm so the content hash changes.
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFile(
          wasmPath,
          new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0xff]),
        );
        const moduleUpdate = yield* provider.diff!({
          id: "Game",
          fqn: "Game",
          news: { name: "my-game", binPath: wasmPath },
          olds: { name: "my-game", binPath: wasmPath },
          output: created,
        } as any);
        expect(moduleUpdate).toEqual({ action: "update" });
      }).pipe(Effect.provide(testLayer(store)));
    },
  );

  it.effect("list enumerates databases owned by the token identity", () => {
    // Seed the store via reconcile, then list.
    const store = emptyStore();
    // list() decodes the JWT `sub` — fromToken uses a bare string, so mint a
    // minimal JWT so decodeTokenIdentity succeeds.
    const b64url = (v: string) =>
      Buffer.from(v)
        .toString("base64")
        .replace(/=+$/, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
    const token = `${b64url("{}")}.${b64url(JSON.stringify({ sub: "owner-test" }))}.x`;

    return Effect.gen(function* () {
      const wasmPath = yield* writeTempWasm;
      const provider = yield* Provider.findProvider(Database);
      const created = yield* provider.reconcile(
        reconcileInput({ name: "listed-game", binPath: wasmPath }),
      );
      const all = yield* provider.list();
      expect(
        all.some((r) => r.databaseIdentity === created.databaseIdentity),
      ).toBe(true);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          DatabaseProviderLive(),
          SpacetimeDB.fromToken(token, {
            host: "https://maincloud.spacetimedb.com",
          }),
          Layer.succeed(HttpClient.HttpClient, mockHttpForStore(store)),
          Layer.succeed(Stage, "test"),
          Layer.succeed(Stack, {
            name: "test",
            stage: "test",
            resources: {},
            bindings: {},
            actions: {},
          }),
          Layer.succeed(AlchemyContext, {
            dev: false,
            adopt: false,
            dotAlchemy: ".alchemy",
          }),
          Layer.succeed(InstanceId, "0123456789abcdef0123456789abcdef"),
          NodeServices.layer,
        ),
      ),
    );
  });
});
