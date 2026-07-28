/**
 * The Cloudflare kernel with a REAL model: one smoke test that proves
 * the full production shape end to end — the Anthropic key bound onto
 * the Worker as a secret via `Config.redacted` at init (see
 * https://alchemy.run/environments/secrets/), the Durable Object run
 * sampling Anthropic over HTTP from inside its burst, a real tool
 * call, and the round answered by `AI.reply`'s artifact.
 *
 * Gated on `ANTHROPIC_API_KEY` — run via
 * `doppler run -p alchemy-v2 -c dev -- bun run test … --profile testing`.
 */
import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import KernelAnthropicTestWorker from "./fixtures/KernelAnthropicWorker.ts";

const hasKey = !!process.env.ANTHROPIC_API_KEY;

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const Stack = Alchemy.Stack(
  "KernelCloudflareAnthropicStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* KernelAnthropicTestWorker;
    return { url: worker.url.as<string>() };
  }),
);

// deploying without the key would fail the layer build, not skip —
// so the hooks are only registered when the key is present
const stack = hasKey ? beforeAll(deploy(Stack)) : undefined;
afterAll.skipIf(!hasKey || !!process.env.NO_DESTROY)(destroy(Stack));

const readinessSchedule = Schedule.min([
  Schedule.exponential("500 millis"),
  Schedule.spaced("3 seconds"),
]);

const retryReady = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchDefect((defect) => Effect.fail(defect)),
    Effect.retry({ schedule: readinessSchedule, times: 15 }),
  );

test.skipIf(!hasKey)(
  "a real model drives the deployed run: dispatch → tool call → AI.reply",
  Effect.gen(function* () {
    const { url } = yield* stack!;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

    // warm the fresh workers.dev URL on the cheap route first, so the
    // readiness retries never re-dispatch (and re-bill) a model round;
    // propagation can 404 for over a minute, so this wait is generous
    yield* client.get(url).pipe(
      Effect.catchDefect((defect) => Effect.fail(defect)),
      Effect.retry({ schedule: readinessSchedule, times: 60 }),
    );

    const key = `real-${Date.now()}`;
    const input =
      "Use the write tool to write exactly the word 'quicksilver' " +
      "into the record. You MUST call the tool.";
    const response = yield* client
      .get(`${url}/dispatch?key=${key}&input=${encodeURIComponent(input)}`)
      .pipe(retryReady);
    const body = (yield* response.json) as { answer: unknown };

    // the answer is the ARTIFACT the write tool replied with — proof
    // the model called the tool and the round resolved through
    // AI.reply, not through closing prose
    expect(JSON.stringify(body.answer)).toContain("quicksilver");
    expect(body.answer).toHaveProperty("wrote");
  }).pipe(logLevel),
  { timeout: 300_000 },
);
