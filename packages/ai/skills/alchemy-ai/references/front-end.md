# Serving agents to a front end

A page talks to one thing: an Api over the Domain model. So a session's status and transcript have to be in the model. The Durable Object that runs the session records them there, and the page reads them like any view or stream.

For the model's blocks (aggregate, view, stream, projection, Api), use the `alchemy-domain` skill's `references/building-blocks.md`. For the page (client, Commands, Subscriptions, stories, hosting), use its `references/frontend.md`. This file covers only what is specific to sessions.

## Record a session as a command

One command carries a batch: the session's status, its queue and the items it stored. The Schemas are in `@alchemy.run/ai/Session`, which a browser can bundle.

```typescript
// src/Board/RecordActivity.command.ts
export class ActivityRecorded extends Domain.Event("ActivityRecorded", {
  status: Status,
  queued: Schema.Array(QueuedMessage),
  items: Schema.Array(SessionEntry),
}) {}

export class RecordActivity extends Domain.Command("RecordActivity", {
  input: { issueId: IssueId, status: Status, queued: Schema.Array(QueuedMessage), items: Schema.Array(SessionEntry) },
  events: [ActivityRecorded],
  rejects: [],
}) {}
```

Its aggregate keeps the last `seq` recorded and drops items at or below it, so a batch sent twice records nothing twice. Key it like the thing the session works on.

More: [Record what the session does](https://alchemy.run/ai/front-end#record-what-the-session-does).

## Read it as a view and a stream

- The status and the queue are a **view** over `ActivityRecorded`.
- The transcript is a **stream** with one entry per item, appended by a **projection**.
- A list of everything with an agent (the page's sidebar) is a view over both aggregates, kept under one key.

Whole items only: a session reports no token deltas.

More: [Show the status as a view](https://alchemy.run/ai/front-end#show-the-status-as-a-view), [Keep the transcript as a stream](https://alchemy.run/ai/front-end#keep-the-transcript-as-a-stream), [List every issue](https://alchemy.run/ai/front-end#list-every-issue).

## Record from the Durable Object, durably

Read `session.events({ after })` from the last recorded `seq`, batch for 100 ms, and send the command. That loop is in memory and ends when the object is evicted, so pair it with a job on the object's alarm that records what is missing and comes back until the session is idle.

```typescript
const onRecord: Alchemy.Callback<IssueId> = yield* Alchemy.makeCallback(
  "record",
  Effect.fn(function* (issue: IssueId) {
    yield* follow(issue);                              // the live loop, once per instance
    if (!(yield* catchUp(issue))) yield* again(issue); // history after the last seq, then reschedule
  }, Effect.orDie),
);
```

Provide `Cloudflare.DurableObjectCallbacks` to the object's inner Effect. Start recording wherever the object gives the session a message.

More: [Record from the session's object](https://alchemy.run/ai/front-end#record-from-the-sessions-object), [Keep recording through an eviction](https://alchemy.run/ai/front-end#keep-recording-through-an-eviction).

## Two Apis: one verified, one for the page

- The page's Api lists only the commands a person may send (`ReportIssue`, `CommentOnIssue`) and serves every view and stream. Leave out the recording command and the commands only an agent sends.
- Keep the Api you pass to `Verify` to the commands that change the business. Recording is not a business rule, and including it only widens the search.

Acting on a session is a command too: a policy passes it to the session through the model's `Domain.ExternalSystem`. A page never calls `send` or `steer`.

More: [Serve what the front end may use](https://alchemy.run/ai/front-end#serve-what-the-front-end-may-use), [Act on the session with commands](https://alchemy.run/ai/front-end#act-on-the-session-with-commands).

## Build the page so it never waits

Follow the `alchemy-domain` skill's `references/frontend.md` for the client, `DomainFoldkit.make`, and hosting with `Cloudflare.Website.Foldkit`. On top of it, for a page over sessions:

- Keep what was read of each thing the page opened, keyed by its id, and resume each transcript from its own cursor. `toMessage` and `onCaughtUp` receive the key they are for.
- Show a new issue or a reply the moment it is submitted, in a `pending` list. Drop it when the board's copy arrives (the item in the transcript), and take it back with its words when the command fails.
- While something the page sent is pending, show the agent as working, whatever status last arrived. The status and the transcript are two reads and arrive in either order.
- Keep the open thing in the address, so a refresh or a shared link opens it again.

More: [Read it in a Foldkit app](https://alchemy.run/ai/front-end#read-it-in-a-foldkit-app), [Optimistic updates](https://alchemy.run/domain/optimistic-updates).

## Without a Domain model

An app with no model serves a session over its own Effect RPC group from a `Cloudflare.RpcDurableObject`, using the same Schemas, and reads it with `RpcWebSocketClient.layer`.

More: [Without a Domain model](https://alchemy.run/ai/front-end#without-a-domain-model).
