/**
 * `alchemy dev` end to end: spawns the real CLI and drives both agents over
 * HTTP. The Worker and its Durable Objects run in local workerd; the model
 * is Workers AI and the coding agent's sandboxes are real ones on E2B,
 * Daytona, Modal, Boat and Archil, so the run needs a profile with credentials for
 * Cloudflare and each of them (`ALCHEMY_PROFILE`).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import * as path from "node:path";
import { DevCli, fetchOk, pollUntil } from "@alchemy.run/test/DevCli";

const root = path.resolve(import.meta.dirname, "..");
const cli = new DevCli({ root, stage: "dev-cli-test" });

// Durable Object and conversation names, new on every run.
const run = Date.now().toString(36);
const user = `user-${run}`;
const workspace = `workspace-${run}`;

/** The sandbox platforms a workspace runs on. */
const platforms = ["e2b", "daytona", "modal", "boat", "archil"] as const;

let url = "";

type Message = {
  readonly role: "user" | "assistant" | "toolResult";
  readonly tool?: string;
  readonly isError?: boolean;
  readonly text: string;
};

const call = async <A>(route: string, body?: unknown): Promise<A> => {
  const response = await fetch(`${url}${route}`, {
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
    signal: AbortSignal.timeout(150_000),
  });
  if (!response.ok) {
    throw new Error(
      `${route} returned ${response.status}: ${await response.text()}\n${cli.outputTail}`,
    );
  }
  return (await response.json()) as A;
};

const chat = <A>(conversation: string, action: string, body?: unknown) =>
  call<A>(`/chat/${user}/${conversation}/${action}`, body);

const create = async (conversation: string, tools: ReadonlyArray<string>) =>
  (await chat<{ id: number }>(conversation, "create", { tools })).id;

/** Send an input, wait for the run to finish, and return what the model now sees. */
const prompt = async (conversation: string, text: string) => {
  const settled = await chat<{ status: string; submission: number }>(conversation, "prompt", {
    text,
    requestId: `${conversation}-${text}`,
  });
  expect(settled.status).toBe("done");
  return await chat<ReadonlyArray<Message>>(conversation, "messages");
};

const toolResults = (messages: ReadonlyArray<Message>, tool: string) =>
  messages.filter((message) => message.role === "toolResult" && message.tool === tool);

const answer = (messages: ReadonlyArray<Message>) =>
  messages.findLast((message) => message.role === "assistant")?.text ?? "";

beforeAll(async () => {
  cli.destroy();
  cli.start();
  // The first deploy builds each platform's sandbox image.
  url = await cli.outputUrlWhenReady("url", { tries: 840, delayMs: 1_000 });
  await fetchOk(`${url}/notes/none`, { tries: 60, delayMs: 500 });
}, 900_000);

afterAll(async () => {
  // Sandboxes are created at run time, so no destroy would remove one a failed test left.
  if (url !== "") {
    await Promise.all(
      platforms.map((platform) =>
        call(`/code/${platform}/${workspace}/remove`, {}).catch(() => undefined),
      ),
    );
  }
  await cli.stop();
  if (!process.env.NO_DESTROY) cli.destroy();
}, 240_000);

test("a conversation calls a tool implemented as a Layer", async () => {
  await create("math", ["add"]);
  const messages = await prompt("math", "What is 19 + 23? Use the add tool.");
  expect(toolResults(messages, "add")).toMatchObject([{ isError: false, text: '{"sum":42}' }]);
  expect(answer(messages)).toContain("42");
}, 180_000);

test("creating by name and submitting by request id are idempotent", async () => {
  const id = await create("twice", ["add"]);
  expect(await create("twice", ["add"])).toBe(id);

  const input = { text: "What is 2 + 3? Use the add tool.", requestId: "twice-1" };
  const first = await chat<{ submission: number }>("twice", "prompt", input);
  const second = await chat<{ submission: number }>("twice", "prompt", input);
  expect(second.submission).toBe(first.submission);

  const messages = await chat<ReadonlyArray<Message>>("twice", "messages");
  expect(messages.filter((message) => message.role === "user")).toHaveLength(1);

  expect(await chat<Record<string, number>>("twice", "list")).toMatchObject({ twice: id });
}, 180_000);

test("an inline tool writes through its Durable Object's binding, and a hook can block it", async () => {
  await create("notes", ["save_note"]);
  const saved = await prompt("notes", "Remember this: save the text 'teal' under the key 'color'.");
  expect(toolResults(saved, "save_note")).toMatchObject([{ isError: false }]);
  expect(await call<{ text: string | null }>("/notes/color")).toEqual({ text: "teal" });

  const blocked = await prompt("notes", "Now save the text 'hunter2' under the key 'secret'.");
  const [, refused] = toolResults(blocked, "save_note");
  expect(refused).toMatchObject({ isError: true });
  expect(refused!.text).toContain("Notes under the key 'secret' are not allowed.");
  expect(await call<{ text: string | null }>("/notes/secret")).toEqual({ text: null });
}, 240_000);

test("an extension renders a prompt section for each conversation", async () => {
  const id = await create("ticket", []);
  const messages = await prompt("ticket", "What is this conversation's ticket number?");
  expect(answer(messages)).toContain(`TICKET-${id}`);
}, 180_000);

test("tools are disabled and enabled on a running conversation", async () => {
  await create("toggle", ["add", "save_note"]);
  expect(await chat<string[]>("toggle", "tools")).toEqual(["add", "save_note"]);

  await chat("toggle", "disable-tool", { tool: "add" });
  expect(await chat<string[]>("toggle", "tools")).toEqual(["save_note"]);

  await chat("toggle", "enable-tool", { tool: "add" });
  expect((await chat<string[]>("toggle", "tools")).toSorted()).toEqual(["add", "save_note"]);
}, 120_000);

test("a skill added to a conversation is loaded when the task calls for it", async () => {
  await create("skill", []);
  await chat("skill", "add-skill", {});
  expect(await chat<string[]>("skill", "tools")).toEqual(["load_skill"]);

  const messages = await prompt("skill", "Greet me.");
  expect(toolResults(messages, "load_skill")).toMatchObject([{ isError: false }]);
  expect(answer(messages)).toContain("HELLO-FROM-SKILL");
}, 180_000);

test("code mode runs a program that calls the conversation's tools", async () => {
  await create("code", ["add"]);
  await chat("code", "enable-code-mode", {});
  expect((await chat<string[]>("code", "tools")).toSorted()).toEqual(["add", "codemode"]);

  const messages = await prompt(
    "code",
    "Use codemode: write a program that calls the add tool with a=6 and b=7 and prints the sum.",
  );
  const [result] = toolResults(messages, "codemode");
  expect(result).toMatchObject({ isError: false });
  expect(result!.text).toContain("13");
}, 180_000);

test("a run interrupted by a crash resumes from the alarm", async () => {
  await create("crash", ["add"]);
  await chat("crash", "start", {
    text: "What is 40 + 2? Use the add tool.",
    requestId: "crash-1",
  });
  await chat("crash", "crash", {});

  // Nothing calls the Durable Object while it is down: its alarm wakes it.
  await Bun.sleep(50_000);
  const messages = await pollUntil(
    "the interrupted run to finish",
    async () => {
      const seen = await chat<ReadonlyArray<Message>>("crash", "messages");
      return answer(seen).includes("42") ? seen : undefined;
    },
    { tries: 30, delayMs: 2_000 },
  );
  expect(toolResults(messages, "add")).toMatchObject([{ isError: false, text: '{"sum":42}' }]);
}, 240_000);

// The same agent on each sandbox platform. Only the Layer its Durable Object is given differs.
for (const platform of platforms) {
  test(`the coding agent's tools run in a sandbox on ${platform}`, async () => {
    const code = <A>(action: string, body?: unknown) =>
      call<A>(`/code/${platform}/${workspace}/${action}`, body);

    await code("create", {});
    const settled = await code<{ status: string }>("prompt", {
      // Relative paths: tools start in the sandbox user's home.
      text: 'Write the text "pi was here" to hello.txt using the write tool, then run `wc -c hello.txt` with bash and tell me the number.',
      requestId: "code-1",
    });
    expect(settled.status).toBe("done");

    // `wc` counts what `write` wrote: both ran in the same sandbox.
    const calls =
      await code<ReadonlyArray<{ tool: string; isError: boolean; text: string }>>("tool-calls");
    expect(calls).toMatchObject([
      { tool: "write", isError: false },
      { tool: "bash", isError: false },
    ]);
    expect(calls[1]!.text).toContain("11");

    await code("remove", {});
  }, 300_000);
}
