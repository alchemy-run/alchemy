import * as Domain from "@alchemy.run/domain";
import { BrowserHost } from "@effect/ui/html";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Socket from "effect/socket/Socket";
import { NotesApi } from "../NotesApi.api.ts";
import { UserId } from "../User.id.ts";
import { auth, callAuth } from "./auth.ts";
import { NotesApp } from "./Notes.ts";

// The session cookie is first-party, so every call and watch on /api carries it.
const NotesConnection = NotesApi.layerClient.pipe(
  Layer.provide(Domain.protocolWebSocket(`${location.origin}/api`)),
  Layer.provide(Layer.mergeAll(FetchHttpClient.layer, Socket.layerWebSocketConstructorGlobal)),
);

// Who better-auth says is signed in, before the app mounts. If better-auth can't
// say, the app doesn't start: it fails with AuthFailed.
const Main = Layer.unwrap(
  callAuth(() => auth.getSession()).pipe(
    Effect.map((data) =>
      BrowserHost.mount(
        NotesApp,
        { user: data ? { userId: UserId.make(data.user.id), name: data.user.name } : null },
        document.getElementById("root")!,
      ),
    ),
  ),
).pipe(Layer.provide(NotesConnection));

Layer.launch(Main).pipe(Effect.runFork);
