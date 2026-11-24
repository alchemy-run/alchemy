import * as Boat from "@alchemy.run/boat";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import PiApi from "./fixtures/Api.ts";
import PiWrongHarnessApi from "./fixtures/WrongHarness.ts";

const providers = Layer.mergeAll(Cloudflare.providers(), Boat.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers });

const Stack = Alchemy.Stack(
  "PiCloudflareStack",
  { providers, state: Cloudflare.state() },
  Effect.gen(function* () {
    const api = yield* PiApi;
    return { url: api.url.as<string>() };
  }),
);

// The first deploy builds the sandbox snapshot.
const stack = beforeAll(deploy(Stack), { timeout: 600_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const tags = ["provider:cloudflare", "provider:pi", "live"];

/** What the async convention adds to the system prompt for the fixture's `add` and `withdraw`. */
const ASYNC_SECTION = `Tools scripts can call (\`await tools.<name>(args)\`):

\`\`\`ts
declare namespace tools {
  class InsufficientFunds extends Error {
    readonly _tag: "InsufficientFunds";
    readonly balance: number;
  }

  class AccountFrozen extends Error {
    readonly _tag: "AccountFrozen";
    readonly account: string;
  }

  /** Add two integers. Always use this tool to add numbers; never add them yourself. */
  function add(args: { a: number; b: number }): Promise<{ sum: number }>;

  /**
   * Withdraw money from an account. Always use this tool to withdraw.
   * @throws {InsufficientFunds}
   * @throws {AccountFrozen}
   */
  function withdraw(args: { account: string; amount: number }): Promise<{ balance: number }>;
}
\`\`\``;

/** The same tools, as the Effect convention declares them. */
const EFFECT_SECTION = `Tools scripts can call (\`yield* tools.<name>(args)\`):

\`\`\`ts
declare namespace tools {
  class InsufficientFunds extends Data.TaggedError("InsufficientFunds")<{
    readonly balance: number;
  }> {}

  class AccountFrozen extends Data.TaggedError("AccountFrozen")<{
    readonly account: string;
  }> {}

  /** Add two integers. Always use this tool to add numbers; never add them yourself. */
  function add(args: { a: number; b: number }): Effect<{ sum: number }>;

  /** Withdraw money from an account. Always use this tool to withdraw. */
  function withdraw(args: { account: string; amount: number }): Effect<{ balance: number }, InsufficientFunds | AccountFrozen>;
}
\`\`\``;

/** An MCP server's tools, declared under its name. */
const MCP_SECTION = `Tools scripts can call (\`await tools.<name>(args)\`):

\`\`\`ts
declare namespace tools {
  namespace codes {
    /** Look up the secret code for a word. The code cannot be guessed. */
    function lookup_code(args: { word: string }): Promise<{ code: string }>;

    /** A tool that always reports an error. */
    function always_fails(): Promise<string>;
  }
}
\`\`\``;

/** Call the fixture's API; retries ride through a fresh workers.dev URL's first seconds. */
const call = (path: string, body?: unknown) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    const request =
      body === undefined
        ? HttpClientRequest.get(`${url}${path}`)
        : HttpClientRequest.post(`${url}${path}`).pipe(HttpClientRequest.bodyJsonUnsafe(body));
    const response = yield* HttpClient.filterStatusOk(client)
      .execute(request)
      .pipe(
        Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 8 }),
        // Say what the fixture answered: a bare status hides the cause.
        Effect.catch(() =>
          Effect.flatMap(client.execute(request), (failed) =>
            Effect.flatMap(failed.text, (text) =>
              Effect.die(new Error(`${path} returned ${failed.status}: ${text.slice(0, 2000)}`)),
            ),
          ),
        ),
      );
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
  "an inline tool uses the KV binding it bound",
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
  "a tool's declared failure reaches the model with its tag and fields",
  Effect.gen(function* () {
    const user = `user-${Date.now()}`;
    yield* call(`/${user}/bank/create`, { tools: ["withdraw"] });
    yield* call(`/${user}/bank/prompt`, {
      text: 'Withdraw 500 from the account "checking".',
      requestId: "withdraw-1",
    });
    yield* call(`/${user}/bank/prompt`, {
      text: 'Now withdraw 5 from the account "frozen".',
      requestId: "withdraw-2",
    });
    const results = (yield* call(`/${user}/bank/results`)) as ReadonlyArray<{
      tool: string;
      isError: boolean;
      text: string;
    }>;
    const failures = results
      .filter((result) => result.tool === "withdraw" && result.isError)
      .map((result) => result.text);
    // Each error of the union, encoded by its schema.
    expect(failures).toContain('{"_tag":"InsufficientFunds","balance":137}');
    expect(failures).toContain('{"_tag":"AccountFrozen","account":"frozen"}');
  }),
  { tags, timeout: 180_000 },
);

test(
  "a coding tool's tag runs the implementation the harness was given",
  Effect.gen(function* () {
    const user = `user-${Date.now()}`;
    yield* call(`/${user}/files/create`, { tools: ["glob"] });
    expect(yield* call(`/${user}/files/tools`)).toEqual(["glob"]);
    yield* call(`/${user}/files/prompt`, {
      text: 'List the files matching the pattern "*.md" with the glob tool.',
      requestId: "glob-1",
    });
    const results = (yield* call(`/${user}/files/results`)) as ReadonlyArray<{
      tool: string;
      isError: boolean;
      text: string;
    }>;
    const listed = results.find((result) => result.tool === "glob");
    expect(listed?.isError).toBe(false);
    // The listing is the fixture's own, not Pi's glob in a sandbox.
    expect(listed?.text).toContain("OWN-GLOB-4711/*.md");
  }),
  { tags, timeout: 180_000 },
);

test.provider(
  "a harness given another harness's tool fails its deploy and says which Layer to provide",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const exit = yield* stack.deploy(PiWrongHarnessApi).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain(
        "AI.Tool/bash was given opencode's tool, which only runs on that harness. Provide a Pi Layer for it (Pi.CodingTools) or your own.",
      );
      yield* stack.destroy();
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
  "coding tools run in a Boat sandbox that suspends, resumes and is removed",
  Effect.gen(function* () {
    const name = `sbx-${Date.now()}`;
    /** Boat's listing trails a state change by a moment. */
    const stateBecomes = (wanted: string | null) =>
      call(`/sandbox/${name}/state`).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (result: { state: string | null }) => result.state === wanted,
          times: 15,
        }),
      );
    yield* call(`/sandbox/${name}/create`, {});
    yield* Effect.gen(function* () {
      const status = yield* call(`/sandbox/${name}/prompt`, {
        text: 'Use the write tool to create /home/user/hello.txt containing exactly the text "pi was here". Then use bash to run: wc -c /home/user/hello.txt',
        requestId: "sbx-1",
      });
      const tools = (yield* call(`/sandbox/${name}/tools`)) as ReadonlyArray<{
        tool: string;
        isError: boolean;
      }>;
      const file = yield* call(`/sandbox/${name}/file`, { path: "/home/user/hello.txt" });
      expect(status.status).toBe("done");
      expect(tools.some((used) => used.tool === "write" && !used.isError)).toBe(true);
      expect(tools.some((used) => used.tool === "bash" && !used.isError)).toBe(true);
      expect(file.text).toContain("pi was here");

      // A tool of our own reads the same sandbox through `AI.Sandbox`.
      yield* call(`/sandbox/${name}/prompt`, {
        text: "Use the count_bytes tool on /home/user/hello.txt and tell me the number.",
        requestId: "sbx-count",
      });
      const counted = (yield* call(`/sandbox/${name}/tools`)) as ReadonlyArray<{
        tool: string;
        isError: boolean;
      }>;
      expect(counted.some((used) => used.tool === "count_bytes" && !used.isError)).toBe(true);

      // Suspending pauses the sandbox, and suspending it again changes nothing.
      yield* call(`/sandbox/${name}/suspend`, {});
      yield* call(`/sandbox/${name}/suspend`, {});
      expect((yield* stateBecomes("paused")).state).toBe("paused");

      // The next tool call resumes it, with the file still there.
      const resumed = yield* call(`/sandbox/${name}/prompt`, {
        text: "Use bash to run: cat /home/user/hello.txt",
        requestId: "sbx-2",
      });
      expect(resumed.status).toBe("done");
      expect((yield* stateBecomes("running")).state).toBe("running");
      const after = (yield* call(`/sandbox/${name}/tools`)) as ReadonlyArray<{
        tool: string;
        isError: boolean;
      }>;
      expect(after.filter((used) => used.tool === "bash" && !used.isError).length).toBe(2);

      // Removing deletes it, and removing it again changes nothing.
      yield* call(`/sandbox/${name}/kill`, {});
      yield* call(`/sandbox/${name}/kill`, {});
      expect((yield* stateBecomes(null)).state).toBeNull();
      // A failed assertion must not leave a sandbox running.
    }).pipe(Effect.ensuring(Effect.ignore(call(`/sandbox/${name}/kill`, {}))));
  }),
  { tags: [...tags, "provider:boat"], timeout: 300_000 },
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

type Results = ReadonlyArray<{ tool: string; isError: boolean; text: string }>;

/** What the conversation's code mode scripts printed. */
const printedBy = (results: Results) =>
  results
    .filter((result) => result.tool === "codemode")
    .map((result) => result.text)
    .join("\n---\n");

test(
  "async code mode declares each tool with the failures it throws, and runs a script on the Durable Object",
  Effect.gen(function* () {
    const user = `user-${Date.now()}`;
    yield* call(`/${user}/script/create`, { tools: ["add", "withdraw"] });
    // An exact list without the group has no code mode.
    expect(yield* call(`/${user}/script/offered`)).toEqual(["add", "withdraw"]);
    yield* call(`/${user}/script/codemode`, {});
    // Listed both ways, the tools are offered directly and from programs.
    expect(yield* call(`/${user}/script/offered`)).toEqual(["add", "codemode", "withdraw"]);

    yield* call(`/${user}/script/prompt`, {
      // The script is given whole: left to write it, the model sometimes prints nothing.
      text: "Run exactly this script with the codemode tool, unchanged:\n\nconsole.log(JSON.stringify([await tools.add({ a: 2, b: 3 }), await tools.add({ a: 10, b: 20 })]));",
      requestId: "script-1",
    });
    const printed = printedBy((yield* call(`/${user}/script/results`)) as Results);
    expect(printed).toContain("1005");
    expect(printed).toContain("1030");

    expect(((yield* call(`/${user}/script/section`)) as { section: string }).section).toBe(
      ASYNC_SECTION,
    );
  }),
  { tags, timeout: 180_000 },
);

test(
  "an async script catches a tool's declared failure as an instance of its class",
  Effect.gen(function* () {
    const user = `user-${Date.now()}`;
    yield* call(`/${user}/script/create`, { tools: ["withdraw"] });
    yield* call(`/${user}/script/codemode`, {});
    yield* call(`/${user}/script/prompt`, {
      text: 'Run exactly this script with the codemode tool, unchanged:\n\nconst outcome = await tools.withdraw({ account: "frozen", amount: 5 }).then(() => "resolved", (error) => (error instanceof tools.AccountFrozen) + ":" + (error instanceof Error) + ":" + error._tag + ":" + error.account);\nconsole.log("OUTCOME " + outcome);',
      requestId: "script-failure-1",
    });
    expect(printedBy((yield* call(`/${user}/script/results`)) as Results)).toContain(
      "OUTCOME true:true:AccountFrozen:frozen",
    );
  }),
  { tags, timeout: 180_000 },
);

test(
  "Effect code mode offers only programs, declares failures in each tool's Effect, and runs in a loaded isolate",
  Effect.gen(function* () {
    const name = `effect-${Date.now()}`;
    yield* call(`/effect/${name}/create`, {});
    // Listed only inside the group, the tools are not offered as direct calls.
    expect(yield* call(`/effect/${name}/offered`)).toEqual(["codemode"]);

    yield* call(`/effect/${name}/prompt`, {
      text: 'Run exactly this script with the codemode tool, unchanged:\n\nconst added = yield* tools.add({ a: 2, b: 3 });\nconst balance = yield* tools.withdraw({ account: "checking", amount: 500 }).pipe(Effect.map(() => -1), Effect.catchTag("InsufficientFunds", (error) => Effect.succeed(error.balance)));\nconst frozen = yield* tools.withdraw({ account: "frozen", amount: 5 }).pipe(Effect.flip, Effect.map((error) => error instanceof tools.AccountFrozen));\nconsole.log("EFFECT " + added.sum + " " + balance + " " + frozen);',
      requestId: "effect-1",
    });
    expect(printedBy((yield* call(`/effect/${name}/results`)) as Results)).toContain(
      "EFFECT 1005 137 true",
    );

    expect(((yield* call(`/effect/${name}/section`)) as { section: string }).section).toBe(
      EFFECT_SECTION,
    );
  }),
  { tags, timeout: 180_000 },
);

test(
  "a program calls an MCP server's tools under the server's name",
  Effect.gen(function* () {
    const name = `mcp-programs-${Date.now()}`;
    yield* call(`/mcp/${name}/create`, { withServer: true, programs: true });
    // The server is also listed directly, so its tools are offered both ways.
    expect(yield* call(`/mcp/${name}/tools`)).toEqual([
      "codemode",
      "mcp__codes__always_fails",
      "mcp__codes__lookup_code",
    ]);

    yield* call(`/mcp/${name}/prompt`, {
      text: 'Run exactly this script with the codemode tool, unchanged:\n\nconst found = await tools.codes.lookup_code({ word: "teal" });\nconst refused = await tools.codes.always_fails({}).then(() => "resolved", (error) => "rejected");\nconsole.log("FOUND " + found.code + " " + refused);',
      requestId: "mcp-programs-1",
    });
    expect(printedBy((yield* call(`/mcp/${name}/results`)) as Results)).toContain(
      "FOUND CODE-TEAL-7391 rejected",
    );

    expect(((yield* call(`/mcp/${name}/section`)) as { section: string }).section).toBe(
      MCP_SECTION,
    );
  }),
  { tags, timeout: 180_000 },
);

test(
  "an MCP server's tools are listed, called, and added or removed as one",
  Effect.gen(function* () {
    const name = `mcp-${Date.now()}`;
    yield* call(`/mcp/${name}/create`, { withServer: true });
    expect(yield* call(`/mcp/${name}/tools`)).toEqual([
      "add",
      "mcp__codes__always_fails",
      "mcp__codes__lookup_code",
    ]);

    const status = yield* call(`/mcp/${name}/prompt`, {
      text: 'Look up the secret code for the word "teal" with the lookup tool, then reply with the code.',
      requestId: "mcp-1",
    });
    expect(status.status).toBe("done");
    const results = (yield* call(`/mcp/${name}/results`)) as ReadonlyArray<{
      tool: string;
      isError: boolean;
      text: string;
    }>;
    const looked = results.find((result) => result.tool === "mcp__codes__lookup_code");
    expect(looked?.isError).toBe(false);
    expect(looked?.text).toContain("CODE-TEAL-7391");

    // The server's own error reaches the model as an error result.
    yield* call(`/mcp/${name}/prompt`, {
      text: "Call the always_fails tool once and tell me what it said.",
      requestId: "mcp-2",
    });
    const failed = ((yield* call(`/mcp/${name}/results`)) as typeof results).find(
      (result) => result.tool === "mcp__codes__always_fails",
    );
    expect(failed?.isError).toBe(true);
    expect(failed?.text).toContain("this tool always fails");

    // The server stands for all of its tools when a conversation's tools change.
    yield* call(`/mcp/${name}/remove-server`, {});
    expect(yield* call(`/mcp/${name}/tools`)).toEqual(["add"]);
    yield* call(`/mcp/${name}/add-server`, {});
    expect(yield* call(`/mcp/${name}/tools`)).toHaveLength(3);

    // A conversation created without the server has none of its tools.
    yield* call(`/mcp/${name}-plain/create`, { withServer: false });
    expect(yield* call(`/mcp/${name}-plain/tools`)).toEqual(["add"]);
  }),
  { tags, timeout: 240_000 },
);
