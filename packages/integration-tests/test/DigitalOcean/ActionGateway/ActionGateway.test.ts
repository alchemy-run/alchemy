import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { getMcpServer, getToolbelt } from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import { isGone, logLevel } from "../support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:action-gateway", "live"];

const resources = (tools: string[]) =>
  Effect.gen(function* () {
    const belt = yield* DigitalOcean.ActionGateway.Toolbelt("Belt", {
      description: "alchemy test toolbelt",
      tools,
    });
    // A public MCP server that needs no credentials.
    const server = yield* DigitalOcean.ActionGateway.McpServer("Wiki", {
      endpoint: "https://mcp.deepwiki.com/mcp",
      description: "DeepWiki",
    });
    return {
      name: belt.name,
      version: belt.version,
      reference: belt.reference,
      serverRef: server.serverRef,
    };
  });

test.provider(
  "toolbelt and MCP server: create, add a tool as a new version, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(resources(["slack_add_bookmark"]));
      expect(created.reference).toEqual(`${created.name}@1`);
      const server = yield* getMcpServer({ server_ref: created.serverRef });
      expect(server.mcpServer.endpoint).toEqual("https://mcp.deepwiki.com/mcp");

      const updated = yield* stack.deploy(resources(["slack_add_bookmark", "slack_add_reaction"]));
      expect(updated.name).toEqual(created.name);
      expect(updated.version).not.toEqual(created.version);
      const belt = yield* getToolbelt({ name: created.name });
      expect([...(belt.toolbelt.tools ?? [])].map((t) => t.replace(/@.*$/, "")).sort()).toEqual([
        "slack_add_bookmark",
        "slack_add_reaction",
      ]);

      yield* stack.destroy();
      expect(yield* isGone(getToolbelt({ name: created.name }))).toBe(true);
      expect(yield* isGone(getMcpServer({ server_ref: created.serverRef }))).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS },
);
