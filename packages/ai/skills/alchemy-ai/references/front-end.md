# Serving agents to a front end

A page talks to one thing: an Api over the Domain model. The model records each process it lists as a view named after it, so a session's status and transcript are already in the model, and the page reads them like any view.

For the model's blocks (aggregate, view, stream, projection, Api), use the `alchemy-domain` skill's `references/building-blocks.md`. For the page (client, Commands, Subscriptions, stories, hosting), use its `references/frontend.md`. This file covers only what is specific to sessions.

## Follow a session through the process's view

Listing `Triage` in `processes` is all the recording there is. The model keeps a view named `Triage`, keyed by the session, so key sessions like the thing they work on. Its state is `{ status, queued }`; each event, `TriageActivity`, is a batch: the status, the queue and the items stored since the last one. The session's object sends each batch, the model drops items it already has, and a job on the object's alarm keeps it recording through an eviction.

A page reads it with `BoardClient.Triage.watch` (the status) and `BoardClient.Triage.events` (the transcript, resumed from a cursor). The value Schemas (`SessionEntry`, `QueuedMessage`, `SessionStatus`) are in `@alchemy.run/ai/Session`; a browser can bundle them.

A list of everything with an agent (the page's sidebar) is a view that lists the process in `from` beside the aggregates, kept under one key. It is a thunk, `Domain.View("IssueList", () => ({ from: [Issue, Triage], ... }))`, because the process's prose mentions the model that lists the view.

Whole items only: a session reports no token deltas.

More: [Follow the session through the model](https://alchemy.run/ai/front-end#follow-the-session-through-the-model), [List every issue](https://alchemy.run/ai/front-end#list-every-issue).

## Two Apis: one verified, one for the page

- The page's Api lists only the commands a person may send (`ReportIssue`, `CommentOnIssue`) and serves every view, the process's among them. Leave out the commands only an agent sends; the recording command belongs to no Api.
- Keep the Api you pass to `Verify` to the commands that change the business.

Acting on a session is a command too: a policy passes it to the session with the process's client. A page never calls `send` or `steer`.

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
