import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { distilledFromSource } from "./distilled-source.ts";

// Resources the fixture binds. Module-scope so the test stack yields the
// same declarations.

// Standard_S1 (~$1.61/day): a subscription holds one Free_F1 service per
// region, which the WebPubSub resource tests use.
export const PubSub = Azure.WebPubSub.WebPubSub("WpsBindingsService", { sku: "Standard_S1" });

/** The hub every hub binding is bound to. */
export const HUB = "chat";
export const Chat = Effect.gen(function* () {
  const service = yield* PubSub;
  return yield* Azure.WebPubSub.Hub("WpsBindingsChat", {
    webPubSub: service.webPubSubName,
    name: HUB,
  });
});

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result: result ?? null })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/** A credential as `{ redacted: value }`, so the test sees the binding returned it `Redacted`. */
const exposeRedacted = (value: string | Redacted.Redacted<string>) =>
  Redacted.isRedacted(value) ? { redacted: Redacted.value(value) } : value;

const list = (value: string | null) => (value ? value.split(",") : undefined);

/**
 * Effect Function with one route per Web PubSub binding. Routes take the
 * request members as query parameters (`connectionId`, `userId`, `group`,
 * `groups` comma-separated, `body`, `contentType`, `filter`, `permission`,
 * `targetName`, `reason`) and answer `{ ok, result | error }` with a 500 on
 * error, so a caller retries through role propagation and a real failure
 * shows the Web PubSub error.
 */
export default class WebPubSubBindingsFunction extends Azure.Functions.Function<WebPubSubBindingsFunction>()(
  "WebPubSubBindingsFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const service = yield* PubSub;
    const chat = yield* Chat;
    const addConnectionToGroup = yield* Azure.WebPubSub.AddConnectionToGroup(chat);
    const addConnectionsToGroups = yield* Azure.WebPubSub.AddConnectionsToGroups(chat);
    const addUserToGroup = yield* Azure.WebPubSub.AddUserToGroup(chat);
    const checkPermission = yield* Azure.WebPubSub.CheckPermission(chat);
    const closeAllConnections = yield* Azure.WebPubSub.CloseAllConnections(chat);
    const closeConnection = yield* Azure.WebPubSub.CloseConnection(chat);
    const closeGroupConnections = yield* Azure.WebPubSub.CloseGroupConnections(chat);
    const closeUserConnections = yield* Azure.WebPubSub.CloseUserConnections(chat);
    const connectionExists = yield* Azure.WebPubSub.ConnectionExists(chat);
    const generateClientToken = yield* Azure.WebPubSub.GenerateClientToken(chat);
    const getServiceStatus = yield* Azure.WebPubSub.GetServiceStatus(service);
    const grantPermission = yield* Azure.WebPubSub.GrantPermission(chat);
    const groupExists = yield* Azure.WebPubSub.GroupExists(chat);
    const listConnectionsInGroup = yield* Azure.WebPubSub.ListConnectionsInGroup(chat);
    const removeConnectionFromAllGroups =
      yield* Azure.WebPubSub.RemoveConnectionFromAllGroups(chat);
    const removeConnectionFromGroup = yield* Azure.WebPubSub.RemoveConnectionFromGroup(chat);
    const removeConnectionsFromGroups = yield* Azure.WebPubSub.RemoveConnectionsFromGroups(chat);
    const removeUserFromAllGroups = yield* Azure.WebPubSub.RemoveUserFromAllGroups(chat);
    const removeUserFromGroup = yield* Azure.WebPubSub.RemoveUserFromGroup(chat);
    const revokePermission = yield* Azure.WebPubSub.RevokePermission(chat);
    const sendToAll = yield* Azure.WebPubSub.SendToAll(chat);
    const sendToConnection = yield* Azure.WebPubSub.SendToConnection(chat);
    const sendToGroup = yield* Azure.WebPubSub.SendToGroup(chat);
    const sendToUser = yield* Azure.WebPubSub.SendToUser(chat);
    const userExists = yield* Azure.WebPubSub.UserExists(chat);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const q = (name: string) => url.searchParams.get(name) ?? "";
        const connectionId = q("connectionId");
        const userId = q("userId");
        const group = q("group");
        const groups = list(url.searchParams.get("groups")) ?? [];
        const filter = url.searchParams.get("filter") ?? undefined;
        const reason = url.searchParams.get("reason") ?? undefined;
        const excluded = list(url.searchParams.get("excluded"));
        const permission = q("permission");
        const targetName = url.searchParams.get("targetName") ?? undefined;
        const message = {
          body: q("body"),
          contentType: url.searchParams.get("contentType") ?? undefined,
        };
        switch (url.pathname) {
          case "/addConnectionToGroup":
            return yield* respond(addConnectionToGroup({ group, connectionId }));
          case "/addConnectionsToGroups":
            return yield* respond(addConnectionsToGroups({ groups, filter }));
          case "/addUserToGroup":
            return yield* respond(addUserToGroup({ userId, group }));
          case "/checkPermission":
            return yield* respond(checkPermission({ permission, connectionId, targetName }));
          case "/closeAllConnections":
            return yield* respond(closeAllConnections({ excluded, reason }));
          case "/closeConnection":
            return yield* respond(closeConnection({ connectionId, reason }));
          case "/closeGroupConnections":
            return yield* respond(closeGroupConnections({ group, excluded, reason }));
          case "/closeUserConnections":
            return yield* respond(closeUserConnections({ userId, excluded, reason }));
          case "/connectionExists":
            return yield* respond(connectionExists({ connectionId }));
          case "/generateClientToken":
            return yield* respond(
              Effect.map(
                generateClientToken({ userId: userId || undefined, group: list(q("groups")) }),
                ({ token }) => ({ token: exposeRedacted(token) }),
              ),
            );
          case "/getServiceStatus":
            return yield* respond(Effect.as(getServiceStatus(), "healthy"));
          case "/grantPermission":
            return yield* respond(grantPermission({ permission, connectionId, targetName }));
          case "/groupExists":
            return yield* respond(groupExists({ group }));
          case "/listConnectionsInGroup":
            return yield* respond(
              Effect.map(listConnectionsInGroup({ group, maxpagesize: 1 }), (members) =>
                members.map((m) => ({ connectionId: m.connectionId, userId: m.userId ?? null })),
              ),
            );
          case "/removeConnectionFromAllGroups":
            return yield* respond(removeConnectionFromAllGroups({ connectionId }));
          case "/removeConnectionFromGroup":
            return yield* respond(removeConnectionFromGroup({ group, connectionId }));
          case "/removeConnectionsFromGroups":
            return yield* respond(removeConnectionsFromGroups({ groups, filter }));
          case "/removeUserFromAllGroups":
            return yield* respond(removeUserFromAllGroups({ userId }));
          case "/removeUserFromGroup":
            return yield* respond(removeUserFromGroup({ userId, group }));
          case "/revokePermission":
            return yield* respond(revokePermission({ permission, connectionId, targetName }));
          case "/sendToAll":
            return yield* respond(sendToAll({ ...message, excluded }));
          case "/sendToConnection":
            return yield* respond(sendToConnection({ ...message, connectionId }));
          case "/sendToGroup":
            return yield* respond(sendToGroup({ ...message, group, excluded }));
          case "/sendToUser":
            return yield* respond(sendToUser({ ...message, userId }));
          case "/userExists":
            return yield* respond(userExists({ userId }));
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.WebPubSub.AddConnectionToGroupHttp,
        Azure.WebPubSub.AddConnectionsToGroupsHttp,
        Azure.WebPubSub.AddUserToGroupHttp,
        Azure.WebPubSub.CheckPermissionHttp,
        Azure.WebPubSub.CloseAllConnectionsHttp,
        Azure.WebPubSub.CloseConnectionHttp,
        Azure.WebPubSub.CloseGroupConnectionsHttp,
        Azure.WebPubSub.CloseUserConnectionsHttp,
        Azure.WebPubSub.ConnectionExistsHttp,
        Azure.WebPubSub.GenerateClientTokenHttp,
        Azure.WebPubSub.GetServiceStatusHttp,
        Azure.WebPubSub.GrantPermissionHttp,
        Azure.WebPubSub.GroupExistsHttp,
        Azure.WebPubSub.ListConnectionsInGroupHttp,
        Azure.WebPubSub.RemoveConnectionFromAllGroupsHttp,
        Azure.WebPubSub.RemoveConnectionFromGroupHttp,
        Azure.WebPubSub.RemoveConnectionsFromGroupsHttp,
        Azure.WebPubSub.RemoveUserFromAllGroupsHttp,
        Azure.WebPubSub.RemoveUserFromGroupHttp,
        Azure.WebPubSub.RevokePermissionHttp,
        Azure.WebPubSub.SendToAllHttp,
        Azure.WebPubSub.SendToConnectionHttp,
        Azure.WebPubSub.SendToGroupHttp,
        Azure.WebPubSub.SendToUserHttp,
        Azure.WebPubSub.UserExistsHttp,
      ),
    ),
  ),
) {}
