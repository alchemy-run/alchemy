import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import PiApi from "./fixtures/Api.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const Stack = Alchemy.Stack(
  "PiCloudflareStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const api = yield* PiApi;
    return { url: api.url.as<string>() };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const tags = ["provider:cloudflare", "provider:pi", "live"];

/** Call the fixture's API; retries ride through a fresh workers.dev URL's first seconds. */
const call = (path: string, body?: unknown) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    const request =
      body === undefined
        ? HttpClientRequest.get(`${url}${path}`)
        : HttpClientRequest.post(`${url}${path}`).pipe(HttpClientRequest.bodyJsonUnsafe(body));
    const response = yield* client
      .execute(request)
      .pipe(Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 8 }));
    return (yield* response.json) as any;
  });

type Message = {
  role: string;
  toolName?: string;
  content: ReadonlyArray<{ type: string; text?: string; name?: string }> | string;
};

const textOf = (message: Message) =>
  typeof message.content === "string"
    ? message.content
    : message.content.map((part) => part.text ?? "").join("");

test(
  "a named conversation runs a tagged tool through Workers AI and keeps its transcript",
  Effect.gen(function* () {
    const user = `user-${Date.now()}`;
    const created = yield* call(`/${user}/math/create`, { tools: ["add"] });
    // Creating again by name returns the same conversation.
    const again = yield* call(`/${user}/math/create`, { tools: ["add"] });
    expect(again.id).toBe(created.id);

    const result = yield* call(`/${user}/math/prompt`, {
      text: "What is 2 + 3? Call the add tool, then reply with its sum.",
      requestId: "math-1",
    });
    expect(result.status).toBe("done");

    const messages = (yield* call(`/${user}/math/transcript`)) as ReadonlyArray<Message>;
    const toolResult = messages.find((message) => message.role === "toolResult");
    expect(toolResult?.toolName).toBe("add");
    expect(textOf(toolResult!)).toContain("1005");
    // The run ended with an answer after the tool result.
    const answer = messages.filter((message) => message.role === "assistant").at(-1)!;
    expect(textOf(answer).length).toBeGreaterThan(0);

    // The same requestId is the same submission: nothing runs twice.
    const retried = yield* call(`/${user}/math/prompt`, {
      text: "What is 2 + 3? Call the add tool, then reply with its sum.",
      requestId: "math-1",
    });
    expect(retried.submission).toBe(result.submission);

    expect((yield* call(`/${user}/math/list`)).math).toBe(created.id);
  }),
  { tags, timeout: 180_000 },
);

test(
  "an inline tool closes over the Durable Object's KV binding",
  Effect.gen(function* () {
    const user = `user-${Date.now()}`;
    yield* call(`/${user}/notes/create`, { tools: ["save_note"] });
    const result = yield* call(`/${user}/notes/prompt`, {
      text: 'Remember that my favorite color is teal: save it with key "pi-color".',
      requestId: "note-1",
    });
    expect(result.status).toBe("done");
    const note = yield* call(`/notes/pi-color/note`);
    expect(String(note.text).toLowerCase()).toContain("teal");
  }),
  { tags, timeout: 180_000 },
);

test(
  "tools are enabled and disabled per conversation at runtime",
  Effect.gen(function* () {
    const user = `user-${Date.now()}`;
    yield* call(`/${user}/both/create`, { tools: ["add", "save_note"] });
    expect([...(yield* call(`/${user}/both/tools`))].sort()).toEqual(["add", "save_note"]);

    yield* call(`/${user}/both/disable`, { tool: "add" });
    expect(yield* call(`/${user}/both/tools`)).toEqual(["save_note"]);

    yield* call(`/${user}/both/enable`, { tool: "add" });
    expect([...(yield* call(`/${user}/both/tools`))].sort()).toEqual(["add", "save_note"]);
  }),
  { tags, timeout: 180_000 },
);
