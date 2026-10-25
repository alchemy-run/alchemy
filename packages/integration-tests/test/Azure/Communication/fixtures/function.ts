import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { distilledFromSource } from "./distilled-source.ts";

// Resources the fixture binds. Module-scope so the test stack yields the
// same declarations.

export const Email = Azure.Communication.EmailService("AcsBindingsEmail");
/** Azure-managed domain: `DoNotReply@<guid>.azurecomm.net` can send right away. */
export const Domain = Effect.gen(function* () {
  const email = yield* Email;
  return yield* Azure.Communication.EmailDomain("AcsBindingsDomain", {
    emailService: email.emailServiceName,
  });
});
export const Acs = Effect.gen(function* () {
  const domain = yield* Domain;
  return yield* Azure.Communication.CommunicationService("AcsBindingsService", {
    linkedDomains: [domain.domainId],
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

/** A binding callable; each takes its own request type. */
type Call = (request: never) => Effect.Effect<unknown, unknown, RuntimeContext>;

/**
 * Effect Function with one route per Communication Services binding:
 * `POST /<Binding>` with the binding's request as the JSON body calls it
 * and answers `{ ok, result | error }` (a 500 on error, so a caller retries
 * through role propagation and a real failure shows the Azure error).
 */
export default class CommunicationBindingsFunction extends Azure.Functions.Function<CommunicationBindingsFunction>()(
  "CommunicationBindingsFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const acs = yield* Acs;
    const C = Azure.Communication;
    const calls: Record<string, Call> = {
      // Email
      SendEmail: yield* C.SendEmail(acs),
      GetEmailSendResult: yield* C.GetEmailSendResult(acs),
      // SMS
      SendSms: yield* C.SendSms(acs),
      AddSmsOptOut: yield* C.AddSmsOptOut(acs),
      RemoveSmsOptOut: yield* C.RemoveSmsOptOut(acs),
      CheckSmsOptOut: yield* C.CheckSmsOptOut(acs),
      GetSmsDeliveryReport: yield* C.GetSmsDeliveryReport(acs),
      // Identity
      CreateIdentity: yield* C.CreateIdentity(acs),
      DeleteIdentity: yield* C.DeleteIdentity(acs),
      IssueAccessToken: yield* C.IssueAccessToken(acs),
      RevokeAccessTokens: yield* C.RevokeAccessTokens(acs),
      ExchangeTeamsUserAccessToken: yield* C.ExchangeTeamsUserAccessToken(acs),
      ExchangeTeamsExtensionToken: yield* C.ExchangeTeamsExtensionToken(acs),
      GetTeamsExtensionAssignment: yield* C.GetTeamsExtensionAssignment(acs),
      UpsertTeamsExtensionAssignment: yield* C.UpsertTeamsExtensionAssignment(acs),
      DeleteTeamsExtensionAssignment: yield* C.DeleteTeamsExtensionAssignment(acs),
      // Rooms
      CreateRoom: yield* C.CreateRoom(acs),
      GetRoom: yield* C.GetRoom(acs),
      UpdateRoom: yield* C.UpdateRoom(acs),
      DeleteRoom: yield* C.DeleteRoom(acs),
      ListRooms: yield* C.ListRooms(acs),
      ListRoomParticipants: yield* C.ListRoomParticipants(acs),
      UpdateRoomParticipants: yield* C.UpdateRoomParticipants(acs),
      // Chat
      CreateChatThread: yield* C.CreateChatThread(acs),
      DeleteChatThread: yield* C.DeleteChatThread(acs),
      ListChatThreads: yield* C.ListChatThreads(acs),
      GetChatThreadProperties: yield* C.GetChatThreadProperties(acs),
      UpdateChatThreadProperties: yield* C.UpdateChatThreadProperties(acs),
      SendChatMessage: yield* C.SendChatMessage(acs),
      GetChatMessage: yield* C.GetChatMessage(acs),
      ListChatMessages: yield* C.ListChatMessages(acs),
      UpdateChatMessage: yield* C.UpdateChatMessage(acs),
      DeleteChatMessage: yield* C.DeleteChatMessage(acs),
      AddChatParticipants: yield* C.AddChatParticipants(acs),
      RemoveChatParticipant: yield* C.RemoveChatParticipant(acs),
      ListChatParticipants: yield* C.ListChatParticipants(acs),
      SendChatReadReceipt: yield* C.SendChatReadReceipt(acs),
      ListChatReadReceipts: yield* C.ListChatReadReceipts(acs),
      SendChatTypingNotification: yield* C.SendChatTypingNotification(acs),
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const call = calls[url.pathname.slice(1)];
        if (call === undefined) {
          return HttpServerResponse.text("not found", { status: 404 });
        }
        const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed({})));
        // The test sends the binding's own request type as JSON.
        return yield* respond(call(body as never));
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.Communication.SendEmailHttp,
        Azure.Communication.GetEmailSendResultHttp,
        Azure.Communication.SendSmsHttp,
        Azure.Communication.AddSmsOptOutHttp,
        Azure.Communication.RemoveSmsOptOutHttp,
        Azure.Communication.CheckSmsOptOutHttp,
        Azure.Communication.GetSmsDeliveryReportHttp,
        Azure.Communication.CreateIdentityHttp,
        Azure.Communication.DeleteIdentityHttp,
        Azure.Communication.IssueAccessTokenHttp,
        Azure.Communication.RevokeAccessTokensHttp,
        Azure.Communication.ExchangeTeamsUserAccessTokenHttp,
        Azure.Communication.ExchangeTeamsExtensionTokenHttp,
        Azure.Communication.GetTeamsExtensionAssignmentHttp,
        Azure.Communication.UpsertTeamsExtensionAssignmentHttp,
        Azure.Communication.DeleteTeamsExtensionAssignmentHttp,
        Azure.Communication.CreateRoomHttp,
        Azure.Communication.GetRoomHttp,
        Azure.Communication.UpdateRoomHttp,
        Azure.Communication.DeleteRoomHttp,
        Azure.Communication.ListRoomsHttp,
        Azure.Communication.ListRoomParticipantsHttp,
        Azure.Communication.UpdateRoomParticipantsHttp,
        Azure.Communication.CreateChatThreadHttp,
        Azure.Communication.DeleteChatThreadHttp,
        Azure.Communication.ListChatThreadsHttp,
        Azure.Communication.GetChatThreadPropertiesHttp,
        Azure.Communication.UpdateChatThreadPropertiesHttp,
        Azure.Communication.SendChatMessageHttp,
        Azure.Communication.GetChatMessageHttp,
        Azure.Communication.ListChatMessagesHttp,
        Azure.Communication.UpdateChatMessageHttp,
        Azure.Communication.DeleteChatMessageHttp,
        Azure.Communication.AddChatParticipantsHttp,
        Azure.Communication.RemoveChatParticipantHttp,
        Azure.Communication.ListChatParticipantsHttp,
        Azure.Communication.SendChatReadReceiptHttp,
        Azure.Communication.ListChatReadReceiptsHttp,
        Azure.Communication.SendChatTypingNotificationHttp,
      ),
    ),
  ),
) {}
