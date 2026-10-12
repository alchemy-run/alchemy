import { Api } from "alchemy/Fold";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import { CustomerApi } from "./src/CustomerApi/CustomerApi.ts";
import { sessionClient } from "./src/Session.ts";
import { register } from "./test/flows.ts";

const as = (token: string) =>
  Layer.mergeAll(Api.protocolWebSocket("http://localhost:1337/api"), sessionClient(token)).pipe(
    Layer.provide(Layer.mergeAll(FetchHttpClient.layer, Socket.layerWebSocketConstructorGlobal)),
  );
const id = `ws-${Date.now() % 100000}`;

const program = Effect.gen(function* () {
  const bank = yield* CustomerApi.client.pipe(Effect.provide(as(`customer:${id}`)));
  const accountId = yield* register(bank, id, "ws");
  const watching = yield* bank.AccountSummary.watch(accountId).pipe(
    Stream.tap((s) => Effect.log("pushed balance", s?.balance)),
    Stream.take(3),
    Stream.runCollect,
    Effect.forkChild,
  );
  yield* Effect.sleep("500 millis");
  yield* bank.DepositMoney({ target: accountId, amount: 100 });
  yield* bank.DepositMoney({ target: accountId, amount: 50 });
  const seen = yield* Fiber.join(watching).pipe(Effect.timeout("10 seconds"));
  console.log("watch", JSON.stringify(seen.map((s) => s?.balance)));

  const events = yield* bank.Statement.events(accountId).pipe(
    Stream.take(2),
    Stream.runCollect,
    Effect.timeout("10 seconds"),
  );
  console.log("events", JSON.stringify(events.map((e) => [e.event.kind, e.event.balance])));

  const stranger = yield* CustomerApi.client.pipe(Effect.provide(as("customer:someone-else")));
  const refused = yield* stranger.AccountSummary.watch(accountId).pipe(
    Stream.runCollect,
    Effect.flip,
    Effect.timeout("10 seconds"),
  );
  console.log("stranger", refused._tag);

  const anonymous = yield* CustomerApi.client.pipe(Effect.provide(as("nobody")));
  const unauthorized = yield* anonymous.AccountSummary.watch(accountId).pipe(
    Stream.runCollect,
    Effect.flip,
    Effect.timeout("10 seconds"),
  );
  console.log("anonymous", unauthorized._tag);
});

Effect.runPromise(program.pipe(Effect.scoped)).then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
