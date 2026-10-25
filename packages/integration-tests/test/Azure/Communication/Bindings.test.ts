import * as Azure from "@alchemy.run/azure";
import { fromStaticToken } from "@distilled.cloud/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as communication from "@distilled.cloud/azure/communication";
import * as chat from "@distilled.cloud/azure/communication-chat";
import * as email from "@distilled.cloud/azure/communication-email";
import * as identity from "@distilled.cloud/azure/communication-identity";
import * as rooms from "@distilled.cloud/azure/communication-rooms";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { runPaidOnly } from "../gates.ts";
import CommunicationBindingsFunction, { Acs, Domain } from "./fixtures/function.ts";
import { waitGone } from "./util.ts";

const {
  test: baseTest,
  beforeAll,
  afterAll,
  deploy,
  destroy,
} = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "AzureCommunicationBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* CommunicationBindingsFunction;
    const acs = yield* Acs;
    const domain = yield* Domain;
    return {
      url: fn.url,
      principalId: fn.principalId,
      endpoint: acs.endpoint,
      communicationServiceId: acs.communicationServiceId,
      communicationServiceName: acs.communicationServiceName,
      resourceGroup: acs.resourceGroup,
      sender: domain.fromSenderDomain,
    };
  }),
);

// Communication services, email services, and Azure-managed domains are
// free (billed per message: two emails per run, < $0.001) + a Flex
// Consumption app; ~6 min deploy.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

/** Azure credentials and environment for out-of-band checks as the deployer. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

const live = { timeout: 600_000 };

/** A test whose body also gets the deployer's Azure credentials for out-of-band checks. */
const test = <A, E>(name: string, body: Effect.Effect<A, E, any>, options = live) =>
  baseTest(name, body.pipe(Effect.provide(azure)), options);

type Body = { ok: boolean; result?: any; error?: string };

/** POST the binding's request to `/<binding>` once. */
const post = (binding: string, request: unknown) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    const response = yield* HttpClient.execute(
      HttpClientRequest.post(`${url}/${binding}`).pipe(HttpClientRequest.bodyJsonUnsafe(request)),
    ).pipe(Effect.timeout("60 seconds"));
    return (yield* response.json) as Body;
  });

/**
 * Call a binding until it answers `ok`, through the Flex Consumption cold
 * start and role propagation, then return the last answer so a real
 * failure shows its Azure error.
 */
const call = (binding: string, request: unknown = {}) =>
  post(binding, request).pipe(
    Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 72 }),
    Effect.catch((body) => Effect.succeed(body as Body)),
  );

/**
 * Call a binding whose call fails for a reason the test asserts (a probe):
 * retries only while the host starts or the role propagates.
 */
const probe = (binding: string, request: unknown, expected: string) =>
  post(binding, request).pipe(
    Effect.flatMap((body) =>
      body?.ok === false && body.error?.includes(expected)
        ? Effect.succeed(body)
        : Effect.fail(body),
    ),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 72 }),
    Effect.catch((body) => Effect.succeed(body as Body)),
  );

/**
 * Retry an out-of-band read while it reports `tag`: a user, room, or thread
 * created a moment ago can be missing on the replica that serves the read.
 */
const settled =
  (...tags: string[]) =>
  <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.retry({
        while: (e) => tags.includes(e._tag),
        schedule: Schedule.spaced("2 seconds"),
        times: 15,
      }),
    );

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

const endpoint = Effect.map(stack, ({ endpoint }) => endpoint!);

/** Out of band: a Communication Services user and a chat token, as the deployer. */
const newUser = Effect.gen(function* () {
  const url = yield* endpoint;
  const created = yield* identity.CreateIdentityOperation({
    endpoint: url,
    createTokenWithScopes: ["chat"],
  });
  return { id: created.identity.id, token: created.accessToken!.token };
});

/**
 * Run a distilled chat operation out of band as the user owning `token`.
 * The token is provided around the call, so it wins over the deployer's
 * credentials.
 */
const asUser =
  (token: string) =>
  <I extends { endpoint: string }, A, E extends { readonly _tag: string }>(
    operation: (input: I) => Effect.Effect<A, E, chat.AzureOpContext>,
    request: Omit<I, "endpoint">,
  ) =>
    Effect.gen(function* () {
      const url = yield* endpoint;
      // `Omit<I, "endpoint"> & { endpoint }` is `I`; TypeScript cannot prove it for a generic `I`.
      return yield* operation({ ...request, endpoint: url } as I).pipe(
        Effect.provide(
          Layer.mergeAll(
            fromStaticToken({ bearerToken: token, subscriptionId: "" }),
            FetchHttpClient.layer,
          ),
        ),
        // A new thread or participant can lag on the replica serving the call.
        settled("ChatThreadNotFound", "ChatThreadAccessDenied"),
      );
    });

/** Out of band: a chat thread created by `user`, optionally with more participants. */
const newThread = (user: { id: string; token: string }, topic: string, others: string[] = []) =>
  asUser(user.token)(chat.CreateChatChatThread, {
    topic,
    participants: [user.id, ...others].map((id) => ({
      communicationIdentifier: { communicationUser: { id } },
    })),
  }).pipe(Effect.map((created) => created.chatThread!.id));

const participantIds = (page: { value: readonly chat.ChatParticipant[] }) =>
  page.value.map((p) => p.communicationIdentifier.communicationUser?.id ?? "").sort();

describe(
  "Azure Communication Services bindings on an Azure Function",
  { tags: ["provider:azure", "provider:azure:communication", "live"] },
  () => {
    // --- Email ---------------------------------------------------------

    describe("SendEmail", () => {
      test(
        "queues an email that Azure then sends",
        Effect.gen(function* () {
          const { sender } = yield* stack;
          const body = yield* call("SendEmail", {
            senderAddress: `DoNotReply@${sender}`,
            content: { subject: "alchemy SendEmail binding", plainText: "SendEmail" },
            recipients: { to: [{ address: "alchemy-send-email@example.com" }] },
          });
          expectOk(body);
          expect(body.result.id).toMatch(/^[0-9a-f-]{36}$/);
          const url = yield* endpoint;
          const result = yield* email
            .EmailGetSendResult({ endpoint: url, operationId: body.result.id })
            .pipe(
              Effect.repeat({
                schedule: Schedule.spaced("5 seconds"),
                until: (r) => r.status !== "NotStarted" && r.status !== "Running",
                times: 24,
              }),
            );
          expect({ status: result.status, error: result.error ?? undefined }).toEqual({
            status: "Succeeded",
            error: undefined,
          });
        }),
      );
    });

    describe("GetEmailSendResult", () => {
      test(
        "reads the status of a send operation",
        Effect.gen(function* () {
          const { sender } = yield* stack;
          const url = yield* endpoint;
          const sent = yield* email.SendEmail({
            endpoint: url,
            senderAddress: `DoNotReply@${sender}`,
            content: { subject: "alchemy GetEmailSendResult binding", plainText: "Get" },
            recipients: { to: [{ address: "alchemy-get-email@example.com" }] },
          });
          const body = yield* call("GetEmailSendResult", { operationId: sent.id });
          expectOk(body);
          expect(body.result.id).toEqual(sent.id);
          const observed = yield* email.EmailGetSendResult({
            endpoint: url,
            operationId: sent.id!,
          });
          expect(observed.id).toEqual(body.result.id);
        }),
      );
    });

    // --- Identity ------------------------------------------------------

    describe("CreateIdentity", () => {
      test(
        "creates a user and a chat token for it",
        Effect.gen(function* () {
          const body = yield* call("CreateIdentity", { createTokenWithScopes: ["chat"] });
          expectOk(body);
          const id: string = body.result.identity.id;
          expect(id).toMatch(/^8:acs:/);
          // The user exists: the deployer can issue it a token.
          const url = yield* endpoint;
          const token = yield* identity
            .IdentityOperationsIssueAccessToken({ endpoint: url, id, scopes: ["voip"] })
            .pipe(settled("IdentityNotOwned", "IdentityNotFound"));
          expect(token.token.split(".").length).toEqual(3);
          // The binding's own token works on the chat data plane.
          const threads = yield* asUser(body.result.accessToken.token)(
            chat.ListChatChatThreads,
            {},
          );
          expect(threads.value).toEqual([]);
        }),
      );
    });

    describe("IssueAccessToken", () => {
      test(
        "issues a chat token that the chat data plane accepts",
        Effect.gen(function* () {
          const user = yield* newUser;
          const body = yield* call("IssueAccessToken", {
            id: user.id,
            scopes: ["chat"],
            expiresInMinutes: 60,
          });
          expectOk(body);
          const minutes = (Date.parse(body.result.expiresOn) - Date.now()) / 60_000;
          expect(Math.round(minutes)).toEqual(60);
          const threadId = yield* newThread({ id: user.id, token: body.result.token }, "issued");
          expect(threadId).toMatch(/^19:/);
        }),
      );
    });

    describe("DeleteIdentity", () => {
      test(
        "deletes a user",
        Effect.gen(function* () {
          const user = yield* newUser;
          const body = yield* call("DeleteIdentity", { id: user.id });
          expectOk(body);
          const url = yield* endpoint;
          const issued = yield* identity
            .IdentityOperationsIssueAccessToken({ endpoint: url, id: user.id, scopes: ["chat"] })
            .pipe(Effect.flip);
          expect(issued._tag).toEqual("IdentityNotFound");
        }),
      );
    });

    describe("RevokeAccessTokens", () => {
      test(
        "revokes the tokens of a live user and reports a deleted one",
        Effect.gen(function* () {
          const user = yield* newUser;
          const body = yield* call("RevokeAccessTokens", { id: user.id });
          expectOk(body);
          // The call addresses the identity: a deleted one is reported.
          const url = yield* endpoint;
          yield* identity.DeleteIdentityOperation({ endpoint: url, id: user.id });
          const missing = yield* probe("RevokeAccessTokens", { id: user.id }, "IdentityNotFound");
          expect(missing.error).toContain("IdentityNotFound");
        }),
      );

      // Skipped: Chat honours a revocation after 90 s in one run and still
      // accepted the revoked token after 250 s in another (measured; the
      // delay is undocumented), so this check cannot be bounded.
      baseTest.skip(
        "a revoked token is eventually rejected by Chat (ChatUserTokenRejected)",
        Effect.gen(function* () {
          const user = yield* newUser;
          yield* asUser(user.token)(chat.ListChatChatThreads, {});
          expectOk(yield* call("RevokeAccessTokens", { id: user.id }));
          const denied = yield* asUser(user.token)(chat.ListChatChatThreads, {}).pipe(
            Effect.flip,
            Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 48 }),
          );
          expect(denied._tag).toEqual("ChatUserTokenRejected");
        }).pipe(Effect.provide(azure)),
        live,
      );
    });

    // --- Rooms ---------------------------------------------------------

    describe("CreateRoom", () => {
      test(
        "creates a room",
        Effect.gen(function* () {
          const body = yield* call("CreateRoom", { pstnDialOutEnabled: true });
          expectOk(body);
          const url = yield* endpoint;
          const room = yield* rooms
            .GetRoom({ endpoint: url, roomId: body.result.id })
            .pipe(settled("RoomNotFound"));
          expect(room.pstnDialOutEnabled).toEqual(true);
        }),
      );
    });

    describe("GetRoom", () => {
      test(
        "reads a room",
        Effect.gen(function* () {
          const url = yield* endpoint;
          const room = yield* rooms.CreateRoom({ endpoint: url });
          const body = yield* call("GetRoom", { roomId: room.id });
          expectOk(body);
          expect(body.result).toEqual({
            id: room.id,
            createdAt: room.createdAt,
            validFrom: room.validFrom,
            validUntil: room.validUntil,
            pstnDialOutEnabled: false,
          });
        }),
      );
    });

    describe("UpdateRoom", () => {
      test(
        "changes a room's settings",
        Effect.gen(function* () {
          const url = yield* endpoint;
          const room = yield* rooms.CreateRoom({ endpoint: url });
          const body = yield* call("UpdateRoom", { roomId: room.id, pstnDialOutEnabled: true });
          expectOk(body);
          const observed = yield* rooms.GetRoom({ endpoint: url, roomId: room.id });
          expect(observed.pstnDialOutEnabled).toEqual(true);
        }),
      );
    });

    describe("DeleteRoom", () => {
      test(
        "deletes a room",
        Effect.gen(function* () {
          const url = yield* endpoint;
          const room = yield* rooms.CreateRoom({ endpoint: url });
          const body = yield* call("DeleteRoom", { roomId: room.id });
          expectOk(body);
          const missing = yield* rooms
            .GetRoom({ endpoint: url, roomId: room.id })
            .pipe(Effect.flip);
          expect(missing._tag).toEqual("RoomNotFound");
        }),
      );
    });

    describe("ListRooms", () => {
      test(
        "lists the service's rooms",
        Effect.gen(function* () {
          const url = yield* endpoint;
          const room = yield* rooms.CreateRoom({ endpoint: url });
          const body = yield* call("ListRooms");
          expectOk(body);
          const ids = (body.result.value as rooms.RoomModel[]).map((r) => r.id);
          expect(ids.includes(room.id)).toBe(true);
        }),
      );
    });

    describe("ListRoomParticipants", () => {
      test(
        "lists a room's participants",
        Effect.gen(function* () {
          const url = yield* endpoint;
          const user = yield* newUser;
          const room = yield* rooms.CreateRoom({
            endpoint: url,
            participants: { [user.id]: { role: "Presenter" } },
          });
          const body = yield* call("ListRoomParticipants", { roomId: room.id });
          expectOk(body);
          expect(body.result.value).toEqual([{ rawId: user.id, role: "Presenter" }]);
        }),
      );
    });

    describe("UpdateRoomParticipants", () => {
      test(
        "adds a participant to a room",
        Effect.gen(function* () {
          const url = yield* endpoint;
          const user = yield* newUser;
          const room = yield* rooms.CreateRoom({ endpoint: url });
          const body = yield* call("UpdateRoomParticipants", {
            roomId: room.id,
            participants: { [user.id]: { role: "Attendee" } },
          });
          expectOk(body);
          const page = yield* rooms.ListParticipants({ endpoint: url, roomId: room.id });
          expect(page.value).toEqual([{ rawId: user.id, role: "Attendee" }]);
        }),
      );
    });

    // --- Chat ----------------------------------------------------------

    describe("CreateChatThread", () => {
      test(
        "creates a thread as the token's user",
        Effect.gen(function* () {
          const user = yield* newUser;
          const body = yield* call("CreateChatThread", {
            userAccessToken: user.token,
            topic: "created",
          });
          expectOk(body);
          const thread = yield* asUser(user.token)(chat.GetChatThreadChatThreadProperties, {
            chatThreadId: body.result.chatThread.id,
          });
          expect(thread.topic).toEqual("created");
          expect(thread.createdByCommunicationIdentifier.communicationUser?.id).toEqual(user.id);
        }),
      );
    });

    describe("GetChatThreadProperties", () => {
      test(
        "reads a thread",
        Effect.gen(function* () {
          const user = yield* newUser;
          const chatThreadId = yield* newThread(user, "get");
          const body = yield* call("GetChatThreadProperties", {
            userAccessToken: user.token,
            chatThreadId,
          });
          expectOk(body);
          expect({ id: body.result.id, topic: body.result.topic }).toEqual({
            id: chatThreadId,
            topic: "get",
          });
        }),
      );
    });

    describe("UpdateChatThreadProperties", () => {
      test(
        "changes a thread's topic",
        Effect.gen(function* () {
          const user = yield* newUser;
          const chatThreadId = yield* newThread(user, "before");
          const body = yield* call("UpdateChatThreadProperties", {
            userAccessToken: user.token,
            chatThreadId,
            topic: "after",
          });
          expectOk(body);
          const thread = yield* asUser(user.token)(chat.GetChatThreadChatThreadProperties, {
            chatThreadId,
          });
          expect(thread.topic).toEqual("after");
        }),
      );
    });

    describe("ListChatThreads", () => {
      test(
        "lists the user's threads",
        Effect.gen(function* () {
          const user = yield* newUser;
          const chatThreadId = yield* newThread(user, "listed");
          // A new thread reaches the user's thread list within seconds.
          const body = yield* call("ListChatThreads", { userAccessToken: user.token }).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (b) => (b.result?.value?.length ?? 0) > 0,
              times: 15,
            }),
          );
          expectOk(body);
          expect((body.result.value as chat.ChatThreadItem[]).map((t) => t.id)).toEqual([
            chatThreadId,
          ]);
        }),
      );
    });

    describe("DeleteChatThread", () => {
      test(
        "deletes a thread",
        Effect.gen(function* () {
          const user = yield* newUser;
          const chatThreadId = yield* newThread(user, "doomed");
          const body = yield* call("DeleteChatThread", {
            userAccessToken: user.token,
            chatThreadId,
          });
          expectOk(body);
          // Chat soft-deletes: the creator still reads the thread, marked deleted.
          const thread = yield* asUser(user.token)(chat.GetChatThreadChatThreadProperties, {
            chatThreadId,
          });
          expect(typeof thread.deletedOn).toEqual("string");
        }),
      );
    });

    describe("SendChatMessage", () => {
      test(
        "sends a message",
        Effect.gen(function* () {
          const user = yield* newUser;
          const chatThreadId = yield* newThread(user, "send");
          const body = yield* call("SendChatMessage", {
            userAccessToken: user.token,
            chatThreadId,
            content: "hello",
          });
          expectOk(body);
          const message = yield* asUser(user.token)(chat.GetChatThreadChatMessage, {
            chatThreadId,
            chatMessageId: body.result.id,
          });
          expect(message.content?.message).toEqual("hello");
        }),
      );
    });

    describe("GetChatMessage", () => {
      test(
        "reads a message",
        Effect.gen(function* () {
          const user = yield* newUser;
          const chatThreadId = yield* newThread(user, "get-message");
          const sent = yield* asUser(user.token)(chat.SendChatThreadChatMessage, {
            chatThreadId,
            content: "read me",
          });
          const body = yield* call("GetChatMessage", {
            userAccessToken: user.token,
            chatThreadId,
            chatMessageId: sent.id,
          });
          expectOk(body);
          expect({ id: body.result.id, message: body.result.content.message }).toEqual({
            id: sent.id,
            message: "read me",
          });
        }),
      );
    });

    describe("ListChatMessages", () => {
      test(
        "lists a thread's messages",
        Effect.gen(function* () {
          const user = yield* newUser;
          const chatThreadId = yield* newThread(user, "list-messages");
          const sent = yield* asUser(user.token)(chat.SendChatThreadChatMessage, {
            chatThreadId,
            content: "listed",
          });
          const body = yield* call("ListChatMessages", {
            userAccessToken: user.token,
            chatThreadId,
          });
          expectOk(body);
          const texts = (body.result.value as chat.ChatMessage[])
            .filter((m) => m.type === "text")
            .map((m) => [m.id, m.content?.message]);
          expect(texts).toEqual([[sent.id, "listed"]]);
        }),
      );
    });

    describe("UpdateChatMessage", () => {
      test(
        "edits a message",
        Effect.gen(function* () {
          const user = yield* newUser;
          const chatThreadId = yield* newThread(user, "edit");
          const sent = yield* asUser(user.token)(chat.SendChatThreadChatMessage, {
            chatThreadId,
            content: "before",
          });
          const body = yield* call("UpdateChatMessage", {
            userAccessToken: user.token,
            chatThreadId,
            chatMessageId: sent.id,
            content: "after",
          });
          expectOk(body);
          const message = yield* asUser(user.token)(chat.GetChatThreadChatMessage, {
            chatThreadId,
            chatMessageId: sent.id,
          });
          expect(message.content?.message).toEqual("after");
          expect(typeof message.editedOn).toEqual("string");
        }),
      );
    });

    describe("DeleteChatMessage", () => {
      test(
        "deletes a message",
        Effect.gen(function* () {
          const user = yield* newUser;
          const chatThreadId = yield* newThread(user, "delete-message");
          const sent = yield* asUser(user.token)(chat.SendChatThreadChatMessage, {
            chatThreadId,
            content: "doomed",
          });
          const body = yield* call("DeleteChatMessage", {
            userAccessToken: user.token,
            chatThreadId,
            chatMessageId: sent.id,
          });
          expectOk(body);
          const message = yield* asUser(user.token)(chat.GetChatThreadChatMessage, {
            chatThreadId,
            chatMessageId: sent.id,
          });
          expect(typeof message.deletedOn).toEqual("string");
        }),
      );
    });

    describe("AddChatParticipants", () => {
      test(
        "adds a participant",
        Effect.gen(function* () {
          const user = yield* newUser;
          const other = yield* newUser;
          const chatThreadId = yield* newThread(user, "add");
          const body = yield* call("AddChatParticipants", {
            userAccessToken: user.token,
            chatThreadId,
            participants: [{ communicationIdentifier: { communicationUser: { id: other.id } } }],
          });
          expectOk(body);
          const page = yield* asUser(user.token)(chat.ListChatThreadChatParticipants, {
            chatThreadId,
          });
          expect(participantIds(page)).toEqual([user.id, other.id].sort());
        }),
      );
    });

    describe("RemoveChatParticipant", () => {
      test(
        "removes a participant",
        Effect.gen(function* () {
          const user = yield* newUser;
          const other = yield* newUser;
          const chatThreadId = yield* newThread(user, "remove", [other.id]);
          const body = yield* call("RemoveChatParticipant", {
            userAccessToken: user.token,
            chatThreadId,
            communicationUser: { id: other.id },
          });
          expectOk(body);
          const page = yield* asUser(user.token)(chat.ListChatThreadChatParticipants, {
            chatThreadId,
          });
          expect(participantIds(page)).toEqual([user.id]);
        }),
      );
    });

    describe("ListChatParticipants", () => {
      test(
        "lists a thread's participants",
        Effect.gen(function* () {
          const user = yield* newUser;
          const other = yield* newUser;
          const chatThreadId = yield* newThread(user, "participants", [other.id]);
          const body = yield* call("ListChatParticipants", {
            userAccessToken: user.token,
            chatThreadId,
          });
          expectOk(body);
          expect(participantIds(body.result)).toEqual([user.id, other.id].sort());
        }),
      );
    });

    describe("SendChatReadReceipt", () => {
      test(
        "marks a message read",
        Effect.gen(function* () {
          const user = yield* newUser;
          const other = yield* newUser;
          const chatThreadId = yield* newThread(user, "receipt", [other.id]);
          const sent = yield* asUser(user.token)(chat.SendChatThreadChatMessage, {
            chatThreadId,
            content: "read it",
          });
          const body = yield* call("SendChatReadReceipt", {
            userAccessToken: other.token,
            chatThreadId,
            chatMessageId: sent.id,
          });
          expectOk(body);
          const receipts = yield* asUser(user.token)(chat.ChatThreadListChatReadReceipts, {
            chatThreadId,
          }).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (page) => page.value.length > 0,
              times: 10,
            }),
          );
          expect(
            receipts.value.map((r) => [
              r.chatMessageId,
              r.senderCommunicationIdentifier.communicationUser?.id,
            ]),
          ).toEqual([[sent.id, other.id]]);
        }),
      );
    });

    describe("ListChatReadReceipts", () => {
      test(
        "lists a thread's read receipts",
        Effect.gen(function* () {
          const user = yield* newUser;
          const other = yield* newUser;
          const chatThreadId = yield* newThread(user, "receipts", [other.id]);
          const sent = yield* asUser(user.token)(chat.SendChatThreadChatMessage, {
            chatThreadId,
            content: "read it",
          });
          yield* asUser(other.token)(chat.ChatThreadSendChatReadReceipt, {
            chatThreadId,
            chatMessageId: sent.id,
          });
          const body = yield* call("ListChatReadReceipts", {
            userAccessToken: user.token,
            chatThreadId,
          }).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (b) => (b.result?.value?.length ?? 0) > 0,
              times: 10,
            }),
          );
          expectOk(body);
          expect(
            (body.result.value as chat.ChatMessageReadReceipt[]).map((r) => r.chatMessageId),
          ).toEqual([sent.id]);
        }),
      );
    });

    describe("SendChatTypingNotification", () => {
      test(
        "sends a typing notification (an event, with no state to read back)",
        Effect.gen(function* () {
          const user = yield* newUser;
          const chatThreadId = yield* newThread(user, "typing");
          const body = yield* call("SendChatTypingNotification", {
            userAccessToken: user.token,
            chatThreadId,
          });
          expectOk(body);
          // A user outside the thread is refused: the call reaches the thread.
          const stranger = yield* newUser;
          const refused = yield* probe(
            "SendChatTypingNotification",
            { userAccessToken: stranger.token, chatThreadId },
            "ChatThreadAccessDenied",
          );
          expect(refused.ok).toEqual(false);
          expect(refused.error).toContain("ChatThreadAccessDenied");
        }),
      );
    });

    // --- SMS (needs a phone number the service owns) -------------------

    describe("SMS without a phone number", () => {
      test(
        "SendSms from a number the service does not own fails with a typed error",
        Effect.gen(function* () {
          const body = yield* probe(
            "SendSms",
            { from: "+18005550100", smsRecipients: [{ to: "+14255550123" }], message: "probe" },
            "SmsSenderNotAuthorized",
          );
          expect(body.ok).toEqual(false);
          expect(body.error).toContain("SmsSenderNotAuthorized");
        }),
      );
    });

    // ~$2/month toll-free number (needs a verified business) in
    // AZURE_TEST_SMS_FROM, a phone that receives SMS in AZURE_TEST_SMS_TO; 1 min.
    describe.skipIf(!runPaidOnly || !process.env.AZURE_TEST_SMS_FROM)("SMS", () => {
      const from = process.env.AZURE_TEST_SMS_FROM ?? "";
      const to = process.env.AZURE_TEST_SMS_TO ?? "";
      const recipients = [{ to }];
      test(
        "SendSms, GetSmsDeliveryReport, AddSmsOptOut, CheckSmsOptOut, RemoveSmsOptOut",
        Effect.gen(function* () {
          const sent = yield* call("SendSms", {
            from,
            smsRecipients: recipients,
            message: "alchemy SendSms binding",
            smsSendOptions: { enableDeliveryReport: true },
          });
          expectOk(sent);
          expect(sent.result.value[0].successful).toEqual(true);
          const report = yield* call("GetSmsDeliveryReport", {
            outgoingMessageId: sent.result.value[0].messageId,
          });
          expectOk(report);
          expect(report.result.messageId).toEqual(sent.result.value[0].messageId);
          expectOk(yield* call("AddSmsOptOut", { from, recipients }));
          const checked = yield* call("CheckSmsOptOut", { from, recipients });
          expect(checked.result.value[0].isOptedOut).toEqual(true);
          expectOk(yield* call("RemoveSmsOptOut", { from, recipients }));
          const rechecked = yield* call("CheckSmsOptOut", { from, recipients });
          expect(rechecked.result.value[0].isOptedOut).toEqual(false);
        }),
      );
    });

    // --- Teams interoperability (needs a Teams tenant) -----------------

    describe("Teams bindings without a Teams tenant", () => {
      test(
        "ExchangeTeamsUserAccessToken rejects a token that is not a Teams user token",
        Effect.gen(function* () {
          const body = yield* probe(
            "ExchangeTeamsUserAccessToken",
            {
              token: "not-a-token",
              appId: "00000000-0000-0000-0000-000000000000",
              userId: "00000000-0000-0000-0000-000000000000",
            },
            "TeamsAccessTokenInvalid",
          );
          expect(body.ok).toEqual(false);
          expect(body.error).toContain("TeamsAccessTokenInvalid");
        }),
      );
    });

    // Teams Phone extensibility assignments need no Teams tenant: the
    // resource stores any tenant and object ID.
    const TENANT = "6f1d1c4a-8a7e-4c2b-9a59-2d3c1b0e7f11";
    const CLIENT = "0b8f4e2d-3c6a-4f1e-8d7b-5a9c2e1f3d41";
    const CLIENT2 = "0b8f4e2d-3c6a-4f1e-8d7b-5a9c2e1f3d42";
    const teamsAssignment = (objectId: string) =>
      Effect.gen(function* () {
        const url = yield* endpoint;
        const where = { endpoint: url, tenantId: TENANT, objectId };
        return {
          where: { tenantId: TENANT, objectId },
          upsert: identity.UpsertTeamsExtensionOperationAssignment({
            ...where,
            principalType: "user",
            clientIds: [CLIENT],
          }),
          get: identity.GetTeamsExtensionOperationAssignment(where),
          remove: identity.DeleteTeamsExtensionOperationAssignment(where),
        };
      });

    describe("UpsertTeamsExtensionAssignment", () => {
      test(
        "creates an assignment",
        Effect.gen(function* () {
          const a = yield* teamsAssignment("0b8f4e2d-3c6a-4f1e-8d7b-5a9c2e1f3d50");
          yield* a.remove;
          const body = yield* call("UpsertTeamsExtensionAssignment", {
            ...a.where,
            principalType: "user",
            clientIds: [CLIENT, CLIENT2],
          });
          expectOk(body);
          const observed = yield* a.get;
          expect({ type: observed.principalType, clientIds: observed.clientIds }).toEqual({
            type: "user",
            clientIds: [CLIENT, CLIENT2],
          });
          yield* a.remove;
        }),
      );
    });

    describe("GetTeamsExtensionAssignment", () => {
      test(
        "reads an assignment",
        Effect.gen(function* () {
          const a = yield* teamsAssignment("0b8f4e2d-3c6a-4f1e-8d7b-5a9c2e1f3d51");
          yield* a.upsert;
          const body = yield* call("GetTeamsExtensionAssignment", a.where);
          expectOk(body);
          expect(body.result).toEqual({
            objectId: a.where.objectId,
            tenantId: TENANT,
            principalType: "user",
            clientIds: [CLIENT],
          });
          yield* a.remove;
        }),
      );
    });

    describe("DeleteTeamsExtensionAssignment", () => {
      test(
        "removes an assignment",
        Effect.gen(function* () {
          const a = yield* teamsAssignment("0b8f4e2d-3c6a-4f1e-8d7b-5a9c2e1f3d52");
          yield* a.upsert;
          const body = yield* call("DeleteTeamsExtensionAssignment", a.where);
          expectOk(body);
          const missing = yield* a.get.pipe(Effect.flip);
          expect(missing._tag).toEqual("TeamsExtensionAssignmentNotFound");
        }),
      );
    });

    // --- Least privilege -----------------------------------------------

    describe("least privilege", () => {
      test(
        "assigns two custom roles, scoped to the communication service: Read+Write and Write",
        Effect.gen(function* () {
          const out = yield* stack;
          const { grants } = yield* grantsOf(out.principalId!);
          const scope = out.communicationServiceId.toLowerCase();
          const R = "Microsoft.Communication/CommunicationServices/Read";
          const W = "Microsoft.Communication/CommunicationServices/Write";
          // Email, SMS, and Rooms share Read+Write; Identity has Write only;
          // Chat assigns nothing (it authorizes with user tokens).
          expect(grants.filter((g) => g.startsWith(`${scope} `))).toEqual(
            [`${scope} ${R},${W}`, `${scope} ${W}`].sort(),
          );
        }),
        { timeout: 120_000 },
      );
    });
  },
);

/** `<scope> <sorted actions>` for every role on the Function's identity. */
const grantsOf = (principalId: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const page = yield* authorization.ListRoleAssignmentForSubscription({
      subscriptionId,
      _filter: `principalId eq '${principalId}'`,
    });
    const grants: string[] = [];
    const customRoles: string[] = [];
    for (const assignment of page.value) {
      const scope = assignment.properties?.scope?.toLowerCase() ?? "";
      const roleDefinitionId = assignment.properties?.roleDefinitionId?.split("/").pop() ?? "";
      const role = yield* authorization.GetRoleDefinition({
        scope: `/subscriptions/${subscriptionId}`,
        roleDefinitionId,
      });
      if (role.properties?.type === "CustomRole") customRoles.push(roleDefinitionId);
      const actions = (role.properties?.permissions ?? []).flatMap((p) => p.actions ?? []);
      grants.push(`${scope} ${[...actions].sort().join(",")}`);
    }
    return { grants: grants.sort(), customRoles };
  });

// Destroy, then prove every role on the Function's identity and every
// custom role the bindings created is gone.
afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    // `stack` is undefined when the deploy failed; destroy what it left anyway.
    const outputs = yield* stack;
    if (outputs === undefined) return yield* destroy(Stack);
    const principals = [outputs.principalId!];
    for (const principalId of principals) expect(principalId).toMatch(/^[0-9a-f-]{36}$/);
    const { customRoles } = yield* grantsOf(outputs.principalId!);
    yield* destroy(Stack);
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    for (const principalId of principals) {
      const remaining = yield* authorization
        .ListRoleAssignmentForSubscription({
          subscriptionId,
          _filter: `principalId eq '${principalId}'`,
        })
        .pipe(
          Effect.map((page) => page.value.length),
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (n) => n === 0,
            times: 12,
          }),
        );
      expect({ principalId, remaining }).toEqual({ principalId, remaining: 0 });
    }
    // Identities, rooms, chat threads, and Teams assignments live in the
    // communication service: deleting it deletes them.
    expect(
      yield* waitGone(
        communication.GetCommunicationService({
          subscriptionId,
          resourceGroupName: outputs.resourceGroup,
          communicationServiceName: outputs.communicationServiceName,
        }),
      ),
    ).toEqual("gone");
    for (const roleDefinitionId of new Set(customRoles)) {
      const gone = yield* authorization
        .GetRoleDefinition({ scope: `/subscriptions/${subscriptionId}`, roleDefinitionId })
        .pipe(
          Effect.as("found" as const),
          Effect.catchTag("RoleDefinitionNotFound", () => Effect.succeed("gone" as const)),
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (status) => status === "gone",
            times: 12,
          }),
        );
      expect({ roleDefinitionId, gone }).toEqual({ roleDefinitionId, gone: "gone" });
    }
  }).pipe(Effect.provide(azure)),
  { timeout: 900_000 },
);
