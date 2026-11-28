# Layout

## One file per declaration

```text
src/
  Answering.process.ts    a process a session follows: prose on the class
  Models.ts               every AI.Model, and the Layers behind them
  PostAnswer.tool.ts      the tool's class and PostAnswerLive
  Sandbox.ts              the AI.Sandboxes Layer
  SearchIssues.tool.ts
  Worker.ts               the entry point, and the Layers that say where it all runs
```

Never a `tools.ts`. An MCP server is `<Name>.mcp.ts`.

More: [Name a file after what it declares and its kind](https://alchemy.run/ai/project-layout#name-a-file-after-what-it-declares-and-its-kind).

## With a Domain model

The model's files follow the Domain layout, in a folder or package of their own: see the `alchemy-domain` skill's `references/layout.md` for its rules. A process is not one of its files: it can work with several models, so it sits beside the tools. When its prose mentions a model whose policy holds it, the mentions are thunks.

```text
src/
  Board/
    Board.model.ts
    Issue.aggregate.ts
    IssueWork.policy.ts   holds the process's client: yield* Triage
    LabelIssue.command.ts
  PostAnswer.tool.ts
  Triage.process.ts       the name, and TriageLive: what a session is told, and what it mentions
  Worker.ts
```

There is no file for a Durable Object: the model's platform Layer declares one class for each member, and `AICloudflare.layerDurableObjects` one for each process.

More: [With a Domain model](https://alchemy.run/ai/project-layout#with-a-domain-model), [Domain project layout](https://alchemy.run/domain/project-layout).

## With a front end

A page reads a session through a route the Worker serves from the session itself: no file records a session. The page is in `web/`, and its tests beside the model's.

```text
src/
  Board/
    Board.model.ts
    BoardApi.api.ts             what changes an issue: verified
    WebApi.api.ts               what a page may send and read
    IssueList.view.ts           every issue, for the page's list
  SessionRead.ts                what the page reads of a session: one Schema
  Triage.process.ts
  Worker.ts                     serves WebApi at /api and a session at /sessions/<key>
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

A larger app splits these into the `domain`, `server` and `web` packages of the `alchemy-domain` skill's layout. The tools, the prose and the Layers go in `server`; a process's name goes in `domain`, beside the models whose policies hold it.

More: [With a front end](https://alchemy.run/ai/project-layout#with-a-front-end), [Connect a front end](https://alchemy.run/ai/front-end), [Domain project layout: Keep the model in its own package](https://alchemy.run/domain/project-layout#keep-the-model-in-its-own-package).
