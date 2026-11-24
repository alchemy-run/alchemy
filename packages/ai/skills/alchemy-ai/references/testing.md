# Testing an app with agents

Test each layer where it is cheapest, and the whole thing once.

## The model

Stories for behaviour and `Verify` for the rules no command may break, from the `alchemy-domain` skill's `references/testing.md`. Stub the external system that asks for work: the rules must hold whatever a session does.

```typescript
const story = Story.make(Board, { layer: BoardHandlers, stub: [Triager] });
```

More: [Prove what a session can't break](https://alchemy.run/ai/domain#prove-what-a-session-cant-break), [Verifying models](https://alchemy.run/domain/verifying-models).

## The page

Foldkit stories for `update`: what each click sends, what is on screen before the board answers, and what happens when the board refuses.

More: [Integrate with Foldkit: Test and host the app](https://alchemy.run/domain/foldkit#test-and-host-the-app).

## The page with the board, in memory

Run the page's own `init`, `update`, Commands and Subscriptions against the model in memory (`Api.layerClientInProcess` over `Domain.InMemory`), with a stand-in for the agent that sends the recording command as the Durable Object would. No browser and no deploy.

More: [Test the page with the board](https://alchemy.run/ai/front-end#test-the-page-with-the-board).

## Tools, without a model

Call each tool with the arguments a model really sends, against real files: `null` for a parameter left out, a path under `~`, a path that is not there. A model sends `null` for an optional parameter, and a path given as an argument is not expanded by a shell.

More: [Declare a tool](https://alchemy.run/ai/tools#declare-a-tool).

## The deployed app

Deploy the stack and drive it with the same page runner over real WebSockets, with the real agent. Assert on the steps, not only the outcome: that no tool call came back as arguments that did not decode, and that searches did not fail. A model that fails every tool call can still finish the work.

More: [Deploy the page with the board](https://alchemy.run/ai/front-end#deploy-the-page-with-the-board).
