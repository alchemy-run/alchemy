# Layout

## One file per declaration

```text
src/
  Agents.ts               the Durable Object that runs sessions
  Answering.process.ts
  Models.ts               every AI.Model, and the Layers behind them
  PostAnswer.tool.ts      the tool's class and PostAnswerLive
  Sandbox.ts              the AI.Sandboxes Layer
  SearchIssues.tool.ts
  Triage.process.ts       the process
  Worker.ts
```

Never a `tools.ts`. An MCP server is `<Name>.mcp.ts`.

More: [Name a file after what it declares and its kind](https://alchemy.run/ai/project-layout#name-a-file-after-what-it-declares-and-its-kind).

## With a Domain model

The model's files follow the Domain layout, in a folder or package of their own: see the `alchemy-domain` skill's `references/layout.md` for its rules. Processes and tools sit outside it.

```text
src/
  Board/
    Board.model.ts
    Issue.aggregate.ts
    IssueWork.policy.ts
    LabelIssue.command.ts
    Triager.external.ts   what the board asks of whatever does the work
  Agents.ts
  PostAnswer.tool.ts
  Triage.process.ts
```

More: [With a Domain model](https://alchemy.run/ai/project-layout#with-a-domain-model), [Domain project layout](https://alchemy.run/domain/project-layout).

## With a front end

The session is part of the model, so its files sit with the model's. The page is in `web/`, and its tests beside the model's.

```text
src/
  Board/
    Board.model.ts
    BoardApi.api.ts             what changes an issue: verified
    WebApi.api.ts               what a page may send and read
    IssueSession.aggregate.ts   what was recorded of an issue's session
    RecordActivity.command.ts   a batch of what the session reported
    SessionStatus.view.ts       idle or working, and the queue
    Transcript.stream.ts        one entry per item
    Transcripts.projection.ts   appends each recorded item
    IssueList.view.ts           every issue, for the page's list
    Handlers.ts                 every handler Layer the model needs, merged
  Agents.ts                     runs the session, and records it
  Worker.ts                     serves WebApi at /api
web/
  index.html
  vite.config.ts
  src/
    Board.ts                    Model, Message, update, Commands, Subscriptions
    View.ts                     the page's HTML
    Location.ts                 which issue the address names
    entry.ts                    the Api client, and Runtime.run
    worker.ts                   serves the build, forwards /api to the board
test/
  Board.verify.test.ts          the model's rules
  Board.story.test.ts           the page's update
  App.ts                        runs the page without a browser
  App.test.ts                   the page with the board, in memory
  integ.test.ts                 the page with the deployed app
alchemy.run.ts                  the Worker, and Cloudflare.Website.Foldkit for web/
```

A larger app splits these into the `domain`, `server` and `web` packages of the `alchemy-domain` skill's layout. `Agents.ts`, the processes and the tools go in `server`.

More: [With a front end](https://alchemy.run/ai/project-layout#with-a-front-end), [Connect a front end](https://alchemy.run/ai/front-end), [Domain project layout: Keep the model in its own package](https://alchemy.run/domain/project-layout#keep-the-model-in-its-own-package).
