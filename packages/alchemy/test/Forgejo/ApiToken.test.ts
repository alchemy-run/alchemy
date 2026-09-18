import { ApiToken } from "@/Forgejo/index.ts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import {
  json,
  jsonList,
  mockForgejo,
  noContent,
  status,
} from "./support/mock.ts";
import { forgejoTest } from "./support/stack.ts";

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

const reset = () => {
  tokens.clear();
  nextId = 1;
  server.reset();
};

const { test } = forgejoTest(server);

import { Repository } from "@/Forgejo/index.ts";
import { destroy } from "@/RemovalPolicy";
import { Services } from "@distilled.cloud/forgejo";
import { fixture, liveTest } from "./support/live.ts";
import * as Provider from "@/Provider.ts";
import * as HttpClient from "effect/unstable/http/HttpClient";
const traffic: string[] = [];
const live = liveTest((client) =>
  HttpClient.make((request) =>
    Effect.gen(function* () {
      yield* Effect.sync(() =>
        traffic.push(`${request.method} ${new URL(request.url).pathname}`),
      );
      return yield* client.execute(request);
    }),
  ),
);

for (const invalid of [
  "empty repositories",
  "empty scopes",
  "restricted organization scope",
] as const) {
  live.test.provider.skipIf(process.env.FORGEJO_TEST !== "1")(
    `live: rejects ${invalid} before revoking token`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const { username } = yield* fixture;
        const name = `alchemy-1425-${invalid.replaceAll(" ", "-")}`;
        const valid = { username, name, scopes: ["read:repository"] };
        const props =
          invalid === "empty scopes"
            ? { ...valid, scopes: [] }
            : invalid === "empty repositories"
              ? { ...valid, repositories: [] }
              : {
                  ...valid,
                  scopes: ["read:organization"],
                  repositories: [{ owner: username, name: "nonexistent" }],
                };
        const invalidCreate = yield* stack
          .deploy(ApiToken("Invalid", props))
          .pipe(Effect.result);
        yield* stack.destroy();
        const first = yield* stack.deploy(ApiToken("Token", valid));
        const result = yield* stack
          .deploy(ApiToken("Token", props))
          .pipe(Effect.result);
        const tokens = yield* Services.admin.adminListUserAccessTokens({
          username,
        });
        yield* stack.destroy();
        expect(Result.isFailure(result)).toBe(true);
        expect(tokens.some((t) => t.id === first.tokenId)).toBe(true);
        expect(JSON.stringify(result)).toContain("InvalidApiToken");
        expect(JSON.stringify(invalidCreate)).toContain("InvalidApiToken");
      }),
    { timeout: 90_000 },
  );
}

live.test.provider.skipIf(process.env.FORGEJO_TEST !== "1")(
  "live: generated token names rotate create-first and preserve no-op identity",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { username } = yield* fixture;
      const deploy = (scopes: string[], name = "alchemy-1425-token-repo") =>
        Effect.gen(function* () {
          const repo = yield* Repository("Repo", {
            owner: username,
            name,
          }).pipe(destroy());
          return yield* ApiToken("Token", {
            username,
            scopes,
            repositories: [{ owner: username, name: repo.name }],
          });
        });
      const first = yield* stack.deploy(deploy(["read:repository"]));
      const same = yield* stack.deploy(deploy(["read:repository"]));
      yield* Effect.sync(() => {
        traffic.length = 0;
      });
      const second = yield* stack.deploy(deploy(["write:repository"]));
      const order = yield* Effect.sync(() => [...traffic]);
      expect(
        order.indexOf(`POST /api/v1/admin/users/${username}/tokens`),
      ).toBeLessThan(
        order.indexOf(
          `DELETE /api/v1/admin/users/${username}/tokens/${first.tokenId}`,
        ),
      );
      const tokens = yield* Services.admin.adminListUserAccessTokens({
        username,
      });
      const third = yield* stack.deploy(
        deploy(["read:repository"], "alchemy-1425-token-renamed"),
      );
      expect(third.tokenId).not.toBe(second.tokenId);
      expect(
        (yield* Services.admin.adminListUserAccessTokens({ username })).find(
          (t) => t.id === third.tokenId,
        )?.scopes,
      ).toEqual(["read:repository"]);
      yield* stack.destroy();
      expect(same.tokenId).toBe(first.tokenId);
      expect(second.tokenId).not.toBe(first.tokenId);
      expect(tokens.some((t) => t.id === first.tokenId)).toBe(false);
      expect(tokens.some((t) => t.id === second.tokenId)).toBe(true);
    }),
  { timeout: 90_000 },
);

live.test.provider.skipIf(process.env.FORGEJO_TEST !== "1")(
  "live: explicit token restriction transitions replace safely",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { username } = yield* fixture;
      const program = (restricted: boolean) =>
        Effect.gen(function* () {
          const repo = yield* Repository("Repo", {
            owner: username,
            name: "alchemy-1425-restrictions",
          }).pipe(destroy());
          return yield* ApiToken("Token", {
            username,
            name: "alchemy-1425-restrictions",
            scopes: ["read:repository"],
            repositories: restricted
              ? [{ owner: repo.owner, name: repo.name }]
              : undefined,
          });
        });
      const first = yield* stack.deploy(program(false));
      const restricted = yield* stack.deploy(program(true));
      const restrictedState = (yield* Services.admin.adminListUserAccessTokens({
        username,
      })).find((t) => t.id === restricted.tokenId);
      const unrestricted = yield* stack.deploy(program(false));
      const unrestrictedState =
        (yield* Services.admin.adminListUserAccessTokens({ username })).find(
          (t) => t.id === unrestricted.tokenId,
        );
      yield* stack.destroy();
      expect(restricted.tokenId).not.toBe(first.tokenId);
      expect(unrestricted.tokenId).not.toBe(restricted.tokenId);
      expect(restrictedState?.repositories?.length).toBe(1);
      expect(unrestrictedState?.repositories?.length ?? 0).toBe(0);
    }),
  { timeout: 90_000 },
);

live.test.provider.skipIf(process.env.FORGEJO_TEST !== "1")(
  "live: explicit token scope order and unrecoverable plaintext are safe",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { username } = yield* fixture;
      const props = {
        username,
        name: "alchemy-1425-token-recovery",
        scopes: ["read:repository", "read:issue"],
      };
      const first = yield* stack.deploy(ApiToken("Token", props));
      const reordered = yield* stack.deploy(
        ApiToken("Token", { ...props, scopes: [...props.scopes].reverse() }),
      );
      const provider = yield* Provider.findProvider(ApiToken);
      const lost = yield* provider
        .reconcile({
          id: "Token",
          fqn: "Token",
          instanceId: "",
          olds: undefined,
          output: undefined,
          news: props,
          bindings: [],
          session: {
            emit: () => Effect.void,
            done: () => Effect.void,
            note: () => Effect.void,
          },
        })
        .pipe(Effect.result);
      const tokens = yield* Services.admin.adminListUserAccessTokens({
        username,
      });
      yield* stack.destroy();
      expect(reordered.tokenId).toBe(first.tokenId);
      expect(JSON.stringify(lost)).toContain("UnrecoverableApiToken");
      expect(tokens.some((t) => t.id === first.tokenId)).toBe(true);
      expect(
        (yield* Services.admin.adminListUserAccessTokens({ username })).some(
          (t) => t.id === first.tokenId,
        ),
      ).toBe(false);
    }),
  { timeout: 90_000 },
);

test.provider(
  "creates, preserves, replaces, and deletes an API token",
  (stack) =>
    Effect.gen(function* () {
      reset();

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
    reset();
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
