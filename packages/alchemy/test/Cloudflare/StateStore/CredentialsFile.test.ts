import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { CredentialsStoreService } from "@/Auth/Credentials.ts";
import {
  CREDENTIALS_FILE,
  deleteStoreCredentials,
  isStateStoreCredentialsStale,
  readStoreCredentials,
  writeStoreCredentials,
} from "@/Cloudflare/StateStore/CredentialsFile.ts";

const ACCOUNT_A = "c8eeff0e4f5ebeeedc8d9af2013d7997";
const ACCOUNT_B = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

/**
 * The cached Cloudflare state-store credentials encode an account (the `url`
 * is a `*.workers.dev` subdomain). {@link isStateStoreCredentialsStale} guards
 * against trusting a cache minted for a different account than the one now in
 * use — the bug where deploys silently read/write state in a previously
 * logged-in account.
 */
describe(
  "isStateStoreCredentialsStale",
  { tags: ["unit", "provider:cloudflare", "provider:cloudflare:statestore", "local"] },
  () => {
    it("is fresh when the cached account matches the current account", () => {
      expect(
        isStateStoreCredentialsStale(
          { url: "https://s.workers.dev", authToken: "t", accountId: ACCOUNT_A },
          ACCOUNT_A,
        ),
      ).toBe(false);
    });

    it("is stale when the cached account differs from the current account", () => {
      expect(
        isStateStoreCredentialsStale(
          { url: "https://s.workers.dev", authToken: "t", accountId: ACCOUNT_A },
          ACCOUNT_B,
        ),
      ).toBe(true);
    });

    it("is stale for a legacy cache with no accountId", () => {
      expect(
        isStateStoreCredentialsStale({ url: "https://s.workers.dev", authToken: "t" }, ACCOUNT_A),
      ).toBe(true);
    });
  },
);

/** A credentials store in memory, encoding through each schema like the disk store. */
const memoryStore = () => {
  const files = new Map<string, unknown>();
  const key = (profile: string, provider: string) => `${profile}/${provider}`;
  const store: CredentialsStoreService = {
    // Yields after reading, so concurrent read-modify-writes interleave as
    // they can on disk.
    read: (profile, provider, schema) =>
      Effect.suspend(() => {
        const encoded = files.get(key(profile, provider));
        return encoded === undefined
          ? Effect.succeed(undefined)
          : Schema.decodeUnknownEffect(schema)(encoded).pipe(Effect.orDie);
      }).pipe(Effect.tap(() => Effect.yieldNow)),
    write: (profile, provider, schema, credentials) =>
      Schema.encodeEffect(schema)(credentials).pipe(
        Effect.orDie,
        Effect.map((encoded) => void files.set(key(profile, provider), encoded)),
      ),
    delete: (profile, provider) => Effect.sync(() => void files.delete(key(profile, provider))),
    deleteProfile: () => Effect.void,
  };
  return { store, files };
};

const credentials = (url: string) => ({ url, authToken: "t", accountId: ACCOUNT_A });

describe(
  "state-store credentials by store name",
  { tags: ["unit", "provider:cloudflare", "provider:cloudflare:statestore", "local"] },
  () => {
    it.effect("reads a legacy single-store file as the default store", () =>
      Effect.gen(function* () {
        const { store, files } = memoryStore();
        files.set(`default/${CREDENTIALS_FILE}`, credentials("https://a.workers.dev"));
        expect(yield* readStoreCredentials(store, "default", "alchemy-state-store")).toEqual(
          credentials("https://a.workers.dev"),
        );
        expect(yield* readStoreCredentials(store, "default", "team-a")).toBeUndefined();
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("keeps every store beside the others in one file", () =>
      Effect.gen(function* () {
        const { store, files } = memoryStore();
        files.set(`default/${CREDENTIALS_FILE}`, credentials("https://a.workers.dev"));
        yield* writeStoreCredentials(
          store,
          "default",
          "team-a",
          credentials("https://b.workers.dev"),
        );
        expect(yield* readStoreCredentials(store, "default", "alchemy-state-store")).toEqual(
          credentials("https://a.workers.dev"),
        );
        expect(yield* readStoreCredentials(store, "default", "team-a")).toEqual(
          credentials("https://b.workers.dev"),
        );
        expect([...files.keys()]).toEqual([`default/${CREDENTIALS_FILE}`]);
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("deleting one store keeps the others; the file goes with the last", () =>
      Effect.gen(function* () {
        const { store, files } = memoryStore();
        yield* writeStoreCredentials(
          store,
          "default",
          "team-a",
          credentials("https://a.workers.dev"),
        );
        yield* writeStoreCredentials(
          store,
          "default",
          "team-b",
          credentials("https://b.workers.dev"),
        );
        yield* deleteStoreCredentials(store, "default", "team-a");
        expect(yield* readStoreCredentials(store, "default", "team-a")).toBeUndefined();
        expect(yield* readStoreCredentials(store, "default", "team-b")).toEqual(
          credentials("https://b.workers.dev"),
        );
        yield* deleteStoreCredentials(store, "default", "team-b");
        expect(files.size).toBe(0);
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("deleting the file, as profile edit and logout do, clears every store", () =>
      Effect.gen(function* () {
        const { store } = memoryStore();
        yield* writeStoreCredentials(
          store,
          "default",
          "alchemy-state-store",
          credentials("https://a.workers.dev"),
        );
        yield* writeStoreCredentials(
          store,
          "default",
          "team-a",
          credentials("https://b.workers.dev"),
        );
        yield* store.delete("default", CREDENTIALS_FILE);
        expect(
          yield* readStoreCredentials(store, "default", "alchemy-state-store"),
        ).toBeUndefined();
        expect(yield* readStoreCredentials(store, "default", "team-a")).toBeUndefined();
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("concurrent writes for different stores keep both", () =>
      Effect.gen(function* () {
        const { store } = memoryStore();
        yield* Effect.all(
          ["team-a", "team-b", "team-c"].map((name) =>
            writeStoreCredentials(
              store,
              "default",
              name,
              credentials(`https://${name}.workers.dev`),
            ),
          ),
          { concurrency: "unbounded" },
        );
        for (const name of ["team-a", "team-b", "team-c"]) {
          expect(yield* readStoreCredentials(store, "default", name)).toEqual(
            credentials(`https://${name}.workers.dev`),
          );
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  },
);
