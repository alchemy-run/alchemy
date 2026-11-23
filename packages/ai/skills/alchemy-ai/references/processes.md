# Processes

## A process

Prose on a class. Mention what the prose refers to.

```typescript
// src/Research.process.ts
import * as AI from "@alchemy.run/ai";
import * as Schema from "effect/Schema";

export const question = AI.Input("question", Schema.String);

export class Research extends AI.Process<Research>()("Research", {
  description: "Answer one question about the code, with file paths.",
})`
  Answer ${question} about the repository in your working directory.
  Search with ${AI.Grep} and open what looks relevant with ${AI.Read}.
  Reply with file paths and line numbers. Never edit files.
` {}
```

A mention can be a tool, a coding tool, an MCP server, `AI.CodeMode(...)`, a model, an input, another process, `AI.Self`, or a Domain model's command, aggregate or view.

More: [Declare a process](https://alchemy.run/ai/processes#declare-a-process), [Mention a tool](https://alchemy.run/ai/processes#mention-a-tool).

## Inputs

`AI.Input(name, schema)`. Mentioning one adds it to what `start` takes. The model reads the name in the prose and the value in its first message.

```typescript
const research = yield* Research;
yield* research.start("parser", { question: "Where is the parser?" });
```

More: [Take an input](https://alchemy.run/ai/processes#take-an-input).

## Sessions

```typescript
const session = research.get("parser");

const reply = yield* session.prompt("Which file first?"); // waits; reply.text
yield* session.send("Also check the tests.", { requestId: "comment-812" }); // returns at once
yield* session.wait; // until it has nothing left to run
const transcript = yield* session.messages;
yield* session.abort;
```

A process with inputs, or one that acts as someone, must be started first: until then `send` and `prompt` fail with `NotStarted`. A process with neither needs no `start`.

More: [Start a session](https://alchemy.run/ai/processes#start-a-session), [Talk to a session](https://alchemy.run/ai/processes#talk-to-a-session).

## Follow a process (a skill)

Mention a process and tell the model to follow it. Its prose is read only then; its tools are the session's from the start.

```typescript
// src/Releasing.process.ts
export class Releasing extends AI.Process<Releasing>()("Releasing", {
  description: "How to cut a release of this project. Follow it when asked to ship.",
})`
  Call ${RunTests} and stop if anything fails. Then tag the commit with ${AI.Bash}.
` {}
```

```typescript
`When asked to ship, follow ${Releasing}.`
```

More: [Follow a process](https://alchemy.run/ai/process-graphs#follow-a-process).

## Start a process (a subagent)

Mention a process and tell the model to start one. It gets its own conversation and returns nothing: give both the same place to report.

```typescript
`Before changing anything, start a ${Research} on ${Fast} for each thing you need to know.`
`If the question is too broad, start a ${AI.Self} for each part.`
```

More: [Start a process](https://alchemy.run/ai/process-graphs#start-a-process), [Hear back from a started session](https://alchemy.run/ai/process-graphs#hear-back-from-a-started-session).

## A name and inputs, with the prose in a Layer

Use this when code should depend on the process without its prose, or when there is more than one way to carry it out.

```typescript
// src/Triage.process.ts
export const issue = AI.Input("issue", Schema.Number);

export class Triage extends AI.Process<Triage>()("Triage", { inputs: [issue] }) {}

export const TriageLive = Triage.toLayer({
  description: "Say what kind of issue this is.",
})`
  Read issue ${issue} with ${AI.Grep} and ${AI.Read}. Reply with one word.
`;
```

A tagged process that mentions Domain commands behind a middleware lists what its sessions act as: `{ inputs: [issue], as: [CurrentActor] }`.

More: [Separate the name from the prose](https://alchemy.run/ai/processes#separate-the-name-from-the-prose).
