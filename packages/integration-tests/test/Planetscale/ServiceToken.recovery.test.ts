import * as Planetscale from "@alchemy.run/planetscale";
import { assert, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { State } from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

interface Access {
  access: string;
  resource: { name: string; type: string };
}

interface RemoteToken {
  id: string;
  name: string;
  secret: string;
  accesses: Access[];
}

const Body = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  database: Schema.optionalKey(Schema.String),
  access: Schema.optionalKey(Schema.Array(Schema.String)),
});

const tokenJson = (token: RemoteToken) => ({
  id: token.id,
  name: token.name,
  display_name: token.name,
  avatar_url: "",
  created_at: "2026-10-29T00:00:00Z",
  updated_at: "2026-10-29T00:00:00Z",
  actor_id: null,
  actor_display_name: null,
  actor_type: null,
});

const harness = () => {
  const world = {
    tokens: new Map<string, RemoteToken>(),
    nextId: 0,
    loseCreateResponse: false,
  };
  const client = HttpClient.make(
    Effect.fnUntraced(function* (request) {
      const url = Option.getOrThrow(HttpClientRequest.toUrl(request));
      const base = "/v1/organizations/example/service-tokens";
      const answer = (body: unknown, status = 200) =>
        HttpClientResponse.fromWeb(request, Response.json(body, { status }));
      const body = yield* Schema.decodeEffect(Schema.fromJsonString(Body))(
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}",
      ).pipe(Effect.orDie);

      if (url.pathname === base) {
        if (request.method === "GET") {
          return answer({
            type: "list",
            current_page: 1,
            per_page: 100,
            next_page: null,
            next_page_url: null,
            prev_page: null,
            prev_page_url: null,
            total_count: world.tokens.size,
            total_pages: 1,
            data: [...world.tokens.values()].map(tokenJson),
          });
        }
        if (request.method === "POST" && body.name) {
          const id = `token-${++world.nextId}`;
          const token: RemoteToken = {
            id,
            name: body.name,
            secret: `creation-only-${id}`,
            accesses: [],
          };
          world.tokens.set(id, token);
          if (world.loseCreateResponse) {
            world.loseCreateResponse = false;
            return answer({ code: "internal_server_error", message: "Response lost" }, 500);
          }
          return answer({ ...tokenJson(token), token: token.secret });
        }
      }

      if (url.pathname.startsWith(`${base}/`)) {
        const [id, subresource] = url.pathname.slice(base.length + 1).split("/");
        const token = id ? world.tokens.get(id) : undefined;
        if (!token) return answer({ code: "not_found", message: "Not found" }, 404);
        if (subresource === "access") {
          if (request.method === "GET") return answer({ data: token.accesses });
          if (request.method === "POST" && body.database && body.access) {
            for (const access of body.access) {
              token.accesses.push({
                access,
                resource: { type: "Database", name: body.database },
              });
            }
            return answer({ data: token.accesses });
          }
        } else if (!subresource) {
          if (request.method === "GET") return answer(tokenJson(token));
          if (request.method === "DELETE") {
            world.tokens.delete(token.id);
            return answer({});
          }
        }
      }
      return yield* Effect.die(`Unexpected ${request.method} ${url.href}`);
    }),
  );
  const { test } = Test.make({
    providers: Planetscale.ServiceTokenProvider().pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Planetscale.fromToken({
            organization: "example",
            tokenId: "bootstrap-id",
            token: "bootstrap-secret",
            apiBaseUrl: "https://planetscale.test/v1",
          }),
          Layer.succeed(HttpClient.HttpClient, client),
        ),
      ),
    ),
  });
  return { world, test };
};

const resources = Planetscale.ServiceToken("Token", {
  database: "main",
  accesses: ["read_database", "write_database"],
});

const interruptCreate = Effect.fnUntraced(function* (
  stack: Test.ScratchStack,
  world: ReturnType<typeof harness>["world"],
) {
  world.loseCreateResponse = true;
  const failed = yield* Effect.exit(stack.deploy(resources));
  expect(Exit.isFailure(failed)).toBe(true);
  expect(world.tokens.size).toBe(1);
  const state = yield* yield* State;
  const row = yield* state.get({ stack: stack.name, stage: stack.stage, fqn: "Token" });
  assert(row?.status === "creating");
  expect(row.attr).toBeUndefined();
});

const options = {
  retry: 0,
  tags: ["unit", "provider:planetscale", "provider:planetscale:servicetoken", "local"],
};

const destroyCase = harness();
destroyCase.test.provider(
  "destroys a token whose creation response was lost",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* interruptCreate(stack, destroyCase.world);
      yield* stack.destroy();
      expect(destroyCase.world.tokens.size).toBe(0);
    }),
  options,
);

const redeployCase = harness();
redeployCase.test.provider(
  "recreates a token whose creation response was lost",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* interruptCreate(stack, redeployCase.world);
      const stranded = [...redeployCase.world.tokens.keys()][0];
      const recovered = yield* stack.deploy(resources);
      expect(redeployCase.world.tokens.size).toBe(1);
      expect(redeployCase.world.tokens.has(stranded!)).toBe(false);
      const token = redeployCase.world.tokens.get(recovered.id);
      assert(token);
      expect(token.accesses).toEqual([
        { access: "read_database", resource: { name: "main", type: "Database" } },
        { access: "write_database", resource: { name: "main", type: "Database" } },
      ]);
      expect(Redacted.value(recovered.token)).toBe(token.secret);
      yield* stack.destroy();
      expect(redeployCase.world.tokens.size).toBe(0);
    }),
  options,
);

const named = (name: string) =>
  Planetscale.ServiceToken("Token", {
    name,
    database: "main",
    accesses: ["read_database", "write_database"],
  });

const renamedCase = harness();
renamedCase.test.provider(
  "revokes a replacement whose creation response was lost, after another rename",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { world } = renamedCase;
      const first = yield* stack.deploy(named("first"));
      world.loseCreateResponse = true;
      const failed = yield* Effect.exit(stack.deploy(named("second")));
      expect(Exit.isFailure(failed)).toBe(true);
      expect(world.tokens.size).toBe(2);
      const stranded = [...world.tokens.keys()].find((id) => id !== first.id);
      const third = yield* stack.deploy(named("third"));
      expect([...world.tokens.keys()]).toEqual([third.id]);
      expect(world.tokens.has(stranded!)).toBe(false);
      expect(Redacted.value(third.token)).toBe(world.tokens.get(third.id)?.secret);
      yield* stack.destroy();
      expect(world.tokens.size).toBe(0);
    }),
  options,
);
