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
  Triage.process.ts       the process and the inputs it mentions
  Worker.ts
```

Never a `tools.ts`. An MCP server is `<Name>.mcp.ts`.

More: [Name a file after what it declares and its kind](https://alchemy.run/ai/project-layout#name-a-file-after-what-it-declares-and-its-kind).

## With a Domain model

The model's files follow the Domain layout, in a folder or package of their own. Processes and tools sit outside it.

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

More: [With a Domain model](https://alchemy.run/ai/project-layout#with-a-domain-model).
