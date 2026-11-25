# Testing an app with agents

Test each layer where it is cheapest, and the whole thing once.

## The model

Stories for behaviour and `Verify` for the rules no command may break, from the `alchemy-domain` skill's `references/testing.md`. Play each process the model lists with `AI.scripted`. One that does nothing is enough for `Verify`: the rules must hold whatever a session does, and the prover sends a session's commands itself.

```typescript
const TriageIdle = AI.scripted(Triage, Effect.succeed(() => Effect.succeed("")));
const story = Story.make(Board, { layer: Layer.mergeAll(IssueWorkLive, TriageIdle) });
```

More: [Prove what a session can't break](https://alchemy.run/ai/domain#prove-what-a-session-cant-break), [Verifying models](https://alchemy.run/domain/verifying-models).

## The page

Foldkit stories for `update`: what each click sends, what is on screen before the board answers, and what happens when the board refuses.

More: [Integrate with Foldkit: Test and host the app](https://alchemy.run/domain/foldkit#test-and-host-the-app).

## The page with the board, in memory

Run the page's own `init`, `update`, Commands and Subscriptions against the model in memory (`Api.layerClientInProcess` over `Domain.InMemory`), with `AI.scripted` playing the process: it does in code what a session would have done with its tools, and the model records it as it records a real one. No browser, no deploy and no model.

More: [Test the page with the board](https://alchemy.run/ai/front-end#test-the-page-with-the-board).

## Tools, without a model

Call each tool with the arguments a model really sends, against real files: `null` for a parameter left out, a path under `~`, a path that is not there. A model sends `null` for an optional parameter, and a path given as an argument is not expanded by a shell.

More: [Declare a tool](https://alchemy.run/ai/tools#declare-a-tool).

## The deployed app

Deploy the stack and drive it with the same page runner over real WebSockets, with the real agent. Assert on the steps, not only the outcome: that no tool call came back as arguments that did not decode, and that searches did not fail. A model that fails every tool call can still finish the work.

More: [Deploy the page with the board](https://alchemy.run/ai/front-end#deploy-the-page-with-the-board).
