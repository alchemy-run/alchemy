# Tools and models

## A tool

The class and its Layer, in `<Name>.tool.ts`.

```typescript
// src/PostAnswer.tool.ts
import * as AI from "@alchemy.run/ai";
import * as GitHub from "@alchemy.run/github";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Repo } from "./Repo.ts";

export class PostAnswer extends AI.Tool<PostAnswer>()("post_answer", {
  description: "Post your answer on the issue as a comment, in Markdown.",
  parameters: Schema.Struct({ issue: Schema.Number, markdown: Schema.String }),
  success: Schema.Struct({ url: Schema.String }),
}) {}

export const PostAnswerLive = PostAnswer.make(
  Effect.gen(function* () {
    const comment = yield* GitHub.CreateIssueComment(yield* Repo);

    return Effect.fn(function* ({ issue, markdown }) {
      const posted = yield* comment({ issue_number: issue, body: markdown }).pipe(Effect.orDie);
      return { url: posted.html_url };
    });
  }),
).pipe(Layer.provide(GitHub.CreateIssueCommentHttp));
```

The outer Effect runs where the process is yielded, so bindings it declares are part of the deploy. A tool with nothing to build passes the handler alone: `Add.make(({ a, b }) => ({ sum: a + b }))`.

Bind in that outer Effect, never outside the tool: a plan lists each tool with what it binds, and a handler that uses a client bound elsewhere (one it closed over or was handed) fails that call with `CapabilityDenied`.

More: [Declare a tool](https://alchemy.run/ai/tools#declare-a-tool), [Use a binding](https://alchemy.run/ai/tools#use-a-binding), [A tool uses only what it binds](https://alchemy.run/ai/tools#a-tool-uses-only-what-it-binds).

## A tool that fails

Declare the failure. The model reads its `_tag` and fields and can act on it.

```typescript
export class InsufficientFunds extends Schema.TaggedError<InsufficientFunds>()("InsufficientFunds", {
  balance: Schema.Number,
}) {}

export class Withdraw extends AI.Tool<Withdraw>()("withdraw", {
  description: "Withdraw money from an account.",
  parameters: Schema.Struct({ amount: Schema.Number }),
  success: Schema.Struct({ balance: Schema.Number }),
  failure: InsufficientFunds,
}) {}
```

More: [Fail with a declared error](https://alchemy.run/ai/tools#fail-with-a-declared-error).

## A tool that works in the sandbox

`AI.Sandbox` is the sandbox of the session the call belongs to. Using it makes the Layer require `AI.Sandboxes`.

```typescript
export const RunTestsLive = RunTests.make(
  Effect.fn(function* () {
    const sandbox = yield* AI.Sandbox;
    const result = yield* sandbox.exec(["npm", "test"]).pipe(Effect.orDie);
    return { exitCode: result.exitCode };
  }),
);
```

More: [Work in the sandbox](https://alchemy.run/ai/tools#work-in-the-sandbox).

## Coding tools

`AI.Bash`, `AI.Read`, `AI.Edit`, `AI.Write`, `AI.Grep`, `AI.Glob`, or all six as `AI.CodingTools`. They are names: provide `Pi.CodingTools` or `OpenCode.CodingTools`, and an `AI.Sandboxes` Layer.

More: [Mention them in a process](https://alchemy.run/ai/coding-tools#mention-them-in-a-process).

## Models

```typescript
// src/Models.ts
import * as AI from "@alchemy.run/ai";
import * as AICloudflare from "@alchemy.run/ai/Cloudflare";
import * as Layer from "effect/Layer";

export class Smart extends AI.Model<Smart>()("smart") {}
export class Fast extends AI.Model<Fast>()("fast") {}

export const ModelsLive = Layer.mergeAll(
  AICloudflare.Model(Smart, { model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" }),
  AICloudflare.Model(Fast, { model: "@cf/meta/llama-3.1-8b-instruct-fast" }),
);
```

On Anthropic, use `AIAnthropic.Model` from `@alchemy.run/ai/Anthropic`, with `@effect/ai-anthropic` installed. The key is read from `ANTHROPIC_API_KEY`:

```typescript
export const SmartLive = AIAnthropic.Model(Smart, { model: "claude-opus-5-5" });
```

On OpenAI, use `AIOpenAI.Model` from `@alchemy.run/ai/OpenAI`, with `@effect/ai-openai` installed. The key is read from `OPENAI_API_KEY`:

```typescript
export const FastLive = AIOpenAI.Model(Fast, { model: "gpt-5.4-mini" });
```

`AI.DefaultModel(Smart)` is required by every process. A mentioned model can be chosen at `start`, per message (`{ model: Fast }`), or by a session when it starts another.

More: [Back it with an LLM](https://alchemy.run/ai/models#back-it-with-an-llm), [Use Anthropic](https://alchemy.run/ai/models#use-anthropic), [Use OpenAI](https://alchemy.run/ai/models#use-openai), [Set the default model](https://alchemy.run/ai/models#set-the-default-model).

## State a session keeps

`AI.State` is typed state every session has, stored beside its transcript. The model never reads it.

```typescript
// src/Phase.state.ts
export class Phase extends AI.State("phase", {
  schema: Schema.Struct({ phase: Schema.Literals(["research", "draft", "publish"]) }),
  initial: { phase: "research" },
}) {}

// in a tool: the state of the session whose model made the call
export const AdvanceLive = Advance.make(
  Effect.fn(function* () {
    yield* Phase.set({ phase: "draft" });
  }),
);

// from outside: name the session
yield* engineer.get(taskId).state(Phase).update((state) => ({ ...state, phase: "publish" }));
```

More: [State](https://alchemy.run/ai/state), [Read and write it from outside](https://alchemy.run/ai/state#read-and-write-it-from-outside).

## An MCP server

```typescript
// src/Docs.mcp.ts
export class Docs extends AI.McpServer<Docs>()("docs") {}

export const DocsLive = Docs.layer(
  McpClient.layerHttp({
    name: "my-agent",
    version: "1.0.0",
    protocol: McpProtocol.v2025_11_25,
    url: "https://docs.example.com/mcp",
  }).pipe(Layer.provide(FetchHttpClient.layer)),
);
```

Mentioning `${Docs}` grants every tool the server offers.

More: [Declare a server](https://alchemy.run/ai/mcp-servers#declare-a-server).
