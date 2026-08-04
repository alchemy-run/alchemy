import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import LocalSendEmailWorker from "./fixtures/local-worker.ts";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command.
const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
}> {}

const getJsonReady = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new WorkerNotReady({ status: res.status })),
      ),
      Effect.retry({
        while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
        schedule: Schedule.max([
          Schedule.min([
            Schedule.exponential("500 millis"),
            Schedule.spaced("2 seconds"),
          ]),
          Schedule.recurs(10),
        ]),
      }),
    );
    return yield* res.json;
  }).pipe(Effect.orDie);

/**
 * Under `alchemy dev` a `send_email` binding is a local stub by default —
 * `send()` logs the message and resolves without delivering mail or
 * enforcing sender/destination verification. `Alchemy.remote()` on the
 * descriptor opts that binding into the live Cloudflare Email service:
 * the live service DOES enforce verification, so a send from an
 * unverified address is rejected — proof the call was served by the real
 * binding and not the stub. Neither route delivers any mail.
 */
test.provider(
  "send_email stubs locally; Alchemy.remote() binds the live service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* LocalSendEmailWorker;
          return { url: worker.url.as<string>() };
        }),
      );

      // The worker itself is served by the local dev proxy.
      expect(deployed.url).toMatch(/^http:\/\/localhost:\d+$/);

      const params =
        "from=noreply%40alchemy-local-test.invalid&to=nobody%40example.com";

      // The stub accepts anything (restrictions are only enforced on real
      // sends) and resolves without delivering.
      const stub = (yield* getJsonReady(
        `${deployed.url}/send-stub?${params}`,
      )) as { ok: boolean };
      expect(stub.ok).toBe(true);

      // The remote()-opted binding reaches the live Email service, which
      // rejects the unverified sender/destination pair.
      const live = (yield* getJsonReady(
        `${deployed.url}/send-live?${params}`,
      )) as { ok: boolean; message?: string };
      expect(live.ok).toBe(false);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
