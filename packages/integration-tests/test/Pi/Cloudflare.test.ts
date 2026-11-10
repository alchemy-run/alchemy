import * as Cloudflare from "@alchemy.run/cloudflare";
import * as E2B from "@alchemy.run/e2b";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import PiApi from "./fixtures/Api.ts";

const providers = Layer.mergeAll(Cloudflare.providers(), E2B.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers });

const Stack = Alchemy.Stack(
  "PiCloudflareStack",
  { providers, state: Cloudflare.state() },
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

test(
  "a run cut off by a crashed instance resumes from the wake alarm",
  Effect.gen(function* () {
    const user = `user-${Date.now()}`;
    yield* call(`/${user}/crash/create`, { tools: ["add"] });
    yield* call(`/${user}/crash/start`, {
      text: "What is 40 + 2? Call the add tool, then reply with its sum.",
      requestId: "crash-1",
    });
    // The crash call itself fails when the instance dies under it.
    yield* call(`/${user}/crash/crash`, {}).pipe(Effect.ignore);
    const { answered } = yield* call(`/${user}/crash/answered`).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("3 seconds"),
        until: (result: { answered: boolean }) => result.answered,
        times: 30,
      }),
    );
    expect(answered).toBe(true);
  }),
  { tags, timeout: 180_000 },
);

test(
  "coding tools run in an E2B sandbox through Pi's own daemon",
  Effect.gen(function* () {
    const name = `sbx-${Date.now()}`;
    yield* call(`/sandbox/${name}/create`, {});
    const status = yield* call(`/sandbox/${name}/prompt`, {
      text: 'Use the write tool to create /home/user/hello.txt containing exactly the text "pi was here". Then use bash to run: wc -c /home/user/hello.txt',
      requestId: "sbx-1",
    }).pipe(Effect.ensuring(Effect.void));
    const tools = (yield* call(`/sandbox/${name}/tools`)) as ReadonlyArray<{
      tool: string;
      isError: boolean;
    }>;
    const file = yield* call(`/sandbox/${name}/file`, { path: "/home/user/hello.txt" });
    yield* call(`/sandbox/${name}/kill`, {});
    expect(status.status).toBe("done");
    expect(tools.some((used) => used.tool === "write" && !used.isError)).toBe(true);
    expect(tools.some((used) => used.tool === "bash" && !used.isError)).toBe(true);
    expect(file.text).toContain("pi was here");
  }),
  { tags: [...tags, "provider:e2b"], timeout: 300_000 },
);

test(
  "an extension's hook blocks a tool call and its section reaches the model",
  Effect.gen(function* () {
    const user = `user-${Date.now()}`;
    const { id } = yield* call(`/${user}/guarded/create`, { tools: ["save_note"] });
    yield* call(`/${user}/guarded/prompt`, {
      text: 'Save the note "hunter2" under the key "secret".',
      requestId: "guard-1",
    });
    const results = (yield* call(`/${user}/guarded/results`)) as ReadonlyArray<{
      tool: string;
      isError: boolean;
      text: string;
    }>;
    const blocked = results.find((result) => result.tool === "save_note");
    expect(blocked?.isError).toBe(true);
    expect(blocked?.text).toContain("not allowed");
    expect((yield* call(`/notes/secret/note`)).text).toBeNull();

    yield* call(`/${user}/guarded/prompt`, {
      text: "What is the magic word for this conversation? Reply with only the word.",
      requestId: "guard-2",
    });
    const messages = (yield* call(`/${user}/guarded/transcript`)) as ReadonlyArray<Message>;
    expect(textOf(messages.filter((message) => message.role === "assistant").at(-1)!)).toContain(
      `XYZZY-${id}`,
    );
  }),
  { tags, timeout: 180_000 },
);

test(
  "a skill added at runtime is loaded on demand",
  Effect.gen(function* () {
    const user = `user-${Date.now()}`;
    yield* call(`/${user}/skilled/create`, { tools: [] });
    yield* call(`/${user}/skilled/skill`, {});
    yield* call(`/${user}/skilled/prompt`, {
      text: "Please greet me. Load the greeting skill first.",
      requestId: "skill-1",
    });
    const results = (yield* call(`/${user}/skilled/results`)) as ReadonlyArray<{
      tool: string;
      isError: boolean;
      text: string;
    }>;
    const loaded = results.find((result) => result.tool === "load_skill");
    expect(loaded?.isError).toBe(false);
    expect(loaded?.text).toContain("HELLO-FROM-SKILL");
  }),
  { tags, timeout: 180_000 },
);
