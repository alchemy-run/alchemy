---
name: alchemy-ai
description: Build AI agents and the app around them with @alchemy.run/ai - describe work as an AI.Process (prose that mentions the tools, models, other processes and Domain model commands it uses), declare tools one per file, start and talk to sessions, list processes on an @alchemy.run/domain model so the model's platform hosts each session (a Durable Object of its own on Cloudflare), reach sessions from policies, sagas and Workers, choose a harness (Pi or OpenCode) as a Layer, give tools a sandbox, record what a session does into the model, and serve it to a front end. Use when designing or changing a process, adding a tool, wiring a harness, hosting or a sandbox, connecting agents to a Domain model, building a UI over agent sessions, or reviewing such code. Works with the alchemy-domain skill, which covers the model itself and the front end in depth.
---

# Building with @alchemy.run/ai

`@alchemy.run/ai` gives work to a language model as a **process**: a name, and prose that says how the work is done. The prose mentions what the work uses with `${}`. A mention shows the model the thing's name, grants it to the process, and makes its Layer a requirement of the program. A **session** is one running instance of a process. The **harness** that runs sessions (Pi or OpenCode) is a Layer, so a process never names one.

Write the whole app as one **Domain model**: commands, aggregates, events, policies, sagas, views, streams, and the processes among them. A Worker, a webhook or a queue is only an entry point that brings the outside world in as commands. Layers underneath say where it runs: Durable Objects, a harness, an LLM, a sandbox. You write no Durable Object for a session.

Docs: https://alchemy.run/ai, with every page listed in https://alchemy.run/llms.txt. Every section here and in the reference files ends with a More link to the docs page that covers it in depth. A complete reference project: `examples/cloudflare-ai-issues` in the alchemy repo (a GitHub issue board whose policy hands each issue to a session).

## The whole app, top down

An app with agents has three rings. Program in the middle one.

1. **Entry points**: a Worker's `fetch`, a webhook (`GitHub.consumeRepositoryEvents`), a page. Each turns what happened outside into a command, or reads a view. None of them starts a session or knows a process exists.
2. **The model**: a Domain model. Its commands, events and views are the rules, and they hold whoever sends a command, a person or an agent. Its **processes** are members of it, listed in `processes`: a policy or a saga hands a session work with `yield* Triage`, the prose mentions the model's own commands and views, and the model records each process as a view named after it (`Triage`, keyed by the session) so a page and other views can follow what each session does. Use the **`alchemy-domain` skill** for the rest of this ring (`packages/domain/skills/alchemy-domain`, or https://alchemy.run/domain). Everything about aggregates, views, policies, stories and hosting the model is there, not here.
3. **Layers**: where it runs. `DomainCloudflare.layerDurableObjects()` makes every member a Durable Object class, one object for each session of a process. A harness Layer, a model Layer and a sandbox Layer say what a session runs on. Swap one and the model does not change; `Domain.InMemory` and `AI.scripted` run all of it in a test.

A front end is an entry point: one Api over the model. A page sends commands and watches views and streams. It never talks to a session.

When a step below says "see the `alchemy-domain` skill", load that skill and follow its reference file. Don't re-derive Domain patterns from this one.

More: [What is Alchemy AI?](https://alchemy.run/ai/what-is-alchemy-ai), [Domain](https://alchemy.run/domain).

## Workflow

Work in this order. Each step has a reference file with templates.

1. **Model the business** with the `alchemy-domain` skill: its `references/modeling.md` and `references/building-blocks.md`. Skip this only when the work touches no business state.
2. **Lay out the files**: the model in a folder or package of its own, one file per tool and per process, the page in `web/`. See [references/layout.md](references/layout.md).
3. **Describe the work** as processes: what each is told, what it is started with, what it may use. See [references/processes.md](references/processes.md).
4. **Declare each tool and model** from its template. See [references/tools-and-models.md](references/tools-and-models.md).
5. **Put the processes on the model**: list each in `processes`, mention the model's commands and views in its prose, say who each session acts as, and let a policy hand it work. See [references/domain.md](references/domain.md).
6. **Run it**: give `Model.layer` the prose with a harness Layer, a model Layer and a sandbox if tools need files, and provide the platform. See [references/running.md](references/running.md).
7. **Serve it to a front end**: list what a page may send and read, and build the page, which follows each session through the process's view. See [references/front-end.md](references/front-end.md), then the `alchemy-domain` skill's `references/frontend.md` for the page itself.
8. **Test every layer**: stories and `Verify` for the model, stories for the page, the page with the board in memory, then the deployed app. See [references/testing.md](references/testing.md).

More: [Tutorial, part 1](https://alchemy.run/ai/tutorial/part-1), [Connect a front end](https://alchemy.run/ai/front-end).

## From requirements to declarations

Read the requirements and name each kind of thing you find:

- A piece of work a model does, described in sentences: a **Process**, listed on the model. Name it after the work (`Triage`, `Research`), never after a persona.
- A value the work is about, different for each run (which issue, which question): the session's **key**, and its first message. A process has no inputs.
- When the work starts, and what it is told later: a **Policy** or a **Saga** of the model, which holds the process's client.
- What the rest of the app needs to see of the work: the process's own **view**, which the model keeps for every process it lists, and views that list the process in `from`.
- Something the model must be able to do (post a comment, run the tests): a **Tool**, one per file.
- Reading, editing and searching files, or running commands: the **coding tools** (`AI.Read`, `AI.Edit`, `AI.Grep`, `AI.Bash`), with a **sandbox**.
- Instructions needed only sometimes (how to cut a release): a second **Process** the first one follows. There is no separate skill concept.
- Work to hand off, with its own conversation: a second **Process** the first one starts.
- Which LLM does which part: **Models**, mentioned where the prose says to use them.
- Business state the work reads or changes: commands and views of a **Domain model**, mentioned through the model (`${() => Bank.DepositMoney}`).
- Whose authority the work runs under: what a session is started **as**.

More: [What is Alchemy AI?](https://alchemy.run/ai/what-is-alchemy-ai).

## Conventions

- **One declaration per file, named `<Name>.<kind>.ts`.** The kinds are `.tool`, `.process` and `.mcp`. Never a `tools.ts` or `processes.ts` that collects several.
- **A tool's file holds its class and its Layer** (`PostAnswer` and `PostAnswerLive` in `PostAnswer.tool.ts`), and any failure only it returns.
- **A process a model lists is one file in the model's folder.** `<Name>.process.ts` holds the name (`class Triage extends AI.Process<Triage>()("Triage", {})`) and `<Name>Live`, its prose. The prose mentions the model and the model lists the process, so break that import cycle with thunks: each mention is `${() => Board.LabelIssue}`, and the model, and any view that lists the process in `from`, takes its props as `() => ({ ... })`. Use a thunk only to break a cycle.
- **Any other process's file holds the process**: prose on the class, or a name with its `toLayer` beside it.
- **Models share `Models.ts`.** `.model.ts` means a Domain model.
- **The Worker and the sandbox Layer keep plain names** (`Worker.ts`, `Sandbox.ts`). The Layers that say where and on what the model runs are composed in one place, beside the Worker.
- **Never write a Durable Object to hold a session** when there is a model: list the process and let the platform host it.
- **A Domain model never imports a tool.** It lists a process by its name. Its own files follow the `alchemy-domain` skill's conventions (`<Noun>.<kind>.ts`).
- **The page lives in `web/`** and imports only the model's Api, ids and value Schemas, never a process or a tool.

More: [Project layout](https://alchemy.run/ai/project-layout).

## Rules that keep a process correct

- Mention everything the prose refers to. A tool named in plain words is not granted, and the model cannot call it.
- Write prose for the model: say what to do, in order, and when to use each mention. Write each `description` for another model that must decide whether to follow or start the process.
- A process has no output. Give a session somewhere to report: a Domain command, or a tool.
- Never put a value in the prose with string interpolation. A process has no inputs: the prose stays the same for every session, and what one session works on is its first message.
- Never give a model an id to choose. Derive ids from `AI.ToolCall` in a tool; a Domain command a session sends already takes its id from the tool call.
- Mention one Domain command or view, not a whole aggregate, unless the work needs every command.
- Start a session as the person it acts for, authenticated where you already authenticate (your Worker). Never pass credentials through a message.
- A session picks its own commands, so state the rules it must not break as `invariants` and `transitions` on the aggregate, and verify them with `Verify.model` in a test.
- For each middleware that checks something on a mentioned command (a second factor), provide a Layer that says what the check means for a session. Never provide your HTTP session middleware where a process runs.
- `requestId` makes a message exactly-once, and starting a key twice does nothing: use them from code that may run twice (a policy, a webhook).
- A session's key is the id of what it works on (the issue, the customer). A policy reaches it with `triage.get(source.id)`: never invent a second key for the same thing.
- Reach a session only from inside the model or from an entry point given the model's Layer: `yield* Triage`, then `get(key)`. Each call goes to the session's own object, and `send` never waits for the model.
- Read what a session does through the model: the process's view (`Api.Triage.watch` for its status, `Api.Triage.events` for its transcript), or a view that lists the process in `from`. `events()` on a hosted session's client is not available outside its object.
- Provide what a session runs on (harness, default model, tools, sandbox) to the process's prose Layer, inside what `Model.layer` takes. The model builds it in each session's object, so a harness is never shared between sessions.
- A method that uses a session requires `RuntimeContext`. A policy's handler already has it. Never capture the context and provide it by hand.
- Never `throw`. A tool fails with its declared `failure` (`Schema.TaggedError`).

More: [Processes](https://alchemy.run/ai/processes), [Processes and Domain models](https://alchemy.run/ai/domain).

## Checklist for a change

1. If the business changes, change the model first, with the `alchemy-domain` skill's checklist.
2. Name the work. Put each process's name and its prose, with a `description`, in `<Name>.process.ts`, and list it in the model's `processes`. Write mentions of the model as thunks, and give the model its members as a thunk.
3. Put each new tool in `<Name>.tool.ts`, with its class and `<Name>Live`. Mention it in the prose that uses it.
4. Mention the Domain commands and views the work needs, through the model. Start each session with `as` if one is behind a middleware.
5. Provide every new Layer to the process's prose, in what `Model.layer` takes: each tool, each model, the harness, and a Layer for each middleware that checks something. A missing one is a type error.
6. If a page shows it, add the command to the page's Api, and show the change at once in the page before the board answers.
7. Run the tests of each layer you touched. Then deploy and send one real message: read the transcript and check that every tool call succeeded, not only that the work finished.

More: [Where sessions run](https://alchemy.run/ai/hosting).
