import { ApiToken, providers } from "@/Forgejo/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import {
  json,
  jsonList,
  mockForgejo,
  noContent,
  status,
} from "./support/mock.ts";

interface StoredToken {
  readonly id: number;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly sha1?: string;
  readonly token_last_eight: string;
  readonly created_at: string;
}

const tokens = new Map<number, StoredToken>();
let nextId = 1;

const server = mockForgejo((request) => {
  const match = request.path.match(
    /^\/admin\/users\/alice\/tokens(?:\/(\d+))?$/,
  );
  if (match === null) return status(404, "not found");

  if (request.method === "GET") {
    return jsonList(
      request,
      [...tokens.values()].map(
        ({ id, name, scopes, token_last_eight, created_at }) => ({
          id,
          name,
          scopes,
          token_last_eight,
          created_at,
        }),
      ),
    );
  }
  if (request.method === "POST") {
    const body = request.body as {
      name: string;
      scopes: readonly string[];
    };
    const id = nextId++;
    const sha1 = `generated-token-${id}`;
    const token = {
      id,
      name: body.name,
      scopes: body.scopes,
      sha1,
      token_last_eight: sha1.slice(-8),
      created_at: "2026-01-01T00:00:00Z",
    };
    tokens.set(id, token);
    return json(token, 201);
  }
  if (request.method === "DELETE") {
    const id = Number(match[1]);
    return tokens.delete(id) ? noContent() : status(404);
  }
  return status(405, "method not allowed");
});

const { test } = Test.make({
  providers: providers({
    baseUrl: "https://forge.example",
    token: "admin-token",
  }).pipe(Layer.provide(server.layer)),
});

test.provider(
  "creates, preserves, replaces, and deletes an API token",
  (stack) =>
    Effect.gen(function* () {
      tokens.clear();
      nextId = 1;

      const created = yield* stack.deploy(
        ApiToken("Automation", {
          username: "alice",
          name: "automation",
          scopes: ["read:repository"],
        }),
      );
      expect(created.tokenId).toBe(1);
      expect(Redacted.value(created.token)).toBe("generated-token-1");
      expect(tokens.size).toBe(1);

      const unchanged = yield* stack.deploy(
        ApiToken("Automation", {
          username: "alice",
          name: "automation",
          scopes: ["read:repository"],
        }),
      );
      expect(unchanged.tokenId).toBe(created.tokenId);
      expect(tokens.size).toBe(1);

      const replaced = yield* stack.deploy(
        ApiToken("Automation", {
          username: "alice",
          name: "automation",
          scopes: ["write:repository"],
        }),
      );
      expect(replaced.tokenId).toBe(2);
      expect(Redacted.value(replaced.token)).toBe("generated-token-2");
      expect(tokens.size).toBe(1);

      yield* stack.destroy();
      expect(tokens.size).toBe(0);
    }),
);

test.provider("refuses to mint a second token of the same name", (stack) =>
  Effect.gen(function* () {
    tokens.clear();
    nextId = 1;
    server.reset();
    // A create that succeeded against Forgejo but whose state write never
    // landed: the token is live, and its secret went out in the create
    // response that was lost. It cannot be read back and Forgejo will not
    // issue a second token under the name, so this must be reported rather
    // than retried into a duplicate-name rejection on every future deploy.
    tokens.set(7, {
      id: 7,
      name: "automation",
      scopes: ["read:repository"],
      token_last_eight: "existing",
      created_at: "2026-01-01T00:00:00Z",
    });
    nextId = 8;

    const result = yield* Effect.result(
      stack.deploy(
        ApiToken("Automation", {
          username: "alice",
          name: "automation",
          scopes: ["read:repository"],
        }),
      ),
    );

    expect(Result.isFailure(result)).toBe(true);
    expect(JSON.stringify(result)).toContain("UnrecoverableApiToken");
    // The live token is left exactly as found; nothing was created or revoked.
    expect(tokens.size).toBe(1);
    expect(server.count("POST", "/admin/users/alice/tokens")).toBe(0);
  }),
);
