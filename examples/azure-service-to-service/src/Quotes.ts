import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Environment, LOCATION } from "./resources.ts";

const QUOTES = [
  "Simplicity is prerequisite for reliability. — Edsger W. Dijkstra",
  "Make it work, make it right, make it fast. — Kent Beck",
  "Programs must be written for people to read. — Harold Abelson",
];

/**
 * A private backend on Azure Container Apps.
 *
 * The class is a tag, and {@link QuotesLive} below is its implementation.
 * The Gateway yields the tag to read Quotes' URL; with the tag, the
 * Gateway's bundle gets a reference to Quotes and never runs its program.
 *
 * - `GET /quote` returns a quote, picked by the optional `?n=` index, and
 *   the caller's Entra object ID.
 *
 * Built-in authentication (see `QuotesAuth` in `alchemy.run.ts`) rejects
 * every request without a valid Entra token before it reaches the
 * container, and sets `x-ms-client-principal-id` on the ones it lets in.
 */
export class Quotes extends Azure.ContainerApps.ContainerApp<Quotes>()("Quotes") {}

const QuotesLive = Quotes.make(
  Effect.gen(function* () {
    const environment = yield* Environment;
    return {
      main: import.meta.url,
      location: LOCATION,
      environmentId: environment.environmentId,
      cpu: 0.25,
      memory: "0.5Gi",
      // Scale to zero between requests; HTTP traffic wakes it up.
      template: { scale: { minReplicas: 0, maxReplicas: 1 } },
    };
  }),
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");

        if (request.method === "GET" && url.pathname === "/quote") {
          const n = Number(url.searchParams.get("n") ?? "0");
          const index = Number.isInteger(n) && n >= 0 ? n % QUOTES.length : 0;
          return yield* HttpServerResponse.json({
            index,
            quote: QUOTES[index],
            servedBy: "quotes",
            caller: request.headers["x-ms-client-principal-id"] ?? null,
          });
        }

        return yield* HttpServerResponse.json({ error: "not found" }, { status: 404 });
      }),
    };
  }),
);

export default QuotesLive;
