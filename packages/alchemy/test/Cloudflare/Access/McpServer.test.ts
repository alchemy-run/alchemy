import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Deterministic identifiers — the server id is the API identity, so reruns
// converge on the same server instead of leaking. The cases run concurrently,
// so each MUST use a distinct server id.
const SERVER_ID = "alchemy-test-mcp-server";
const RECREATE_SERVER_ID = "alchemy-test-mcp-server-recreate";
const REPLACE_SERVER_ID = "alchemy-test-mcp-server-replace";
const REPLACE_SERVER_ID_V2 = "alchemy-test-mcp-replaced";
const SYNC_SERVER_ID = "alchemy-test-mcp-server-sync";
const PROBE_SERVER_ID = "alchemy-test-mcp-server-probe";

// Placeholder upstreams on the standing test zone. They are never contacted:
// every case that uses them opts out of the capability sync.
const HOSTNAME = "https://mcp.alchemy-test-2.us/mcp";
const HOSTNAME_V2 = "https://mcp-v2.alchemy-test-2.us/mcp";
// A real, public, unauthenticated MCP server for the capability-sync case.
const PUBLIC_HOSTNAME = "https://docs.mcp.cloudflare.com/mcp";

// Read a server out-of-band, mapping "gone" to undefined.
const getLiveServer = (accountId: string, id: string) =>
  zeroTrust
    .readAccessAiControlMcpServer({ accountId, id })
    .pipe(
      Effect.catchTag("McpServerNotFound", () => Effect.succeed(undefined)),
    );

// MCP servers are entitlement-gated (AI Controls beta). Either the account
// can list servers (entitled) or the call fails with the typed `Forbidden`.
const probeEntitlement = (accountId: string) =>
  zeroTrust.listAccessAiControlMcpServers({ accountId, perPage: 1 }).pipe(
    Effect.as(true),
    Effect.catchTag("Forbidden", () => Effect.succeed(false)),
  );

test.provider(
  "unentitled accounts surface the typed Forbidden error",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      if (yield* probeEntitlement(accountId)) {
        // Entitled account — the lifecycle cases cover the real behavior.
        yield* Effect.logInfo(
          "account is AI Controls-entitled; probe test is a no-op",
        );
        return;
      }

      // The typed tag — not UnknownCloudflareError, not a status check.
      const error = yield* zeroTrust
        .createAccessAiControlMcpServer({
          accountId,
          id: PROBE_SERVER_ID,
          authType: "unauthenticated",
          hostname: HOSTNAME,
          name: PROBE_SERVER_ID,
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:access", "live"] },
);

test.provider(
  "overlong server IDs surface the typed validation error and remain cleanable",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* stack.destroy();
      const error = yield* zeroTrust
        .readAccessAiControlMcpServer({
          accountId,
          id: "alchemy-test-mcp-server-id-is-too-long",
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("McpServerInvalidId");
      const deployError = yield* stack
        .deploy(
          Cloudflare.Access.McpServer("InvalidId", {
            serverId: "alchemy-test-mcp-server-id-is-too-long",
            hostname: HOSTNAME,
            authType: "unauthenticated",
            sync: false,
          }),
        )
        .pipe(Effect.flip);
      expect(deployError._tag).toEqual("McpServerInvalidId");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:access", "live"] },
);

test.provider(
  "create, update in place, and destroy an MCP server",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const server = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.McpServer("Upstream", {
            serverId: SERVER_ID,
            hostname: HOSTNAME,
            authType: "bearer",
            authCredentials: Redacted.make("alchemy-test-token-v1"),
            description: "alchemy mcp server v1",
            sync: false,
          });
        }),
      );

      expect(server.serverId).toEqual(SERVER_ID);
      expect(server.accountId).toEqual(accountId);
      expect(server.hostname).toEqual(HOSTNAME);
      expect(server.authType).toEqual("bearer");
      expect(server.name).toEqual(SERVER_ID);
      expect(server.description).toEqual("alchemy mcp server v1");
      expect(server.secureWebGateway).toEqual(false);
      expect(server.isSharedOauthCallbackEnabled).toEqual(false);
      expect(server.updatedTools).toEqual([]);
      expect(server.updatedPrompts).toEqual([]);

      const live = yield* getLiveServer(accountId, SERVER_ID);
      expect(live?.id).toEqual(SERVER_ID);
      expect(live?.hostname).toEqual(HOSTNAME);
      expect(live?.authType).toEqual("bearer");

      // Name, description, gateway, overrides, and a credential rotation
      // converge in place — same server id.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.McpServer("Upstream", {
            serverId: SERVER_ID,
            name: "Alchemy MCP Server",
            hostname: HOSTNAME,
            authType: "bearer",
            authCredentials: Redacted.make("alchemy-test-token-v2"),
            description: "alchemy mcp server v2",
            secureWebGateway: true,
            updatedTools: [
              { name: "search", enabled: false },
              { name: "fetch", alias: "get_page" },
            ],
            sync: false,
          });
        }),
      );
      expect(updated.serverId).toEqual(SERVER_ID);
      expect(updated.name).toEqual("Alchemy MCP Server");
      expect(updated.description).toEqual("alchemy mcp server v2");
      expect(updated.secureWebGateway).toEqual(true);
      expect(updated.updatedTools).toHaveLength(2);
      expect(
        updated.updatedTools.find((tool) => tool.name === "search")?.enabled,
      ).toEqual(false);
      expect(
        updated.updatedTools.find((tool) => tool.name === "fetch")?.alias,
      ).toEqual("get_page");

      const liveUpdated = yield* getLiveServer(accountId, SERVER_ID);
      expect(liveUpdated?.name).toEqual("Alchemy MCP Server");
      expect(liveUpdated?.secureWebGateway).toEqual(true);

      // No-op redeploy keeps the same server without drift.
      const noop = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.McpServer("Upstream", {
            serverId: SERVER_ID,
            name: "Alchemy MCP Server",
            hostname: HOSTNAME,
            authType: "bearer",
            authCredentials: Redacted.make("alchemy-test-token-v2"),
            description: "alchemy mcp server v2",
            secureWebGateway: true,
            updatedTools: [
              { name: "search", enabled: false },
              { name: "fetch", alias: "get_page" },
            ],
            sync: false,
          });
        }),
      );
      expect(noop.serverId).toEqual(SERVER_ID);

      yield* stack.destroy();

      const afterDestroy = yield* getLiveServer(accountId, SERVER_ID);
      expect(afterDestroy).toBeUndefined();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:access", "live"],
    timeout: 90_000,
  },
);

// `hostname` and `authType` are create-only on the API. Changing either must
// converge by recreating the server under the same id rather than failing.
test.provider(
  "changing the upstream hostname or auth type recreates the server under the same id",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.McpServer("Recreated", {
            serverId: RECREATE_SERVER_ID,
            hostname: HOSTNAME,
            authType: "unauthenticated",
            sync: false,
          });
        }),
      );
      expect(initial.serverId).toEqual(RECREATE_SERVER_ID);
      expect(initial.authType).toEqual("unauthenticated");

      const rehosted = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.McpServer("Recreated", {
            serverId: RECREATE_SERVER_ID,
            hostname: HOSTNAME_V2,
            authType: "unauthenticated",
            sync: false,
          });
        }),
      );
      expect(rehosted.serverId).toEqual(RECREATE_SERVER_ID);
      expect(rehosted.hostname).toEqual(HOSTNAME_V2);
      expect(rehosted.authType).toEqual("unauthenticated");

      const recreated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.McpServer("Recreated", {
            serverId: RECREATE_SERVER_ID,
            hostname: HOSTNAME_V2,
            authType: "bearer",
            authCredentials: Redacted.make("alchemy-test-token-recreate"),
            sync: false,
          });
        }),
      );
      expect(recreated.serverId).toEqual(RECREATE_SERVER_ID);
      expect(recreated.hostname).toEqual(HOSTNAME_V2);
      expect(recreated.authType).toEqual("bearer");

      const live = yield* getLiveServer(accountId, RECREATE_SERVER_ID);
      expect(live?.hostname).toEqual(HOSTNAME_V2);
      expect(live?.authType).toEqual("bearer");

      yield* stack.destroy();

      const afterDestroy = yield* getLiveServer(accountId, RECREATE_SERVER_ID);
      expect(afterDestroy).toBeUndefined();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:access", "live"],
    timeout: 90_000,
  },
);

// Canonical `list()` test (account collection): deploy a server, then resolve
// the provider via the typed helper and assert the deployed server appears in
// the exhaustively-paginated result.
test.provider(
  "generates a valid server ID and lists the deployed MCP server",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.McpServer(
            "ServerWithALongLogicalNameForGeneratedIdCoverage",
            {
              hostname: HOSTNAME,
              authType: "unauthenticated",
              sync: false,
            },
          );
        }),
      );
      expect(deployed.serverId.length).toBeLessThanOrEqual(32);

      const provider = yield* Provider.findProvider(
        Cloudflare.Access.McpServer,
      );
      const all = yield* provider.list();

      expect(all.some((s) => s.serverId === deployed.serverId)).toBe(true);

      yield* stack.destroy();

      const afterDestroy = yield* getLiveServer(accountId, deployed.serverId);
      expect(afterDestroy).toBeUndefined();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:access", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "changing the server ID replaces the server and removes the old ID",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* stack.destroy();

      const deploy = (serverId: string) =>
        stack.deploy(
          Cloudflare.Access.McpServer("Replaced", {
            serverId,
            hostname: HOSTNAME,
            authType: "unauthenticated",
            sync: false,
          }),
        );

      const initial = yield* deploy(REPLACE_SERVER_ID);
      expect(initial.serverId).toEqual(REPLACE_SERVER_ID);

      const replaced = yield* deploy(REPLACE_SERVER_ID_V2);
      expect(replaced.serverId).toEqual(REPLACE_SERVER_ID_V2);
      expect(
        yield* getLiveServer(accountId, REPLACE_SERVER_ID),
      ).toBeUndefined();
      expect(
        (yield* getLiveServer(accountId, REPLACE_SERVER_ID_V2))?.id,
      ).toEqual(REPLACE_SERVER_ID_V2);

      yield* stack.destroy();
      expect(
        yield* getLiveServer(accountId, REPLACE_SERVER_ID_V2),
      ).toBeUndefined();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:access", "live"],
    timeout: 90_000,
  },
);

// The default deploy runs a capability sync against the upstream. Against a
// real public server the discovered tools come back on the attributes.
test.provider(
  "sync discovers the capabilities of a public MCP server",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const server = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Access.McpServer("CloudflareDocs", {
            serverId: SYNC_SERVER_ID,
            hostname: PUBLIC_HOSTNAME,
            authType: "unauthenticated",
          });
        }),
      );

      expect(server.serverId).toEqual(SYNC_SERVER_ID);
      expect(server.status).toEqual("ready");
      expect(server.tools.length).toBeGreaterThan(0);

      yield* stack.destroy();

      const afterDestroy = yield* getLiveServer(accountId, SYNC_SERVER_ID);
      expect(afterDestroy).toBeUndefined();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:access", "live"],
    timeout: 120_000,
  },
);
