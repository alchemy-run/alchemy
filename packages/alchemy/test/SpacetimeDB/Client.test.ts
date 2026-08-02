import {
  decodeTokenIdentity,
  makeClient,
  SpacetimeDBDecodeError,
  SpacetimeDBNotFound,
  SpacetimeDBPermissionDenied,
} from "@/SpacetimeDB/Client.ts";
import type { SpacetimeDBCredentialsService } from "@/SpacetimeDB/Credentials.ts";
import { describe, expect, it, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

const b64url = (value: string) =>
  Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

const makeJwt = (payload: Record<string, unknown>) =>
  `${b64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64url(JSON.stringify(payload))}.sig`;

describe("decodeTokenIdentity", () => {
  test("reads the sub claim", () => {
    const token = makeJwt({ sub: "c0ffee", iss: "localhost" });
    expect(Effect.runSync(decodeTokenIdentity(token))).toBe("c0ffee");
  });

  test("falls back to identity claim when sub is missing", () => {
    const token = makeJwt({ identity: "deadbeef" });
    expect(Effect.runSync(decodeTokenIdentity(token))).toBe("deadbeef");
  });

  test("fails when neither sub nor identity is present", () => {
    const token = makeJwt({ iss: "localhost" });
    const result = Effect.runSync(Effect.result(decodeTokenIdentity(token)));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(SpacetimeDBDecodeError);
    }
  });

  test("fails on malformed tokens", () => {
    const result = Effect.runSync(
      Effect.result(decodeTokenIdentity("not-a-jwt")),
    );
    expect(Result.isFailure(result)).toBe(true);
  });
});

const credentials: SpacetimeDBCredentialsService = {
  token: Redacted.make("test-token"),
  host: "https://maincloud.spacetimedb.com",
};

type MockHandler = (args: { method: string; url: string }) => {
  status: number;
  body: unknown;
};

const mockHttp = (handler: MockHandler): HttpClient.HttpClient =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      const result = handler({ method: request.method, url: request.url });
      const text =
        typeof result.body === "string"
          ? result.body
          : JSON.stringify(result.body);
      return HttpClientResponse.fromWeb(
        request,
        new Response(text, {
          status: result.status,
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  );

describe("makeClient", () => {
  it.effect(
    "getDatabase maps snake_case fields and 404 → SpacetimeDBNotFound",
    () =>
      Effect.gen(function* () {
        const client = makeClient(
          credentials,
          mockHttp(({ url }) => {
            if (url.endsWith("/missing")) {
              return { status: 404, body: "not found" };
            }
            return {
              status: 200,
              body: {
                database_identity: "db-id-1",
                owner_identity: "owner-1",
                host_type: "wasm",
                initial_program: "abc123",
              },
            };
          }),
        );

        const info = yield* client.getDatabase("my-game");
        expect(info).toEqual({
          databaseIdentity: "db-id-1",
          ownerIdentity: "owner-1",
          hostType: "wasm",
          initialProgram: "abc123",
        });

        const missing = yield* Effect.result(client.getDatabase("missing"));
        expect(Result.isFailure(missing)).toBe(true);
        if (Result.isFailure(missing)) {
          expect(missing.failure).toBeInstanceOf(SpacetimeDBNotFound);
        }
      }),
  );

  it.effect("publish parses Success and PermissionDenied envelopes", () =>
    Effect.gen(function* () {
      const client = makeClient(
        credentials,
        mockHttp(({ url }) => {
          if (url.includes("denied")) {
            return {
              status: 401,
              body: { PermissionDenied: { name: "denied" } },
            };
          }
          return {
            status: 200,
            body: {
              Success: {
                database_identity: "new-id",
                domain: "my-game",
                op: "created",
              },
            },
          };
        }),
      );

      const created = yield* client.publish(
        "my-game",
        new Uint8Array([0, 97, 115, 109]),
      );
      expect(created).toEqual({
        databaseIdentity: "new-id",
        domain: "my-game",
        op: "created",
      });

      const denied = yield* Effect.result(
        client.publish("denied", new Uint8Array([0, 97, 115, 109])),
      );
      expect(Result.isFailure(denied)).toBe(true);
      if (Result.isFailure(denied)) {
        expect(denied.failure).toBeInstanceOf(SpacetimeDBPermissionDenied);
      }
    }),
  );

  it.effect("publish appends clear=true when requested", () =>
    Effect.gen(function* () {
      let seenUrl = "";
      const client = makeClient(
        credentials,
        mockHttp(({ url }) => {
          seenUrl = url;
          return {
            status: 200,
            body: {
              Success: {
                database_identity: "id",
                domain: null,
                op: "updated",
              },
            },
          };
        }),
      );

      yield* client.publish("my-game", new Uint8Array([1]), { clear: true });
      expect(seenUrl).toContain("clear=true");
    }),
  );

  it.effect("deleteDatabase treats 404 as SpacetimeDBNotFound", () =>
    Effect.gen(function* () {
      const client = makeClient(
        credentials,
        mockHttp(() => ({ status: 404, body: "gone" })),
      );
      const result = yield* Effect.result(client.deleteDatabase("gone-db"));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(SpacetimeDBNotFound);
      }
    }),
  );

  it.effect("listDatabaseIdentities returns the identities array", () =>
    Effect.gen(function* () {
      const client = makeClient(
        credentials,
        mockHttp(() => ({
          status: 200,
          body: { identities: ["a", "b"] },
        })),
      );
      const ids = yield* client.listDatabaseIdentities("owner");
      expect(ids).toEqual(["a", "b"]);
    }),
  );

  it.effect("getDatabaseNames returns the names array", () =>
    Effect.gen(function* () {
      const client = makeClient(
        credentials,
        mockHttp(() => ({
          status: 200,
          body: { names: ["my-game", "my-game-alias"] },
        })),
      );
      const names = yield* client.getDatabaseNames("db-id");
      expect(names).toEqual(["my-game", "my-game-alias"]);
    }),
  );
});
