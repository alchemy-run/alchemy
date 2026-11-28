/**
 * A second Domain model on the conformance suite's pool, so each runner
 * hosts two models (two `layerEntities`), as an app with more than one
 * bounded context does.
 */
import * as Domain from "@alchemy.run/domain";
import * as DomainCluster from "@alchemy.run/domain/EffectCluster";
import * as Cluster from "@alchemy.run/effect-cluster";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { DomainPool } from "./cluster.ts";

export class Ticked extends Domain.Event("Ticked", {}) {}

export class Tick extends Domain.Command("Tick", {
  input: { id: Schema.String },
  events: [Ticked],
}) {}

export class Ticker extends Domain.Aggregate("Ticker", {
  id: Schema.String,
  state: Schema.Struct({ count: Schema.Int }),
  initial: { count: 0 },
  commands: [Tick],
  keyOf: (command) => command.id,
  decide: { Tick: () => [new Ticked({})] },
  evolve: { Ticked: (state) => ({ count: state.count + 1 }) },
}) {}

export class Tickers extends Domain.Model("Tickers", { aggregates: [Ticker] }) {}

export default Tickers.layer(Layer.empty).pipe(
  Layer.provide(DomainCluster.layerObjects()),
  Layer.provide(
    Cluster.layerObjectHost("DomainTickers", { main: import.meta.url, pool: DomainPool }),
  ),
);

/**
 * The front's `fetch` with the tickers' route in front of `fetch`:
 * `/tick/:id` sends `Tick`, and answers `{ version }`.
 */
export const withTickRoute = Effect.fn(function* <E, R>(
  fetch: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) {
  const tickers = yield* Ticker;
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    const [, action, raw] = new URL(request.url, "http://front").pathname.split("/");
    if (action !== "tick") return yield* fetch;
    const receipt = yield* tickers.send(new Tick({ id: decodeURIComponent(raw ?? "") }));
    return yield* HttpServerResponse.json({ version: receipt.version });
  });
});
