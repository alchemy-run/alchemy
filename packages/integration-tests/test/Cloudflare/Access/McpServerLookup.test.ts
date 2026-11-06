import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { testName } from "../../names.ts";
import { expectUrlContains } from "../Utils/Http.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const tags = ["provider:cloudflare", "provider:cloudflare:access", "live"];

// A placeholder upstream on the standing test zone; the server never syncs.
const HOSTNAME = "https://mcp-lookup.alchemy-test-2.us/mcp";

const callerScript = `export default {
  async fetch(request, env) {
    return new Response("server:" + env.SERVER);
  },
};`;

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "AccessMcpServerLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const server = yield* Cloudflare.Access.McpServer("lookup-target", {
      serverId: testName("alc-mcp-lookup"),
      hostname: HOSTNAME,
      authType: "unauthenticated",
      sync: false,
    });
    return { serverId: server.serverId.as<string>(), name: server.name.as<string>() };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up MCP server resolves by id and by name, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { serverId, name } = yield* target;

      const program = Effect.gen(function* () {
        const byName = Cloudflare.Access.McpServer.lookup({ name });
        const byId = Cloudflare.Access.McpServer.lookup({ serverId });
        const caller = yield* Cloudflare.Worker("mcp-lookup-caller", {
          script: callerScript,
          workersDev: true,
          env: { SERVER: byName.serverId },
        });
        return { url: caller.url.as<string>(), hostname: byId.hostname };
      });
      const out = yield* stack.deploy(program);
      expect(out.hostname).toBe(HOSTNAME);

      yield* expectUrlContains(out.url, `server:${serverId}`, { label: "mcp lookup caller" });

      // A lookup re-resolves to the same server, so nothing changes.
      const plan = yield* stack.plan(program);
      expect(plan.resources["mcp-lookup-caller"].action).toBe("noop");

      // Destroying the stack that looked it up leaves the server alone.
      yield* stack.destroy();
      const server = yield* zeroTrust.readAccessAiControlMcpServer({ accountId, id: serverId });
      expect(server.id).toBe(serverId);
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "a lookup of a missing MCP server fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const lookups = {
        "missing-server-by-id": Cloudflare.Access.McpServer.lookup({ serverId: name }).serverId,
        "missing-server-by-name": Cloudflare.Access.McpServer.lookup({ name }).serverId,
      };
      for (const [id, value] of Object.entries(lookups)) {
        yield* expectDeployFails(
          stack.deploy(Cloudflare.Worker(id, { script: callerScript, env: { SERVER: value } })),
          ["LookupNotFoundError", name],
        );
      }
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of an MCP server this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () =>
        Cloudflare.Access.McpServer("lookup-managed", {
          serverId: testName("alc-mcp-lookup-managed"),
          hostname: HOSTNAME,
          authType: "unauthenticated",
          sync: false,
        });
      const { serverId } = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* Cloudflare.Worker("mcp-lookup-managed-caller", {
              script: callerScript,
              env: { SERVER: Cloudflare.Access.McpServer.lookup({ serverId }).serverId },
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
