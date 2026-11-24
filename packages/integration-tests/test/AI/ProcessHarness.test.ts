import * as AI from "@alchemy.run/ai";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Chat, ChatLive, follow } from "./fixtures/chat/Client.ts";
import ProcessApi from "./fixtures/ProcessApi.ts";

const providers = Cloudflare.providers();

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers });

const Stack = Alchemy.Stack(
  "ProcessHarnessStack",
  { providers, state: Cloudflare.state() },
  Effect.gen(function* () {
    const api = yield* ProcessApi;
    return { url: api.url.as<string>() };
  }),
);

const stack = beforeAll(deploy(Stack), { timeout: 300_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

/** Call one action of a session, retrying while the fresh Worker starts serving. */
const call = Effect.fn(function* (
  path: string,
  body: { readonly text?: string; readonly requestId?: string } = {},
) {
  const { url } = yield* stack;
  const client = yield* HttpClient.HttpClient;
  const response = yield* HttpClient.filterStatusOk(client)
    .execute(HttpClientRequest.post(`${url}/${path}`).pipe(HttpClientRequest.bodyJsonUnsafe(body)))
    .pipe(
      Effect.tapError((error) =>
        error.response === undefined
          ? Effect.void
          : Effect.flatMap(error.response.text, (text) => Effect.logError(text)),
      ),
      Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 6 }),
    );
  return (yield* response.json) as {
    readonly text?: string;
    readonly messages?: string;
  };
});

/** The same processes, on each harness: nothing but the host's Layers differs. */
for (const harness of ["pi", "opencode"] as const) {
  describe(
    `processes on ${harness}`,
    { tags: ["provider:cloudflare", `provider:${harness}`, "live"] },
    () => {
      test(
        "a session works on what it is sent",
        Effect.gen(function* () {
          yield* call(`${harness}/Adder/total-1/send`, {
            text: "Add 2 and 3.",
            requestId: "first",
          });
          yield* call(`${harness}/Adder/total-1/wait`);
          const { messages } = yield* call(`${harness}/Adder/total-1/messages`);

          // The tool is off by a thousand: 1005 can only have come from it.
          expect(messages).toContain("1005");
        }),
        { timeout: 180_000 },
      );

      test(
        "a message sent twice under one request id is run once",
        Effect.gen(function* () {
          yield* call(`${harness}/Adder/total-2/send`, {
            text: "Add 10 and 20.",
            requestId: "first",
          });
          yield* call(`${harness}/Adder/total-2/send`, {
            text: "Add 500 and 500.",
            requestId: "first",
          });
          yield* call(`${harness}/Adder/total-2/wait`);
          const { messages } = yield* call(`${harness}/Adder/total-2/messages`);

          expect(messages).toContain("1030");
          // The transcript holds timestamps, so look for the message, not its sum.
          expect(messages).not.toContain("Add 500 and 500.");
        }),
        { timeout: 180_000 },
      );

      test(
        "a session answers later messages",
        Effect.gen(function* () {
          yield* call(`${harness}/Adder/total-3/send`, {
            text: "Add 1 and 1.",
            requestId: "first",
          });
          yield* call(`${harness}/Adder/total-3/wait`);
          const reply = yield* call(`${harness}/Adder/total-3/prompt`, {
            text: "Now call the tool once more to add 7 to the number it returned. Reply with exactly what it returns.",
            requestId: "again",
          });

          // 1 + 1 + 1000, then + 7 + 1000.
          expect(reply.text).toContain("2009");
        }),
        { timeout: 180_000 },
      );

      test(
        "a message sent without waiting is answered",
        Effect.gen(function* () {
          yield* call(`${harness}/Adder/total-4/send`, {
            text: "Add 5 and 5.",
            requestId: "first",
          });
          yield* call(`${harness}/Adder/total-4/wait`);
          // `send` returns once the message is stored; the session answers on its own.
          yield* call(`${harness}/Adder/total-4/send`, {
            text: "Now call the tool once more to add 7 to the number it returned. Reply with exactly what it returns.",
            requestId: "more",
          });
          const { messages } = yield* call(`${harness}/Adder/total-4/messages`).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (answer) => answer.messages?.includes("2017") === true,
              times: 20,
            }),
          );

          // 5 + 5 + 1000, then + 7 + 1000.
          expect(messages).toContain("2017");
        }),
        { timeout: 180_000 },
      );

      test(
        "a session follows a process it mentions",
        Effect.gen(function* () {
          const reply = yield* call(`${harness}/Operator/desk-1/prompt`, {
            text: "What is the release codeword?",
          });

          expect(reply.text).toContain("PLUM-4417");
        }),
        { timeout: 180_000 },
      );

      test(
        "a session starts a process it mentions, as a session of its own",
        Effect.gen(function* () {
          yield* call(`${harness}/Operator/desk-2/prompt`, {
            text: "Add 40 and 2, in a session named child-1.",
          });
          // The Adder session has its own key and its own conversation.
          yield* call(`${harness}/Adder/child-1/wait`);
          const { messages } = yield* call(`${harness}/Adder/child-1/messages`).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("3 seconds"),
              until: (answer) => answer.messages?.includes("1042") === true,
              times: 20,
            }),
          );

          expect(messages).toContain("1042");
        }),
        { timeout: 240_000 },
      );

      test(
        "a session reports its status and its transcript in order",
        Effect.gen(function* () {
          yield* call(`${harness}/Adder/total-5/prompt`, { text: "Add 7 and 8." });
          yield* call(`${harness}/Adder/total-5/wait`);

          const status = yield* call(`${harness}/Adder/total-5/status`);
          expect(JSON.parse(status.messages!)).toEqual({
            type: "status",
            status: "idle",
            queued: [],
          });

          const { messages } = yield* call(`${harness}/Adder/total-5/messages`);
          const entries = JSON.parse(messages!) as ReadonlyArray<AI.SessionEntry>;
          const items = entries.map((entry) => entry.item);
          expect(items[0]).toEqual({ type: "user", text: "Add 7 and 8." });
          const calls = items.flatMap((item) => (item.type === "assistant" ? item.toolCalls : []));
          expect(calls.some((each) => each.name.includes("add"))).toBe(true);
          const results = items.flatMap((item) => (item.type === "tool" ? [item] : []));
          expect(results.some((each) => each.output.includes("1015") && !each.isError)).toBe(true);
          expect(calls.map((each) => each.id)).toContain(results[0]!.callId);
          // Items are numbered in the order they were stored.
          const seqs = entries.map((entry) => entry.seq);
          expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
        }),
        { timeout: 180_000 },
      );

      test(
        "a steered message reaches the session",
        Effect.gen(function* () {
          yield* call(`${harness}/Adder/total-6/send`, { text: "Add 20 and 22.", requestId: "a" });
          yield* call(`${harness}/Adder/total-6/steer`, {
            text: "Also say the word PERSIMMON in your answer.",
            requestId: "b",
          });
          yield* call(`${harness}/Adder/total-6/wait`);

          const { messages } = yield* call(`${harness}/Adder/total-6/messages`).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("3 seconds"),
              until: (answer) => answer.messages?.includes("PERSIMMON") === true,
              times: 20,
            }),
          );
          const users = (JSON.parse(messages!) as ReadonlyArray<AI.SessionEntry>).flatMap((entry) =>
            entry.item.type === "user" ? [entry.item.text] : [],
          );
          expect(users).toEqual(["Add 20 and 22.", "Also say the word PERSIMMON in your answer."]);
        }),
        { timeout: 240_000 },
      );

      test(
        "a client follows a session over a WebSocket",
        Effect.gen(function* () {
          const { url } = yield* stack;
          const live = ChatLive(`${url.replace(/^http/, "ws")}/${harness}/live/socket-3`);

          const events = yield* Effect.gen(function* () {
            const session = yield* Chat;
            // Reading first: the session is idle, and has nothing yet.
            let worked = false;
            const first = yield* Deferred.make<void>();
            const reading = yield* follow().pipe(
              Stream.tap(() => Deferred.succeed(first, undefined)),
              // Idle again, after working: its answer is stored. A session kept from
              // an earlier run (NO_DESTROY) never works again: its stored answer ends the read.
              Stream.takeUntil((event) => {
                if (event.type === "item") {
                  return (
                    !worked && event.item.type === "assistant" && event.item.toolCalls.length === 0
                  );
                }
                if (event.status === "working") worked = true;
                return worked && event.status === "idle" && event.queued.length === 0;
              }),
              Stream.runCollect,
              Effect.forkChild,
            );
            yield* Deferred.await(first);
            yield* session.send({ text: "Add 7 and 8.", requestId: "first" });
            return Array.from(yield* Fiber.join(reading));
          }).pipe(
            Effect.provide(live),
            Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 6 }),
          );

          expect(events[0]).toEqual({ type: "status", status: "idle", queued: [] });
          const items = events.flatMap((event) => (event.type === "item" ? [event] : []));
          expect(items[0]?.item).toEqual({ type: "user", text: "Add 7 and 8." });
          expect(items.map((event) => event.seq)).toEqual(
            [...items.map((event) => event.seq)].sort((a, b) => a - b),
          );
          // The tool is off by a thousand: 1015 can only have come from it.
          expect(JSON.stringify(items)).toContain("1015");

          // Read again from the last item: only the status, nothing repeated.
          const last = items.at(-1)!.seq;
          const again = yield* Effect.gen(function* () {
            const session = yield* Chat;
            const page = yield* session.history({ take: 1, order: "desc" });
            const first = yield* Stream.runHead(session.events({ after: last }));
            return { page, first: Option.getOrUndefined(first) };
          }).pipe(Effect.provide(live));
          expect(again.page.items[0]?.seq).toBe(last);
          expect(again.first).toEqual({ type: "status", status: "idle", queued: [] });
        }),
        { timeout: 240_000 },
      );

      test(
        "a reader that waited while its session was idle sees the next message",
        Effect.gen(function* () {
          const { url } = yield* stack;
          const live = ChatLive(`${url.replace(/^http/, "ws")}/${harness}/live/socket-idle`);

          const items = yield* Effect.gen(function* () {
            const first = yield* Deferred.make<void>();
            const reading = yield* follow().pipe(
              Stream.tap(() => Deferred.succeed(first, undefined)),
              Stream.filter((event) => event.type === "item"),
              Stream.takeUntil(
                (event) => event.item.type === "assistant" && event.item.toolCalls.length === 0,
              ),
              Stream.runCollect,
              Effect.forkChild,
            );
            yield* Deferred.await(first);
            // Long enough for an idle object to be put to sleep with the socket open.
            yield* Effect.sleep("30 seconds");
            // Sent by the Worker, as a policy would, not over the reader's socket.
            yield* call(`${harness}/tell/socket-idle`, { text: "Add 4 and 5.", requestId: "a" });
            return Array.from(yield* Fiber.join(reading));
          }).pipe(Effect.provide(live));

          expect(items[0]?.item).toEqual({ type: "user", text: "Add 4 and 5." });
          expect(items.map((event) => event.seq)).toEqual(
            [...new Set(items.map((event) => event.seq))].sort((a, b) => a - b),
          );
          expect(JSON.stringify(items)).toContain("1009");
        }),
        { timeout: 240_000 },
      );

      test(
        "an interrupted session is idle and keeps its transcript",
        Effect.gen(function* () {
          yield* call(`${harness}/Adder/total-7/send`, { text: "Add 1 and 2.", requestId: "a" });
          yield* call(`${harness}/Adder/total-7/interrupt`);
          yield* call(`${harness}/Adder/total-7/wait`);

          const status = yield* call(`${harness}/Adder/total-7/status`);
          expect(JSON.parse(status.messages!).status).toBe("idle");
          const { messages } = yield* call(`${harness}/Adder/total-7/messages`);
          expect(messages).toContain("Add 1 and 2.");
        }),
        { timeout: 180_000 },
      );
    },
  );
}
