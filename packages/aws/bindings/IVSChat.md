<!-- Docs for the generated AWS.IVSChat bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## DeleteMessage

Moderate the bound room by deleting a message — the effectful call made
from a deployed Lambda or Task. It broadcasts a `DELETEMESSAGE` event to
every connected client, directing them to remove the message (`id` is the
ID from the WebSocket `SendMessage` response); an optional `reason` is
attached to the event.

### Moderating Messages
Provide the `DeleteMessageHttp` implementation layer on the Function
effect, bind the room in the init phase, then call the returned client at
runtime. The binding grants `ivschat:DeleteMessage` on the room and
injects its ARN as the `roomIdentifier` automatically.

**Example:** Delete a message from a Lambda
```typescript
// init
const room = yield* IVSChat.Room("LiveChat");
const deleteMessage = yield* IVSChat.DeleteMessage(room);

return {
  fetch: Effect.gen(function* () {
    // runtime
    const { id } = yield* deleteMessage({
      id: flaggedMessageId,
      reason: "abusive content",
    });
    return HttpServerResponse.json({ deleted: id });
  }),
};
// on the Function effect:
// .pipe(Effect.provide(IVSChat.DeleteMessageHttp))
```

@binding

## DeleteMessage.Request

The `roomIdentifier` is injected by the binding from the bound room;
the caller supplies the target message `id` and an optional `reason`.

## DisconnectUser

Moderate the bound room by disconnecting all WebSocket connections of a
user — the effectful call made from a deployed Lambda or Task. The
`userId` is the one the user's chat token was minted with; disconnection
does not prevent reconnection, so revoke by not minting further tokens.
The call succeeds even when the user has no open connections.

### Moderating Users
Provide the `DisconnectUserHttp` implementation layer on the Function
effect, bind the room in the init phase, then call the returned client at
runtime. The binding grants `ivschat:DisconnectUser` on the room and
injects its ARN as the `roomIdentifier` automatically.

**Example:** Disconnect a user from a Lambda
```typescript
// init
const room = yield* IVSChat.Room("LiveChat");
const disconnectUser = yield* IVSChat.DisconnectUser(room);

return {
  fetch: Effect.gen(function* () {
    // runtime
    yield* disconnectUser({ userId: "user-123", reason: "spam" });
    return HttpServerResponse.json({ ok: true });
  }),
};
// on the Function effect:
// .pipe(Effect.provide(IVSChat.DisconnectUserHttp))
```

@binding

## DisconnectUser.Request

The `roomIdentifier` is injected by the binding from the bound room;
the caller supplies the target `userId` (accepted as a plain string or a
`Redacted` value) and an optional `reason`.

## SendEvent

Send an application-defined event to every client connected to the bound
room — the effectful call made from a deployed Lambda or Task. Use it to
broadcast state changes (poll results, stream metadata, moderation
notices) alongside user chat messages; `attributes` carries the payload
as string key-value pairs.

### Broadcasting Events
Provide the `SendEventHttp` implementation layer on the Function effect,
bind the room in the init phase, then call the returned client at
runtime. The binding grants `ivschat:SendEvent` on the room and injects
its ARN as the `roomIdentifier` automatically.

**Example:** Broadcast from a Lambda
```typescript
// init
const room = yield* IVSChat.Room("LiveChat");
const sendEvent = yield* IVSChat.SendEvent(room);

return {
  fetch: Effect.gen(function* () {
    // runtime
    const { id } = yield* sendEvent({
      eventName: "app:poll-result",
      attributes: { question: "q1", winner: "option-b" },
    });
    return HttpServerResponse.json({ id });
  }),
};
// on the Function effect:
// .pipe(Effect.provide(IVSChat.SendEventHttp))
```

@binding

## SendEvent.Request

The `roomIdentifier` is injected by the binding from the bound room;
the caller supplies the event name and optional attributes.
