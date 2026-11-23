---
name: alchemy-ai
description: Build AI agents with @alchemy.run/ai - describe work as an AI.Process (prose that mentions the tools, models, inputs, other processes and Domain model commands it uses), declare tools one per file, start and talk to sessions, choose a harness (Pi or OpenCode) as a Layer, run sessions in a Durable Object, give tools a sandbox, and connect a process to an @alchemy.run/domain model with sessions that act as a user. Use when designing or changing a process, adding a tool, wiring a harness, hosting or a sandbox, connecting agents to a Domain model, or reviewing such code.
---

# Building with @alchemy.run/ai

`@alchemy.run/ai` gives work to a language model as a **process**: a class whose body is prose. The prose mentions what the work uses with `${}`. A mention shows the model the thing's name, grants it to the process, and makes its Layer a requirement of the program. A **session** is one running instance of a process. The **harness** that runs sessions (Pi or OpenCode) is a Layer, so a process never names one.

Docs: https://alchemy.run/ai, with every page listed in https://alchemy.run/llms.txt. Every section here and in the reference files ends with a More link to the docs page that covers it in depth. A complete reference project: `examples/cloudflare-ai-issues` in the alchemy repo (a GitHub issue board whose policy hands each issue to a session).

## Workflow

Work in this order. Each step has a reference file with templates.

1. **Describe the work** as processes: what each is told, what it is started with, what it may use. See [references/processes.md](references/processes.md).
2. **Lay out the files**: one per tool and per process, kind-suffixed. See [references/layout.md](references/layout.md).
3. **Declare each tool and model** from its template. See [references/tools-and-models.md](references/tools-and-models.md).
4. **Connect a Domain model**, if the work reads or changes business state, and say who each session acts as. See [references/domain.md](references/domain.md).
5. **Run it**: a harness Layer, a Durable Object that yields the process, and a sandbox if tools need files. See [references/running.md](references/running.md).

More: [Tutorial, part 1](https://alchemy.run/ai/tutorial/part-1).

## From requirements to declarations

Read the requirements and name each kind of thing you find:

- A piece of work a model does, described in sentences: a **Process**. Name it after the work (`Triage`, `Research`), never after a persona.
- A value the work is about, different for each run (which issue, which question): an **Input**, mentioned in the prose.
- Something the model must be able to do (post a comment, run the tests): a **Tool**, one per file.
- Reading, editing and searching files, or running commands: the **coding tools** (`AI.Read`, `AI.Edit`, `AI.Grep`, `AI.Bash`), with a **sandbox**.
- Instructions needed only sometimes (how to cut a release): a second **Process** the first one follows. There is no separate skill concept.
- Work to hand off, with its own conversation: a second **Process** the first one starts.
- Which LLM does which part: **Models**, mentioned where the prose says to use them.
- Business state the work reads or changes: commands and views of a **Domain model**, mentioned through the model (`Bank.DepositMoney`).
- Whose authority the work runs under: what a session is started **as**.

More: [What is Alchemy AI?](https://alchemy.run/ai/what-is-alchemy-ai).

## Conventions

- **One declaration per file, named `<Name>.<kind>.ts`.** The kinds are `.tool`, `.process` and `.mcp`. Never a `tools.ts` or `processes.ts` that collects several.
- **A tool's file holds its class and its Layer** (`PostAnswer` and `PostAnswerLive` in `PostAnswer.tool.ts`), and any failure only it returns.
- **A process's file holds the process and the inputs it mentions.** A tagged process keeps its `toLayer` there as `<Name>Live`.
- **Models share `Models.ts`.** `.model.ts` means a Domain model.
- **The Durable Object, the Worker and the sandbox Layer keep plain names** (`Agents.ts`, `Worker.ts`, `Sandbox.ts`).
- **A Domain model never imports a process or a tool.** It asks for work through a `Domain.ExternalSystem`.

More: [Project layout](https://alchemy.run/ai/project-layout).

## Rules that keep a process correct

- Mention everything the prose refers to. A tool named in plain words is not granted, and the model cannot call it.
- Write prose for the model: say what to do, in order, and when to use each mention. Write each `description` for another model that must decide whether to follow or start the process.
- A process has no output. Give a session somewhere to report: a Domain command, or a tool.
- Never put a value in the prose with string interpolation. Per-run values are inputs: the prose stays the same for every session, and a value never becomes an instruction.
- Never give a model an id to choose. Derive ids from `AI.ToolCall` in a tool; a Domain command a session sends already takes its id from the tool call.
- Mention one Domain command or view, not a whole aggregate, unless the work needs every command.
- Start a session as the person it acts for, authenticated where you already authenticate (your Worker). Never pass credentials through an input or a message.
- A session picks its own commands, so state the rules it must not break as `invariants` and `transitions` on the aggregate, and verify them with `Verify.model` in a test.
- For each middleware that checks something on a mentioned command (a second factor), provide a Layer that says what the check means for a session. Never provide your HTTP session middleware where a process runs.
- Starting a key twice does nothing, and `requestId` makes a message exactly-once: use both from code that may run twice (a policy, a webhook).
- A method that uses a session requires `RuntimeContext`: declare it on the interface (`Effect.Effect<void, never, RuntimeContext>`). Never capture the context and provide it by hand.
- Yield processes where the runtime's dependencies are resolved (a Durable Object's outer Effect). Build one Layer and provide it once.
- Never `throw`. A tool fails with its declared `failure` (`Schema.TaggedError`).

More: [Processes](https://alchemy.run/ai/processes), [Processes and Domain models](https://alchemy.run/ai/domain).

## Checklist for a change

1. Name the work. Put each process in `<Name>.process.ts` with a `description` and the inputs it mentions.
2. Put each new tool in `<Name>.tool.ts`, with its class and `<Name>Live`. Mention it in the prose that uses it.
3. Mention the Domain commands and views the work needs, through the model. Add `as` to every `start` if one is behind a middleware.
4. Provide every new Layer where the process runs: each tool, each model, the hosted Domain model, and a Layer for each middleware that checks something. A missing one is a type error.
5. Deploy and send one real message. Read `session.messages` to see what the model did.

More: [Where sessions run](https://alchemy.run/ai/hosting).
