import * as Azure from "@alchemy.run/azure";
import * as Workflows from "alchemy/Workflows";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Approval, PlaceOrder } from "./orders.ts";
import { LOCATION, OrderWorkflows } from "./OrderWorkflows.ts";

/**
 * - `POST /orders/:orderId?quantity=n` starts an order run
 * - `GET /runs/:executionId` reads it
 * - `POST /runs/:executionId/approve?by=name` approves it
 * - `POST /runs/:executionId/cancel` interrupts it
 */
export default class Api extends Azure.Functions.Function<Api>()(
  "Api",
  { main: import.meta.url, location: LOCATION },
  Effect.gen(function* () {
    const orders = yield* Workflows.RunWorkflow(PlaceOrder);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://api");
        const [, collection, id, action] = url.pathname.split("/");
        if (collection === "orders" && id && request.method === "POST") {
          const run = yield* orders.start({
            orderId: id,
            quantity: Number(url.searchParams.get("quantity") ?? "1"),
          });
          return yield* HttpServerResponse.json({ executionId: run.executionId }, { status: 202 });
        }
        if (collection === "runs" && id) {
          const run = orders.get(id);
          if (action === "approve" && request.method === "POST") {
            yield* run.signal(Approval, url.searchParams.get("by") ?? "anonymous");
            return HttpServerResponse.text("approved", { status: 202 });
          }
          if (action === "cancel" && request.method === "POST") {
            yield* run.interrupt;
            return HttpServerResponse.text("cancelling", { status: 202 });
          }
          return yield* HttpServerResponse.json(yield* run.status);
        }
        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(Azure.Functions.DurableEngine(OrderWorkflows))),
) {}
