import * as Domain from "@alchemy.run/domain";
import * as DomainEffectUI from "@alchemy.run/domain/EffectUI";
import { CustomerId } from "@bank/domain/Customer/Customer.id";
import { CustomerApi } from "@bank/domain/CustomerApi.api";
import { BrowserHost } from "@effect/ui/html";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as OtlpSerialization from "effect/observability/OtlpSerialization";
import * as OtlpTracer from "effect/observability/OtlpTracer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import { Bank, Intent, intentsKey } from "./Bank.ts";

/**
 * The signed-in customer. A demo stand-in for a login: `?customer=c-2` picks
 * who you are, defaulting to `c-1`.
 */
const signedIn = Effect.sync(() =>
  CustomerId.make(new URLSearchParams(location.search).get("customer") ?? "c-1"),
);

/** Intents an earlier page load could not deliver. Anything unreadable is dropped. */
const savedIntents = (customerId: CustomerId) =>
  Effect.sync(() =>
    Option.getOrElse(
      Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Intent)))(
        localStorage.getItem(intentsKey(customerId)) ?? "[]",
      ),
      () => [],
    ),
  );

/** Sign in: the Api sets an `HttpOnly` session cookie on this origin. */
const signIn = Effect.fn(function* (customerId: CustomerId) {
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
  yield* client.execute(
    HttpClientRequest.post("/api/session").pipe(HttpClientRequest.bodyJsonUnsafe({ customerId })),
  );
});

/**
 * The bank Api for the life of the app, on this origin, so the browser sends
 * the session cookie with every call and every watch. Commands go over HTTP;
 * each watch is a WebSocket to the Durable Object that owns what it reads,
 * which pushes every change.
 */
const BankConnection = CustomerApi.layerClient.pipe(
  Layer.provide(Domain.protocolWebSocket(`${location.origin}/api`)),
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
);

/**
 * The app's spans, exported to its own origin, where the bank Worker relays
 * them on. Effect UI traces every Command, and each Api call carries the
 * trace on, so a click and everything it causes on the server is one trace.
 */
const Tracing = OtlpTracer.layer({
  url: `${location.origin}/api/telemetry/v1/traces`,
  resource: { serviceName: "bank-web" },
}).pipe(Layer.provide(OtlpSerialization.layerJson));

/** A demo MFA code on every withdrawal, read when the command runs. */
const Headers = Layer.succeed(DomainEffectUI.CommandHeaders, {
  get: (command) => Effect.succeed(command === "WithdrawMoney" ? { "x-mfa-code": "000000" } : {}),
});

const Main = Layer.unwrap(
  Effect.gen(function* () {
    const customerId = yield* signedIn;
    // The app cannot run signed out.
    yield* signIn(customerId).pipe(Effect.orDie);
    return BrowserHost.mount(
      Bank,
      {
        customerId,
        // Names this page's commands, so each is unique even across reloads.
        session: crypto.randomUUID(),
        online: navigator.onLine,
        intents: yield* savedIntents(customerId),
      },
      document.getElementById("root")!,
    );
  }),
).pipe(
  Layer.provide(Layer.mergeAll(BankConnection, Tracing, Headers)),
  Layer.provide(FetchHttpClient.layer),
);

Layer.launch(Main).pipe(Effect.runFork);
