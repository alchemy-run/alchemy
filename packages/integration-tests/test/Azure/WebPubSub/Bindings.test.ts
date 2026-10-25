import * as Azure from "@alchemy.run/azure";
import { Credentials } from "@distilled.cloud/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as webpubsub from "@distilled.cloud/azure/webpubsub";
import * as data from "@distilled.cloud/azure/webpubsub-data";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import WebPubSubBindingsFunction, { Chat, PubSub } from "./fixtures/function.ts";
import { tags, waitGone } from "./util.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

/** Built-in **Web PubSub Service Owner**: the deployer seeds and observes hub state. */
const WEB_PUBSUB_SERVICE_OWNER = "12cf5a90-567b-43ae-8102-96cf46c7d9b4";

/** Object ID (`oid` claim) of the identity running the tests. */
const deployerObjectId = Effect.gen(function* () {
  const config = yield* yield* Credentials;
  const token = Redacted.value(config.bearerToken);
  return yield* Effect.sync(
    () =>
      JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"))
        .oid as string,
  );
});

const Stack = Alchemy.Stack(
  "AzureWebPubSubBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* WebPubSubBindingsFunction;
    const service = yield* PubSub;
    const chat = yield* Chat;
    const deployer = yield* deployerObjectId.pipe(Effect.orDie);
    yield* Azure.Authorization.RoleAssignment("WpsBindingsDeployer", {
      scope: service.webPubSubId,
      roleDefinitionId: WEB_PUBSUB_SERVICE_OWNER,
      principalId: deployer,
      principalType: "ServicePrincipal",
    });
    return {
      url: fn.url,
      principalId: fn.principalId,
      serviceId: service.webPubSubId,
      serviceName: service.webPubSubName,
      resourceGroup: service.resourceGroup,
      hub: chat.hubName,
    };
  }),
);

// Web PubSub Standard_S1 (~$0.07/h) + a Flex Consumption app; ~5 min deploy.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

/** Azure credentials and environment for out-of-band calls. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

type Body = { ok: boolean; result?: any; error?: string };

/**
 * Call a binding route until it answers `ok`, through the Flex Consumption
 * cold start and data-role propagation, then return the last answer so a
 * real failure shows its Web PubSub error.
 */
const call = (route: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    return yield* HttpClient.get(`${url}${route}`).pipe(
      Effect.timeout("60 seconds"),
      Effect.flatMap((response) => response.json),
      Effect.map((body) => body as Body),
      Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 60 }),
      Effect.catch((body) => Effect.succeed(body as Body)),
    );
  });

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

/** The deployer's data role can trail the deploy by a few minutes. */
const whileDenied = {
  while: (e: { readonly _tag: string }) => e._tag === "WebPubSubAccessDenied",
  schedule: Schedule.spaced("10 seconds"),
  times: 30,
} as const;

/** The bound hub's data-plane address. */
const hub = Effect.map(stack, ({ serviceName, hub }) => ({
  endpoint: `https://${serviceName}.webpubsub.azure.com`,
  hub,
}));

// --- out-of-band reads and writes (deployer credentials) ---

const connectionExists = (connectionId: string) =>
  Effect.gen(function* () {
    const where = yield* hub;
    return yield* data.ConnectionExists({ ...where, connectionId }).pipe(
      Effect.as(true),
      Effect.catchTag("WebPubSubConnectionNotFound", () => Effect.succeed(false)),
      Effect.retry(whileDenied),
    );
  });

const userExists = (userId: string) =>
  Effect.gen(function* () {
    const where = yield* hub;
    return yield* data.UserExists({ ...where, userId }).pipe(
      Effect.as(true),
      Effect.catchTag("WebPubSubUserNotFound", () => Effect.succeed(false)),
      Effect.retry(whileDenied),
    );
  });

const groupExists = (group: string) =>
  Effect.gen(function* () {
    const where = yield* hub;
    return yield* data.GroupExists({ ...where, group }).pipe(
      Effect.as(true),
      Effect.catchTag("WebPubSubGroupNotFound", () => Effect.succeed(false)),
      Effect.retry(whileDenied),
    );
  });

const hasPermission = (connectionId: string, group: string) =>
  Effect.gen(function* () {
    const where = yield* hub;
    return yield* data
      .CheckPermission({ ...where, permission: "sendToGroup", connectionId, targetName: group })
      .pipe(
        Effect.as(true),
        Effect.catchTag("WebPubSubPermissionNotGranted", () => Effect.succeed(false)),
        Effect.retry(whileDenied),
      );
  });

/** Connection IDs in `group`, sorted (every page). */
const members = (group: string) =>
  Effect.gen(function* () {
    const where = yield* hub;
    const found = yield* Stream.runCollect(
      data.ListConnectionsInGroup.items({ ...where, group }),
    ).pipe(Effect.retry(whileDenied));
    return Array.from(found, (m) => m.connectionId).sort();
  });

/**
 * Connection IDs in `group` once they equal `expected` (group writes apply
 * within seconds), else the last answer.
 */
const membersOf = (group: string, expected: readonly string[]) => {
  const want = JSON.stringify([...expected].sort());
  return members(group).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (ids) => JSON.stringify(ids) === want,
      times: 15,
    }),
  );
};

const joinGroup = (connectionId: string, group: string) =>
  Effect.gen(function* () {
    const where = yield* hub;
    yield* data
      .AddConnectionToGroup({ ...where, group, connectionId })
      .pipe(Effect.retry(whileDenied));
  });

const addUser = (userId: string, group: string) =>
  Effect.gen(function* () {
    const where = yield* hub;
    yield* data.AddUserToGroup({ ...where, userId, group }).pipe(Effect.retry(whileDenied));
  });

const grant = (connectionId: string, group: string) =>
  Effect.gen(function* () {
    const where = yield* hub;
    yield* data
      .GrantPermission({ ...where, permission: "sendToGroup", connectionId, targetName: group })
      .pipe(Effect.retry(whileDenied));
  });

/** Poll an out-of-band check until it reports `expected` (writes apply within seconds). */
const eventually = <E, R>(check: Effect.Effect<boolean, E, R>, expected: boolean) =>
  check.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (value) => value === expected,
      times: 15,
    }),
  );

// --- WebSocket clients ---

/** A frame of the `json.webpubsub.azure.v1` subprotocol. */
interface Frame {
  readonly type: string;
  readonly event?: string;
  readonly connectionId?: string;
  readonly userId?: string;
  readonly from?: string;
  readonly dataType?: string;
  readonly data?: unknown;
}

/** A connected client: its connection ID and the frames it receives. */
interface Client {
  readonly connectionId: string;
  readonly userId: string | undefined;
  /** The next server message. */
  readonly message: Effect.Effect<Frame, unknown>;
  /** The `disconnected` system event the service sends before it closes the socket. */
  readonly disconnected: Effect.Effect<Frame, unknown>;
}

/** Open a client socket with `token`; lives until the test's scope closes. */
const open = (token: string) =>
  Effect.gen(function* () {
    const { serviceName, hub } = yield* stack;
    const socket = yield* Socket.makeWebSocket(
      `wss://${serviceName}.webpubsub.azure.com/client/hubs/${hub}?access_token=${encodeURIComponent(token)}`,
      { protocols: "json.webpubsub.azure.v1", openTimeout: "30 seconds" },
    );
    const reader = yield* socket.reader;
    const decoder = new TextDecoder();
    const pending: Frame[] = [];
    const take = (match: (frame: Frame) => boolean) =>
      Effect.gen(function* () {
        while (true) {
          const index = pending.findIndex(match);
          if (index >= 0) return pending.splice(index, 1)[0]!;
          const batch = yield* reader.pull;
          for (const raw of batch) {
            const frame = yield* Effect.try(
              () => JSON.parse(typeof raw === "string" ? raw : decoder.decode(raw)) as Frame,
            );
            pending.push(frame);
          }
        }
      }).pipe(Effect.timeout("60 seconds"));
    const connected = yield* take((f) => f.type === "system" && f.event === "connected");
    return {
      connectionId: connected.connectionId!,
      userId: connected.userId,
      message: take((f) => f.type === "message"),
      disconnected: take((f) => f.type === "system" && f.event === "disconnected"),
    } satisfies Client;
  }).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal));

/** Connect a client with a token the deployer mints. */
const connect = (userId?: string) =>
  Effect.gen(function* () {
    const where = yield* hub;
    const { token } = yield* data
      .GenerateClientToken({ ...where, userId })
      .pipe(Effect.retry(whileDenied));
    return yield* open(token);
  });

const live = { timeout: 600_000 };

/** `?a=b&c=d` from defined values. */
const qs = (params: Record<string, string | undefined>) =>
  `?${new URLSearchParams(
    Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined),
  )}`;

describe(
  "Web PubSub bindings on an Azure Function",
  { tags: [...tags, "provider:azure:webpubsub-data"] },
  () => {
    describe("WebPubSub.SendToAll", () => {
      test(
        "broadcasts text and JSON to every connection",
        Effect.gen(function* () {
          const client = yield* connect();
          expectOk(yield* call(`/sendToAll${qs({ body: "hello everyone" })}`));
          expect(yield* client.message).toMatchObject({
            from: "server",
            dataType: "text",
            data: "hello everyone",
          });
          expectOk(
            yield* call(
              `/sendToAll${qs({ body: JSON.stringify({ n: 1 }), contentType: "application/json" })}`,
            ),
          );
          expect(yield* client.message).toMatchObject({ dataType: "json", data: { n: 1 } });
        }).pipe(Effect.scoped, Effect.provide(azure)),
        live,
      );
    });

    describe("WebPubSub.SendToConnection", () => {
      test(
        "sends to one connection",
        Effect.gen(function* () {
          const client = yield* connect();
          expectOk(
            yield* call(
              `/sendToConnection${qs({ connectionId: client.connectionId, body: "just you" })}`,
            ),
          );
          expect(yield* client.message).toMatchObject({ dataType: "text", data: "just you" });
        }).pipe(Effect.scoped, Effect.provide(azure)),
        live,
      );
    });

    describe("WebPubSub.SendToGroup", () => {
      test(
        "sends to the connections in a group",
        Effect.gen(function* () {
          const client = yield* connect();
          yield* joinGroup(client.connectionId, "g-send");
          expectOk(yield* call(`/sendToGroup${qs({ group: "g-send", body: "room message" })}`));
          expect(yield* client.message).toMatchObject({ dataType: "text", data: "room message" });
        }).pipe(Effect.scoped, Effect.provide(azure)),
        live,
      );
    });

    describe("WebPubSub.SendToUser", () => {
      test(
        "sends to every connection of a user",
        Effect.gen(function* () {
          const client = yield* connect("u-send");
          expect(client.userId).toEqual("u-send");
          expectOk(yield* call(`/sendToUser${qs({ userId: "u-send", body: "for you" })}`));
          expect(yield* client.message).toMatchObject({ dataType: "text", data: "for you" });
        }).pipe(Effect.scoped, Effect.provide(azure)),
        live,
      );
    });

    describe("WebPubSub.AddConnectionToGroup", () => {
      test(
        "adds a connection to a group",
        Effect.gen(function* () {
          const client = yield* connect();
          expectOk(
            yield* call(
              `/addConnectionToGroup${qs({ group: "g-add", connectionId: client.connectionId })}`,
            ),
          );
          expect(yield* membersOf("g-add", [client.connectionId])).toEqual([client.connectionId]);
        }).pipe(Effect.scoped, Effect.provide(azure)),
        live,
      );
    });

    describe("WebPubSub.AddConnectionsToGroups", () => {
      test(
        "adds the filtered connections to several groups",
        Effect.gen(function* () {
          const picked = yield* connect();
          const other = yield* connect();
          expectOk(
            yield* call(
              `/addConnectionsToGroups${qs({
                groups: "g-many-1,g-many-2",
                filter: `connectionId eq '${picked.connectionId}'`,
              })}`,
            ),
          );
          expect(yield* membersOf("g-many-1", [picked.connectionId])).toEqual([
            picked.connectionId,
          ]);
          expect(yield* membersOf("g-many-2", [picked.connectionId])).toEqual([
            picked.connectionId,
          ]);
          expect(yield* connectionExists(other.connectionId)).toBe(true);
        }).pipe(Effect.scoped, Effect.provide(azure)),
        live,
      );
    });

    describe("WebPubSub.AddUserToGroup", () => {
      test(
        "adds a user's connections to a group",
        Effect.gen(function* () {
          const client = yield* connect("u-add");
          expectOk(yield* call(`/addUserToGroup${qs({ userId: "u-add", group: "g-user-add" })}`));
          expect(yield* membersOf("g-user-add", [client.connectionId])).toEqual([
            client.connectionId,
          ]);
        }).pipe(Effect.scoped, Effect.provide(azure)),
        live,
      );
    });

    describe("WebPubSub.RemoveConnectionFromGroup", () => {
      test(
        "removes a connection from a group",
        Effect.gen(function* () {
          const client = yield* connect();
          const stay = yield* connect();
          yield* joinGroup(client.connectionId, "g-remove");
          yield* joinGroup(stay.connectionId, "g-remove");
          expectOk(
            yield* call(
              `/removeConnectionFromGroup${qs({ group: "g-remove", connectionId: client.connectionId })}`,
            ),
          );
          expect(yield* membersOf("g-remove", [stay.connectionId])).toEqual([stay.connectionId]);
        }).pipe(Effect.scoped, Effect.provide(azure)),
        live,
      );
    });

    describe("WebPubSub.RemoveConnectionsFromGroups", () => {
      test(
        "removes the filtered connections from several groups",
        Effect.gen(function* () {
          const client = yield* connect();
          const stay = yield* connect();
          for (const group of ["g-unmany-1", "g-unmany-2"]) {
            yield* joinGroup(client.connectionId, group);
            yield* joinGroup(stay.connectionId, group);
          }
          expectOk(
            yield* call(
              `/removeConnectionsFromGroups${qs({
                groups: "g-unmany-1,g-unmany-2",
                filter: `connectionId eq '${client.connectionId}'`,
              })}`,
            ),
          );
          expect(yield* membersOf("g-unmany-1", [stay.connectionId])).toEqual([stay.connectionId]);
          expect(yield* membersOf("g-unmany-2", [stay.connectionId])).toEqual([stay.connectionId]);
        }).pipe(Effect.scoped, Effect.provide(azure)),
        live,
      );
    });

    describe("WebPubSub.RemoveConnectionFromAllGroups", () => {
      test(
        "removes a connection from every group",
        Effect.gen(function* () {
          const client = yield* connect();
          yield* joinGroup(client.connectionId, "g-all-1");
          yield* joinGroup(client.connectionId, "g-all-2");
          expectOk(
            yield* call(
              `/removeConnectionFromAllGroups${qs({ connectionId: client.connectionId })}`,
            ),
          );
          expect(yield* membersOf("g-all-1", [])).toEqual([]);
          expect(yield* membersOf("g-all-2", [])).toEqual([]);
          expect(yield* connectionExists(client.connectionId)).toBe(true);
        }).pipe(Effect.scoped, Effect.provide(azure)),
        live,
      );
    });

    describe("WebPubSub.RemoveUserFromGroup", () => {
      test(
        "removes a user's connections from a group",
        Effect.gen(function* () {
          const client = yield* connect("u-remove");
          yield* addUser("u-remove", "g-user-remove");
          expect(yield* membersOf("g-user-remove", [client.connectionId])).toEqual([
            client.connectionId,
          ]);
          expectOk(
            yield* call(
              `/removeUserFromGroup${qs({ userId: "u-remove", group: "g-user-remove" })}`,
            ),
          );
          expect(yield* membersOf("g-user-remove", [])).toEqual([]);
        }).pipe(Effect.scoped, Effect.provide(azure)),
        live,
      );
    });

    describe("WebPubSub.RemoveUserFromAllGroups", () => {
      test(
        "removes a user's connections from every group",
        Effect.gen(function* () {
          const client = yield* connect("u-remove-all");
          yield* addUser("u-remove-all", "g-user-all-1");
          yield* addUser("u-remove-all", "g-user-all-2");
          expect(yield* membersOf("g-user-all-1", [client.connectionId])).toEqual([
            client.connectionId,
          ]);
          expectOk(yield* call(`/removeUserFromAllGroups${qs({ userId: "u-remove-all" })}`));
          expect(yield* membersOf("g-user-all-1", [])).toEqual([]);
          expect(yield* membersOf("g-user-all-2", [])).toEqual([]);
        }).pipe(Effect.scoped, Effect.provide(azure)),
        live,
      );
    });

    describe("WebPubSub.CloseConnection", () => {
      test(
        "closes one connection",
        Effect.gen(function* () {
          const client = yield* connect();
          const stay = yield* connect();
          expectOk(
            yield* call(
              `/closeConnection${qs({ connectionId: client.connectionId, reason: "bye" })}`,
            ),
          );
          expect(yield* client.disconnected).toMatchObject({ event: "disconnected" });
          expect(yield* eventually(connectionExists(client.connectionId), false)).toBe(false);
          expect(yield* connectionExists(stay.connectionId)).toBe(true);
        }).pipe(Effect.scoped, Effect.provide(azure)),
        live,
      );
    });

    describe("WebPubSub.CloseAllConnections", () => {
      test(
        "closes every connection except the excluded ones",
        Effect.gen(function* () {
          const keep = yield* connect();
          const client = yield* connect();
          expectOk(yield* call(`/closeAllConnections${qs({ excluded: keep.connectionId })}`));
          expect(yield* client.disconnected).toMatchObject({ event: "disconnected" });
          expect(yield* eventually(connectionExists(client.connectionId), false)).toBe(false);
          expect(yield* connectionExists(keep.connectionId)).toBe(true);
        }).pipe(Effect.scoped, Effect.provide(azure)),
        live,
      );
    });

    describe("WebPubSub.CloseGroupConnections", () => {
      test(
        "closes the connections in a group",
        Effect.gen(function* () {
          const client = yield* connect();
          const stay = yield* connect();
          yield* joinGroup(client.connectionId, "g-close");
          expectOk(yield* call(`/closeGroupConnections${qs({ group: "g-close" })}`));
          expect(yield* client.disconnected).toMatchObject({ event: "disconnected" });
          expect(yield* eventually(connectionExists(client.connectionId), false)).toBe(false);
          expect(yield* connectionExists(stay.connectionId)).toBe(true);
        }).pipe(Effect.scoped, Effect.provide(azure)),
        live,
      );
    });

    describe("WebPubSub.CloseUserConnections", () => {
      test(
        "closes every connection of a user",
        Effect.gen(function* () {
          const client = yield* connect("u-close");
          expectOk(yield* call(`/closeUserConnections${qs({ userId: "u-close" })}`));
          expect(yield* client.disconnected).toMatchObject({ event: "disconnected" });
          expect(yield* eventually(userExists("u-close"), false)).toBe(false);
        }).pipe(Effect.scoped, Effect.provide(azure)),
        live,
      );
    });

    describe("WebPubSub.GrantPermission", () => {
      test(
        "grants a connection sendToGroup on a group",
        Effect.gen(function* () {
          const client = yield* connect();
          expect(yield* hasPermission(client.connectionId, "g-grant")).toBe(false);
          expectOk(
            yield* call(
              `/grantPermission${qs({
                permission: "sendToGroup",
                connectionId: client.connectionId,
                targetName: "g-grant",
              })}`,
            ),
          );
          expect(yield* hasPermission(client.connectionId, "g-grant")).toBe(true);
        }).pipe(Effect.scoped, Effect.provide(azure)),
        live,
      );
    });

    describe("WebPubSub.RevokePermission", () => {
      test(
        "revokes a connection's sendToGroup on a group",
        Effect.gen(function* () {
          const client = yield* connect();
          yield* grant(client.connectionId, "g-revoke");
          expect(yield* hasPermission(client.connectionId, "g-revoke")).toBe(true);
          expectOk(
            yield* call(
              `/revokePermission${qs({
                permission: "sendToGroup",
                connectionId: client.connectionId,
                targetName: "g-revoke",
              })}`,
            ),
          );
          expect(yield* hasPermission(client.connectionId, "g-revoke")).toBe(false);
        }).pipe(Effect.scoped, Effect.provide(azure)),
        live,
      );
    });

    describe("WebPubSub.CheckPermission", () => {
      test(
        "answers true for a granted permission and false otherwise",
        Effect.gen(function* () {
          const client = yield* connect();
          yield* grant(client.connectionId, "g-check");
          const check = (group: string) =>
            call(
              `/checkPermission${qs({
                permission: "sendToGroup",
                connectionId: client.connectionId,
                targetName: group,
              })}`,
            );
          const granted = yield* check("g-check");
          expectOk(granted);
          expect(granted.result).toBe(true);
          const other = yield* check("g-check-other");
          expectOk(other);
          expect(other.result).toBe(false);
        }).pipe(Effect.scoped, Effect.provide(azure)),
        live,
      );
    });

    describe("WebPubSub.ConnectionExists", () => {
      test(
        "answers true for an open connection and false otherwise",
        Effect.gen(function* () {
          const client = yield* connect();
          const found = yield* call(
            `/connectionExists${qs({ connectionId: client.connectionId })}`,
          );
          expectOk(found);
          expect(found.result).toBe(true);
          const missing = yield* call(
            `/connectionExists${qs({ connectionId: "no-such-connection" })}`,
          );
          expectOk(missing);
          expect(missing.result).toBe(false);
          expect(yield* connectionExists("no-such-connection")).toBe(false);
        }).pipe(Effect.scoped, Effect.provide(azure)),
        live,
      );
    });

    describe("WebPubSub.GroupExists", () => {
      test(
        "answers true for a group with connections and false otherwise",
        Effect.gen(function* () {
          const client = yield* connect();
          yield* joinGroup(client.connectionId, "g-exists");
          const found = yield* call(`/groupExists${qs({ group: "g-exists" })}`);
          expectOk(found);
          expect(found.result).toBe(true);
          const empty = yield* call(`/groupExists${qs({ group: "g-empty" })}`);
          expectOk(empty);
          expect(empty.result).toBe(false);
          expect(yield* groupExists("g-empty")).toBe(false);
        }).pipe(Effect.scoped, Effect.provide(azure)),
        live,
      );
    });

    describe("WebPubSub.UserExists", () => {
      test(
        "answers true for a connected user and false otherwise",
        Effect.gen(function* () {
          yield* connect("u-exists");
          const found = yield* call(`/userExists${qs({ userId: "u-exists" })}`);
          expectOk(found);
          expect(found.result).toBe(true);
          const missing = yield* call(`/userExists${qs({ userId: "u-nobody" })}`);
          expectOk(missing);
          expect(missing.result).toBe(false);
          expect(yield* userExists("u-nobody")).toBe(false);
        }).pipe(Effect.scoped, Effect.provide(azure)),
        live,
      );
    });

    describe("WebPubSub.ListConnectionsInGroup", () => {
      test(
        "lists every connection in a group across pages",
        Effect.gen(function* () {
          const a = yield* connect("u-list");
          const b = yield* connect();
          yield* joinGroup(a.connectionId, "g-list");
          yield* joinGroup(b.connectionId, "g-list");
          const body = yield* call(`/listConnectionsInGroup${qs({ group: "g-list" })}`);
          expectOk(body);
          // The route asks for one connection per page.
          expect(
            [...body.result].sort((x: { connectionId: string }, y: { connectionId: string }) =>
              x.connectionId.localeCompare(y.connectionId),
            ),
          ).toEqual(
            [
              { connectionId: a.connectionId, userId: "u-list" },
              { connectionId: b.connectionId, userId: null },
            ].sort((x, y) => x.connectionId.localeCompare(y.connectionId)),
          );
          expect(yield* membersOf("g-list", [a.connectionId, b.connectionId].sort())).toEqual(
            [a.connectionId, b.connectionId].sort(),
          );
        }).pipe(Effect.scoped, Effect.provide(azure)),
        live,
      );
    });

    describe("WebPubSub.GenerateClientToken", () => {
      test(
        "mints a token a client connects with as the user, joining its groups",
        Effect.gen(function* () {
          const body = yield* call(
            `/generateClientToken${qs({ userId: "u-token", groups: "g-token" })}`,
          );
          expectOk(body);
          const client = yield* open(body.result.token);
          expect(client.userId).toEqual("u-token");
          expect(yield* userExists("u-token")).toBe(true);
          expect(yield* membersOf("g-token", [client.connectionId])).toEqual([client.connectionId]);
        }).pipe(Effect.scoped, Effect.provide(azure)),
        live,
      );
    });

    describe("WebPubSub.GetServiceStatus", () => {
      test(
        "reports the service healthy",
        Effect.gen(function* () {
          const body = yield* call("/getServiceStatus");
          expectOk(body);
          expect(body.result).toEqual("healthy");
        }),
        live,
      );
    });

    describe("least privilege", () => {
      test(
        "assigns one custom role per data action, on the Web PubSub service only",
        Effect.gen(function* () {
          const out = yield* stack;
          expect(out.principalId).toMatch(/^[0-9a-f-]{36}$/);
          const { subscriptionId } = yield* Azure.AzureEnvironment.current;
          const expected = [
            "clientConnection/generateToken/action",
            "clientConnection/read",
            "clientConnection/send/action",
            "clientConnection/write",
            "group/read",
            "group/send/action",
            "group/write",
            "hub/send/action",
            "user/read",
            "user/send/action",
          ].sort();
          const observe = Effect.gen(function* () {
            const page = yield* authorization.ListRoleAssignmentForSubscription({
              subscriptionId,
              _filter: `principalId eq '${out.principalId}'`,
            });
            const grants: { scope: string; actions: string[]; dataActions: string[] }[] = [];
            for (const assignment of page.value) {
              const role = yield* authorization.GetRoleDefinition({
                scope: `/subscriptions/${subscriptionId}`,
                roleDefinitionId: assignment.properties?.roleDefinitionId?.split("/").pop() ?? "",
              });
              const permissions = role.properties?.permissions ?? [];
              const dataActions = permissions.flatMap((p) => p.dataActions ?? []);
              // The app's own hosting roles (its deployment storage) are not bindings.
              if (!dataActions.some((a) => a.startsWith("Microsoft.SignalRService/"))) continue;
              grants.push({
                scope: assignment.properties?.scope?.toLowerCase() ?? "",
                actions: permissions.flatMap((p) => p.actions ?? []),
                dataActions,
              });
            }
            return grants;
          });
          // Role-assignment lists trail new assignments.
          const grants = yield* observe.pipe(
            Effect.repeat({
              schedule: Schedule.spaced("10 seconds"),
              until: (found) => found.length >= expected.length,
              times: 12,
            }),
          );
          for (const grant of grants) {
            expect(grant.scope).toEqual(out.serviceId.toLowerCase());
            expect(grant.actions).toEqual([]);
          }
          const granted = grants.flatMap((g) =>
            g.dataActions.map((a) => a.replace("Microsoft.SignalRService/WebPubSub/", "")),
          );
          expect(granted.sort()).toEqual(expected);
          // One shared custom role per data action (the cleanup check below finds them by marker).
          expect(yield* stackRoles).toHaveLength(expected.length);
        }).pipe(Effect.provide(azure)),
        { timeout: 240_000 },
      );
    });
  },
);

/** This stack's custom roles: role definitions carry an `[alchemy <stack>/…]` marker. */
const stackRoles = Effect.gen(function* () {
  const { subscriptionId } = yield* Azure.AzureEnvironment.current;
  const roles = yield* Stream.runCollect(
    authorization.ListRoleDefinitions.items({
      scope: `/subscriptions/${subscriptionId}`,
      _filter: "type eq 'CustomRole'",
    }),
  );
  return Array.from(roles)
    .filter((r) => r.properties?.description?.includes("[alchemy AzureWebPubSubBindings/"))
    .map((r) => r.properties?.roleName ?? "")
    .sort();
});

// Destroy, then prove the service and the custom roles are gone.
afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    // `undefined` when the deploy failed; destroy still removes what it created.
    const out = yield* stack;
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    yield* destroy(Stack);
    if (out !== undefined) {
      expect(
        yield* waitGone(
          webpubsub.GetWebPubSub({
            subscriptionId,
            resourceGroupName: out.resourceGroup,
            resourceName: out.serviceName,
          }),
        ),
      ).toEqual("gone");
    }
    // Role-definition lists trail deletes by seconds.
    const left = yield* stackRoles.pipe(
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (names) => names.length === 0,
        times: 12,
      }),
    );
    expect(left).toEqual([]);
  }).pipe(Effect.provide(azure)),
  { timeout: 1_200_000 },
);
