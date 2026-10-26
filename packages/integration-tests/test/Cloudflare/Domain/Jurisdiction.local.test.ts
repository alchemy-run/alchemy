import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "alchemy/Test/Alchemy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import DomainDefaultWorker from "./fixtures/default-worker.ts";
import DomainJurisdictionWorker from "./fixtures/jurisdiction-worker.ts";

const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
}> {}

const request = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.post(url).pipe(
      Effect.flatMap((response) =>
        response.status === 200
          ? Effect.succeed(response)
          : Effect.fail(new WorkerNotReady({ status: response.status })),
      ),
      Effect.retry({
        while: (error) => error._tag === "WorkerNotReady" && error.status === 404,
        schedule: Schedule.spaced("2 seconds"),
        times: 10,
      }),
    );
    return (yield* response.json) as { total: number };
  });

const roundTrip = (url: string) =>
  Effect.gen(function* () {
    expect(url).toMatch(/^http:\/\/localhost:\d+$/);
    expect(yield* request(`${url}/state/c-1`)).toEqual({ total: 0 });
    expect(yield* request(`${url}/increment/c-1`)).toEqual({ total: 2 });
    expect(yield* request(`${url}/increment/c-1`)).toEqual({ total: 4 });
    // A different key is a different aggregate instance.
    expect(yield* request(`${url}/state/c-2`)).toEqual({ total: 0 });
  });

/**
 * Local workerd does not implement Durable Object jurisdictions, so under
 * `alchemy dev` `durableObjects({ jurisdiction: "eu" })` runs the model
 * unrestricted, as a D1 database, R2 bucket or Queue with a jurisdiction does.
 * The model must still serve commands and reads.
 */
test.provider(
  "a Domain model declared with an EU jurisdiction runs in alchemy dev",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* DomainJurisdictionWorker;
          return { worker };
        }),
      );
      yield* roundTrip(deployed.worker.url!);
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "a Domain model on the default platform runs in alchemy dev",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* DomainDefaultWorker;
          return { worker };
        }),
      );
      yield* roundTrip(deployed.worker.url!);
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);
