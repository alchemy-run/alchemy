import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import { Account, Deposit, Deposits } from "../catch-up/ledger.ts";
export { hosted } from "../catch-up/worker.ts";

/** The benchmark's first deploy: accounts only. */
export class Before extends Domain.Model("Ledger", { aggregates: [Account] }) {}

/** The benchmark's second deploy adds one view, keyed by account: one consumer key per instance. */
export class After extends Domain.Model("Ledger", { aggregates: [Account], views: [Deposits] }) {}

/**
 * The benchmark Worker's routes: `POST /seed/<from>/<count>/<events>` writes
 * `events` deposits to each of accounts `b<from>` to `b<from + count - 1>`;
 * `GET /account/<account>`, `GET /deposits/<account>`, `GET /history` and `GET /version`.
 */
export const benchWorker = (version: string, view?: typeof Deposits) =>
  Effect.gen(function* () {
    const accounts = yield* Account;
    const deposits = view ? yield* view : undefined;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://localhost").pathname.split("/");
        if (path[1] === "version") return HttpServerResponse.text(version);
        if (path[1] === "deposits" && deposits) {
          const state = yield* deposits.query(Account.ref(path[2]!));
          return yield* HttpServerResponse.json(Option.getOrNull(state));
        }
        if (path[1] === "account") {
          return yield* HttpServerResponse.json(yield* accounts.state(path[2]!));
        }
        if (path[1] === "history" && deposits) {
          return yield* HttpServerResponse.json(yield* deposits.history);
        }
        if (path[1] !== "seed") return HttpServerResponse.text("Not Found", { status: 404 });
        const [from, count, events] = path.slice(2, 5).map(Number) as [number, number, number];
        yield* Effect.forEach(
          Array.from({ length: count }, (_, i) => `b${from + i}`),
          (account) =>
            Effect.forEach(
              Array.from({ length: events }, (_, n) => n + 1),
              // Idempotent: a retried seed request doesn't deposit twice.
              (amount) =>
                accounts.send(account, new Deposit({ amount }), {
                  commandId: `seed-${account}-${amount}`,
                }),
              { discard: true },
            ),
          { concurrency: 50, discard: true },
        );
        return HttpServerResponse.text("ok");
      }).pipe(
        Effect.catchTag("ConsistencyTimeout", () =>
          Effect.succeed(HttpServerResponse.text("not caught up", { status: 503 })),
        ),
      ),
    };
  });
