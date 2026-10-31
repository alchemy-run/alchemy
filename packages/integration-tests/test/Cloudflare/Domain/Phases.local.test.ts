import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { requestWorker } from "../Utils/WorkerRequest.ts";
import DomainPhasesWorker from "./fixtures/phases-worker.ts";

const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

class TicketRequestFailed extends Data.TaggedError("TicketRequestFailed")<{
  readonly status: number;
}> {}

/** Call a ticket route; right after a deploy, retry until the Worker serves it. */
const call = (url: string, action: "open" | "close", id: string) =>
  requestWorker(
    HttpClientRequest.post(`${url}/${action}/${id}`).pipe(
      HttpClientRequest.setHeader("connection", "close"),
    ),
  ).pipe(
    Effect.filterOrFail(
      (res) => res.status === 200,
      (res) => new TicketRequestFailed({ status: res.status }),
    ),
    Effect.flatMap((res) => res.json),
    Effect.retry({ schedule: Schedule.spaced("1 second"), times: 10 }),
  );

test.provider(
  "a Durable Object refuses a command outside its phases",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { worker } = yield* stack.deploy(
        Effect.gen(function* () {
          return { worker: yield* DomainPhasesWorker };
        }),
      );
      const url = worker.url!;
      const id = `ticket-${yield* Effect.sync(() => crypto.randomUUID())}`;

      expect(yield* call(url, "close", id)).toEqual({
        _tag: "WrongPhase",
        command: "CloseTicket",
        phase: "new",
        allowed: ["open"],
      });
      expect(yield* call(url, "open", id)).toEqual({ phase: "open" });
      expect(yield* call(url, "open", id)).toMatchObject({ _tag: "WrongPhase", phase: "open" });
      expect(yield* call(url, "close", id)).toEqual({ phase: "closed" });
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);
