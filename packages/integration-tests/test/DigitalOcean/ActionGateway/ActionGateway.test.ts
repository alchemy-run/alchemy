import * as DigitalOcean from "@alchemy.run/digitalocean";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import {
  getActorLimit,
  getEndpoint,
  getMcpServer,
  getOutputView,
  getProviderCredentials,
  getToolbelt,
} from "@distilled.cloud/digitalocean";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
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

const endpointResources = (instructions: string, searchLimit: number) =>
  Effect.gen(function* () {
    const view = yield* DigitalOcean.ActionGateway.OutputView("Titles", {
      tool: "exa_web_search",
      fields: ["results"],
    });
    const endpoint = yield* DigitalOcean.ActionGateway.Endpoint("Research", {
      tools: ["exa_web_search", "exa_web_fetch"],
      policy: { default: "allow", rules: [{ tool: "exa_web_fetch", action: "ask" }] },
      instructions,
      outputViews: { exa_web_search: view.name },
      actorId: "alchemy-test-actor",
    });
    // AbuseIPDB doesn't check a key until a tool uses it.
    const credential = yield* DigitalOcean.ActionGateway.ProviderCredential("AbuseIpDb", {
      provider: "abuseipdb",
      apiKey: Redacted.make("not-a-real-key"),
    });
    // An actor exists once an endpoint or session is bound to it.
    const limit = yield* DigitalOcean.ActionGateway.ActorLimit("Probe", {
      actorId: endpoint.actorId,
      limits: { webSearch: searchLimit },
    });
    return {
      viewId: view.viewId,
      endpointId: endpoint.endpointId,
      mcpUrl: endpoint.mcpUrl,
      version: endpoint.version,
      credentialId: credential.credentialId,
      actorId: limit.actorId,
    };
  });

test.provider(
  "endpoint, output view, provider credential and actor limit: create, publish a version, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(endpointResources("Cite sources.", 10));
      expect(created.version).toEqual(1);
      expect(created.mcpUrl).toMatch(/^https:\/\//);
      const view = yield* getOutputView({ view_id: created.viewId });
      expect(view.view?.fields).toEqual(["results"]);
      const credential = yield* getProviderCredentials({ id: created.credentialId });
      expect(credential.credential?.provider).toEqual("abuseipdb");
      const limits = yield* getActorLimit({ actor_id: created.actorId });
      expect(limits.configured_limits).toEqual([
        { category: "LIMIT_CATEGORY_WEB_SEARCH_REQUESTS_PER_MINUTE", requests_per_minute: "10" },
      ]);

      // New instructions publish version 2 on the same endpoint.
      const updated = yield* stack.deploy(endpointResources("Cite every source.", 5));
      expect(updated.endpointId).toEqual(created.endpointId);
      expect(updated.version).toEqual(2);
      const endpoint = yield* getEndpoint({ endpoint_id: created.endpointId });
      expect(endpoint.endpoint.head_version?.config?.customInstructions).toEqual(
        "Cite every source.",
      );
      const relimited = yield* getActorLimit({ actor_id: created.actorId });
      expect(relimited.configured_limits?.[0]?.requests_per_minute).toEqual("5");

      yield* stack.destroy();
      expect(yield* isGone(getEndpoint({ endpoint_id: created.endpointId }))).toBe(true);
      expect(yield* isGone(getOutputView({ view_id: created.viewId }))).toBe(true);
      const cleared = yield* getActorLimit({ actor_id: created.actorId }).pipe(
        Effect.map((r) => r.configured_limits ?? []),
        Effect.catchTag("NotFound", () => Effect.succeed([])),
      );
      expect(cleared).toEqual([]);
      const credentialStatus = yield* getProviderCredentials({ id: created.credentialId }).pipe(
        Effect.map((r) => r.credential?.status ?? "gone"),
        Effect.catchTag("NotFound", () => Effect.succeed("gone")),
      );
      expect(["gone", "PROVIDER_CREDENTIAL_STATUS_DELETED"]).toContain(credentialStatus);
    }).pipe(logLevel),
  // A new actor's limits can take a minute to accept under load.
  { tags: LIVE_TAGS, timeout: 300_000 },
);
