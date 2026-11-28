# Serving agents to a front end

A page talks to two things: an Api over the Domain model, for commands and the board's views, and a route the Worker serves from the session, for the agent's status and transcript. Domain knows nothing of a session, so the model never holds either.

For the model's blocks (aggregate, view, stream, projection, Api), use the `alchemy-domain` skill's `references/building-blocks.md`. For the page (client, Commands, Subscriptions, stories, hosting), use its `references/frontend/` files. This file covers only what is specific to sessions.

## Read a session from the Worker

The session's client reads it from outside its object: `status` is `{ status, queued }`, and `history({ after, take })` is the items stored after `after`. Serve both on one route, keyed like the session (the id of what it works on), and give the answer one Schema that the page decodes with.

```typescript
// src/SessionRead.ts
export const SessionRead = Schema.Struct({ ...SessionState.fields, ...SessionPage.fields });

// src/Worker.ts
const session = triage.get(number);
const after = Number(url.searchParams.get("after") ?? 0);
const read: SessionRead = {
  ...(yield* session.status),
  ...(yield* session.history({ after, take: 100 })),
};
return yield* HttpServerResponse.json(read);
```

The page polls it with the `seq` of the last item it has, so each answer holds only what is new. The value Schemas (`SessionState`, `SessionPage`, `SessionEntry`, `QueuedMessage`) are in `@alchemy.run/ai/Session`; a browser can bundle them. In the page, make the read a service (`Sessions`) so a test can give the session itself in place of the network.

Whole items only: a session reports no token deltas. A hosted session's live `events()` stay in its object.

More: [Read a session from the Worker](https://alchemy.run/ai/front-end#read-a-session-from-the-worker), [Read a session from outside](https://alchemy.run/ai/hosting#read-a-session-from-outside).

## Two Apis: one verified, one for the page

- The page's Api lists only the commands a person may send (`ReportIssue`, `CommentOnIssue`) and serves every view. Leave out the commands only an agent sends.
- Keep the Api you pass to `Verify` to the commands that change the business.

Acting on a session is a command too: a policy passes it to the session with the process's client. A page never calls `send` or `steer`.

More: [Serve what the front end may use](https://alchemy.run/ai/front-end#serve-what-the-front-end-may-use), [Act on the session with commands](https://alchemy.run/ai/front-end#act-on-the-session-with-commands).

## Build the page so it never waits

Follow the `alchemy-domain` skill's `references/frontend/foldkit.md` for the client, `DomainFoldkit.make`, and hosting with `Cloudflare.Website.Foldkit`. On top of it, for a page over sessions:

- Keep what was read of each thing the page opened, keyed by its id, and resume each transcript from the `seq` of its last item.
- Show a new issue or a reply the moment it is submitted, in a `pending` list. Drop it when the board's copy arrives (the item in the transcript), and take it back with its words when the command fails.
- While something the page sent is pending, show the agent as working, whatever status last arrived: a command reaches the session a moment after the page sends it.
- Keep the open thing in the address, so a refresh or a shared link opens it again.

More: [Read it in a Foldkit app](https://alchemy.run/ai/front-end#read-it-in-a-foldkit-app), [Optimistic updates](https://alchemy.run/domain/optimistic-updates).

## Push instead of poll

To push a session's events as they happen, serve the session over your own Effect RPC group from a `Cloudflare.RpcDurableObject` that yields the process, using the same Schemas, and read it with `RpcWebSocketClient.layer`.

More: [Or serve the session over RPC](https://alchemy.run/ai/front-end#or-serve-the-session-over-rpc).
