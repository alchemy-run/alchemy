import * as Boat from "@alchemy.run/boat";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import OpenCodeApi from "./fixtures/Api.ts";

const providers = Layer.mergeAll(Cloudflare.providers(), Boat.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers });

const Stack = Alchemy.Stack(
  "OpenCodeCloudflareStack",
  { providers, state: Cloudflare.state() },
  Effect.gen(function* () {
    const api = yield* OpenCodeApi;
    return { url: api.url.as<string>() };
  }),
);

// The first deploy builds the sandbox snapshot.
const stack = beforeAll(deploy(Stack), { timeout: 600_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const tags = ["provider:cloudflare", "provider:opencode", "provider:boat", "live"];

/** What the async convention adds to a session's system prompt. */
const ASYNC_SECTION = `# Code mode

The tools declared below are called only from programs, which the \`alchemy_codemode\` tool runs.

Tools scripts can call (\`await tools.<name>(args)\`):

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

  namespace codes {
    /** Look up the secret code for a word. The code cannot be guessed. */
    function lookup_code(args: { word: string }): Promise<{ code: string }>;

    /** A tool that always reports an error. */
    function always_fails(): Promise<string>;
  }
}
\`\`\``;

/** The same, as the Effect convention declares it. */
const EFFECT_SECTION = `# Code mode

The tools declared below are called only from programs, which the \`alchemy_codemode\` tool runs.

Tools scripts can call (\`yield* tools.<name>(args)\`):

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

type ToolUse = { readonly tool: string; readonly status: string; readonly output: string };

test(
  "OpenCode in a Boat sandbox answers with the harness's model, runs its tools, and survives a suspend",
  Effect.gen(function* () {
    const name = `oc-${Date.now()}`;
    /** Boat's listing trails a state change by a moment. */
    const stateBecomes = (wanted: string | null) =>
      call(`/${name}/state`).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (result: { state: string | null }) => result.state === wanted,
          times: 15,
        }),
      );
    const used = (tool: string) =>
      Effect.map(call(`/${name}/tools`), (tools: ReadonlyArray<ToolUse>) =>
        tools.filter((use) => use.tool === tool && use.status === "completed"),
      );

    yield* Effect.gen(function* () {
      // The model is the harness's Layer, and the tool a Layer in the Durable Object.
      const sum = yield* call(`/${name}/prompt`, {
        text: "What is 19 + 23? Use the alchemy_add tool, then tell me the number it returned.",
        tools: ["add"],
        requestId: "add",
      });
      // The model may fumble a call's arguments first; one that completed is the tool's answer.
      expect((yield* used("alchemy_add")).at(-1)?.output).toContain("1042");
      // The model answered after the tool: its wording is its own.
      expect(sum.text.length).toBeGreaterThan(0);

      // The shell tool runs in the session's sandbox.
      yield* call(`/${name}/prompt`, {
        text: "Use the alchemy_bash tool to run exactly this command: printf 'opencode was here' > /home/user/hello.txt",
        tools: ["bash"],
        requestId: "write",
      });
      const wrote = (yield* used("alchemy_bash")).length;
      expect(wrote).toBeGreaterThan(0);
      expect((yield* call(`/${name}/file`, { path: "/home/user/hello.txt" })).text).toBe(
        "opencode was here",
      );

      // A tool of our own reads the same sandbox through `AI.Sandbox`.
      yield* call(`/${name}/prompt`, {
        text: "Use the alchemy_count_bytes tool on /home/user/hello.txt and tell me the number.",
        tools: ["count_bytes"],
        requestId: "count",
      });
      expect((yield* used("alchemy_count_bytes")).at(-1)?.output).toContain("17");

      // A declared failure reaches the model as the tool's error, with its tag and fields.
      yield* call(`/${name}/prompt`, {
        text: 'Use the alchemy_withdraw tool to withdraw 500 from the account "checking". Then use it again to withdraw 5 from the account "frozen".',
        tools: ["withdraw"],
        requestId: "withdraw",
      });
      const withdrawals = ((yield* call(`/${name}/tools`)) as ReadonlyArray<ToolUse>).filter(
        (use) => use.tool === "alchemy_withdraw",
      );
      const reported = withdrawals.map((use) => `${use.status}: ${use.output}`).join("\n");
      expect(reported).toContain('{"_tag":"InsufficientFunds","balance":137}');
      expect(reported).toContain('{"_tag":"AccountFrozen","account":"frozen"}');
      // Neither call counts as completed.
      expect(yield* used("alchemy_withdraw")).toEqual([]);

      // Suspending stops the sandbox, and suspending it again changes nothing.
      yield* call(`/${name}/suspend`, {});
      yield* call(`/${name}/suspend`, {});
      expect((yield* stateBecomes("paused")).state).toBe("paused");

      // The next prompt resumes it: the same session, with its transcript and files.
      yield* call(`/${name}/prompt`, {
        text: "Use the alchemy_bash tool to run exactly this command: cat /home/user/hello.txt",
        tools: ["bash"],
        requestId: "read",
      });
      expect((yield* stateBecomes("running")).state).toBe("running");
      // The transcript from before the suspend is still there, and the shell ran again.
      expect((yield* used("alchemy_add")).length).toBeGreaterThan(0);
      const shell = yield* used("alchemy_bash");
      expect(shell.length).toBeGreaterThan(wrote);
      expect(shell.at(-1)!.output).toContain("opencode was here");

      // Removing deletes it, and removing it again changes nothing.
      yield* call(`/${name}/kill`, {});
      yield* call(`/${name}/kill`, {});
      expect((yield* stateBecomes(null)).state).toBeNull();
      // A failed assertion must not leave a sandbox running.
    }).pipe(Effect.ensuring(Effect.ignore(call(`/${name}/kill`, {}))));
  }),
  { tags, timeout: 420_000 },
);

/** The programs the session ran with `tool`, and what each returned. */
const programsOf = (name: string, tool: string) =>
  Effect.map(call(`/${name}/tools`), (tools: ReadonlyArray<ToolUse>) =>
    tools
      .filter((use) => use.tool === tool)
      .map((use) => use.output)
      .join("\n"),
  );

test(
  "async code mode declares each tool with the failures it throws, and runs the program in the Durable Object",
  Effect.gen(function* () {
    const name = `oc-async-${Date.now()}`;
    yield* Effect.gen(function* () {
      yield* call(`/${name}/prompt`, {
        // The program is given whole: left to write it, the model sometimes calls nothing.
        text: 'Run exactly this JavaScript with the alchemy_codemode tool, unchanged:\n\nconst added = await tools.add({ a: 19, b: 23 });\nconst failure = await tools.withdraw({ account: "checking", amount: 500 }).then(() => "resolved", (error) => (error instanceof tools.InsufficientFunds) + ":" + error._tag + ":" + error.balance);\nconst found = await tools.codes.lookup_code({ word: "teal" });\nreturn "PROGRAM " + added.sum + " " + failure + " " + found.code;',
        tools: [],
        programs: ["add", "withdraw", "codes"],
        requestId: "program",
      });
      expect(yield* programsOf(name, "alchemy_codemode")).toContain(
        "PROGRAM 1042 true:InsufficientFunds:137 CODE-TEAL-7391",
      );
      expect(((yield* call(`/${name}/section`)) as { section: unknown }).section).toBe(
        ASYNC_SECTION,
      );
    }).pipe(Effect.ensuring(Effect.ignore(call(`/${name}/kill`, {}))));
  }),
  { tags, timeout: 300_000 },
);

test(
  "Effect code mode declares failures in each tool's Effect, and runs the program in a loaded isolate",
  Effect.gen(function* () {
    const name = `oc-effect-${Date.now()}`;
    yield* Effect.gen(function* () {
      yield* call(`/${name}/prompt`, {
        text: 'Run exactly this JavaScript with the alchemy_codemode tool, unchanged:\n\nconst added = yield* tools.add({ a: 19, b: 23 });\nconst balance = yield* tools.withdraw({ account: "checking", amount: 500 }).pipe(Effect.map(() => -1), Effect.catchTag("InsufficientFunds", (error) => Effect.succeed(error.balance)));\nconst frozen = yield* tools.withdraw({ account: "frozen", amount: 5 }).pipe(Effect.flip, Effect.map((error) => error instanceof tools.AccountFrozen));\nreturn "PROGRAM " + added.sum + " " + balance + " " + frozen;',
        tools: [],
        programs: ["add", "withdraw"],
        requestId: "program",
      });
      expect(yield* programsOf(name, "alchemy_codemode")).toContain("PROGRAM 1042 137 true");
      expect(((yield* call(`/${name}/section`)) as { section: unknown }).section).toBe(
        EFFECT_SECTION,
      );
    }).pipe(Effect.ensuring(Effect.ignore(call(`/${name}/kill`, {}))));
  }),
  { tags, timeout: 300_000 },
);

test(
  "OpenCode's own code mode runs the program with its execute tool, and a declared failure rejects it",
  Effect.gen(function* () {
    const name = `oc-native-${Date.now()}`;
    yield* Effect.gen(function* () {
      yield* call(`/${name}/prompt`, {
        text: 'Run exactly this JavaScript with the execute tool, unchanged:\n\nconst added = await tools.alchemy.add({ a: 19, b: 23 });\nconst failure = await tools.alchemy.withdraw({ account: "checking", amount: 500 }).then(() => "resolved", (error) => error.message);\nreturn "PROGRAM " + added.sum + " " + failure;',
        tools: [],
        programs: ["add", "withdraw"],
        requestId: "program",
      });
      const output = yield* programsOf(name, "execute");
      // The tool's typed result, and its declared failure with its tag and fields.
      expect(output).toContain("PROGRAM 1042");
      expect(output).toMatch(/_tag\W+InsufficientFunds\W+balance\W+137/);
      // OpenCode writes its own catalog: the harness adds nothing.
      expect(((yield* call(`/${name}/section`)) as { section: unknown }).section).toBeNull();
    }).pipe(Effect.ensuring(Effect.ignore(call(`/${name}/kill`, {}))));
  }),
  { tags, timeout: 300_000 },
);
