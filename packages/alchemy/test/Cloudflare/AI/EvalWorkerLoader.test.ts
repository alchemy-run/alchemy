/**
 * END-TO-END: deployed Workers run complete agent sessions — real
 * DriverLocal + charter + codemode — with an ISOLATE evaluator
 * executing the model's program MODULE in a dynamically loaded,
 * network-less Worker isolate. Both evaluators are covered:
 * `EvalWorkerLoader` (async convention) and `EvalWorkerLoaderEffect`
 * (effect convention, carrying the bundled effect runtime).
 *
 * The in-process twin of most assertions lives in
 * `test/AI/DriverLocal.test.ts` / `test/AI/EvalFunction.test.ts` over
 * `EvalFunction`; this suite pins what ONLY the isolate can prove: the
 * RPC-dispatcher tool bridge, tagged-error marshaling across the
 * boundary, `globalOutbound: null` sandboxing, and that the monolith
 * effect runtime actually links and runs in a real isolate.
 */
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import Stack from "./fixtures/eval-loader/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
  body: string;
}> {}

interface SessionFacts {
  readonly answer: string;
  readonly wireTools: ReadonlyArray<string>;
  readonly signature: string;
  readonly resultPrompt: string;
  readonly queries: ReadonlyArray<string>;
}

/** Run one scripted session in the deployed worker, retrying through
 *  fresh-deploy propagation. */
const session = (url: string, code: string) =>
  HttpClient.HttpClient.pipe(
    Effect.flatMap((client) =>
      client.execute(
        HttpClientRequest.post(url).pipe(
          HttpClientRequest.bodyJsonUnsafe({ code }),
        ),
      ),
    ),
    Effect.flatMap((res) =>
      res.status === 200
        ? (res.json as Effect.Effect<unknown>)
        : res.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(new WorkerNotReady({ status: res.status, body })),
            ),
          ),
    ),
    Effect.retry({
      while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(20),
      ]),
    }),
    Effect.map((facts) => facts as SessionFacts),
  );

/** Drive a worker's `/probe` route (the evaluator directly, no driver),
 *  retrying through fresh-deploy propagation. Returns the raw body so a
 *  failure/defect report is surfaced verbatim. */
const probe = (url: string) =>
  HttpClient.HttpClient.pipe(
    Effect.flatMap((client) => client.get(`${url}/probe`)),
    Effect.flatMap((res) =>
      res.status === 200
        ? res.text
        : res.text.pipe(
            Effect.flatMap((text) =>
              Effect.fail(
                new WorkerNotReady({ status: res.status, body: text }),
              ),
            ),
          ),
    ),
    Effect.retry({
      while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(20),
      ]),
    }),
  );

test(
  "probe: evaluator runs directly in the deployed worker",
  Effect.gen(function* () {
    const { url } = yield* stack;
    // surface whatever the evaluator reported, verbatim
    const body = yield* probe(url);
    expect(body).toContain(`"outcome":"ok"`);
    expect(body).toContain(`"output":42`);
  }),
  { timeout: 180_000 },
);

test(
  "grants collapse into one eval tool and the program composes them in-isolate",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const facts = yield* session(
      url,
      `
        import { search } from "./tools.js";
        export default async function () {
          const first = await search({ query: "alchemy" });
          const second = await search({ query: "effect" });
          console.log("composed", first, second);
          return first + " // " + second;
        }`,
    );
    expect(facts.answer).toBe("done");
    // ONE eval tool on the wire (spawn stays — intrinsics are direct)
    expect(facts.wireTools).toEqual(["eval", "spawn"]);
    // the generated signature reached the model
    expect(facts.signature).toContain(
      "declare function search(input: { query: string }): Promise<unknown>",
    );
    // BOTH calls executed inside the isolate, in one round trip
    expect(facts.queries).toEqual(["alchemy", "effect"]);
    // the composed value and the captured console both came back
    expect(facts.resultPrompt).toContain(
      "results for alchemy // results for effect",
    );
    expect(facts.resultPrompt).toContain("composed");
  }),
  { timeout: 180_000 },
);

test(
  "a DECLARED tool error crosses the isolate with its tag intact",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const facts = yield* session(
      url,
      `
        import { readFile } from "./tools.js";
        export default async function () {
          try {
            await readFile({ path: "/tmp/nope" });
            return "unreachable";
          } catch (error) {
            return { tag: error._tag, path: error.path };
          }
        }`,
    );
    // the tool result carries the program's return value — the caught
    // error's tag and fields, proving the tagged error crossed the
    // isolate reconstructably (rendered as pretty-printed JSON)
    expect(facts.resultPrompt).toContain(String.raw`\"tag\": \"Missing\"`);
    expect(facts.resultPrompt).toContain(String.raw`\"path\": \"/tmp/nope\"`);
  }),
  { timeout: 180_000 },
);

test(
  "a broken program fails model-visibly",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const facts = yield* session(
      url,
      "export default async function () { return ] not javascript }",
    );
    expect(facts.answer).toBe("done");
    expect(facts.resultPrompt).toContain("code did not evaluate");
  }),
  { timeout: 180_000 },
);

test(
  "the isolate has NO network: fetch fails, tools remain the only capability",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const facts = yield* session(
      url,
      `
        export default async function () {
          try {
            await fetch("https://example.com/");
            return "network-allowed";
          } catch (error) {
            return "network-blocked";
          }
        }`,
    );
    // assert on the TOOL RESULT specifically — the prompt also echoes
    // the program's source, which contains both literals
    expect(facts.resultPrompt).toContain(`"result":"network-blocked"`);
    expect(facts.resultPrompt).not.toContain(`"result":"network-allowed"`);
  }),
  { timeout: 180_000 },
);

// ─── the EFFECT convention (EvalWorkerLoaderEffect) ─────────────────

test(
  "effect probe: the bundled effect runtime links and runs in-isolate",
  Effect.gen(function* () {
    const { effectUrl } = yield* stack;
    // the graph imports effect/Effect + effect/Duration, sleeps, awaits
    // a tool through Effect.promise, and returns 42 — none of which can
    // work unless the monolith actually loaded in the isolate
    const body = yield* probe(effectUrl);
    expect(body).toContain(`"outcome":"ok"`);
    expect(body).toContain(`"output":42`);
    expect(body).toContain("probing effect");
  }),
  { timeout: 180_000 },
);

test(
  "effect: the model's Effect program composes tools with yield*",
  Effect.gen(function* () {
    const { effectUrl } = yield* stack;
    const facts = yield* session(
      effectUrl,
      `
        import * as Effect from "effect/Effect";
        import { search } from "./tools.js";
        export default Effect.gen(function* () {
          const first = yield* search({ query: "alchemy" });
          const second = yield* search({ query: "effect" });
          console.log("composed");
          return first + " // " + second;
        });`,
    );
    expect(facts.answer).toBe("done");
    expect(facts.wireTools).toEqual(["eval", "spawn"]);
    // the EFFECT signature shape reached the model
    expect(facts.signature).toContain(
      "declare function search(input: { query: string }): Effect<unknown, never>",
    );
    // both calls ran in the isolate, in one round trip
    expect(facts.queries).toEqual(["alchemy", "effect"]);
    expect(facts.resultPrompt).toContain(
      "results for alchemy // results for effect",
    );
    expect(facts.resultPrompt).toContain("composed");
  }),
  { timeout: 180_000 },
);

test(
  "effect: a declared tool failure is catchable BY TAG inside the isolate",
  Effect.gen(function* () {
    const { effectUrl } = yield* stack;
    const facts = yield* session(
      effectUrl,
      `
        import * as Effect from "effect/Effect";
        import { readFile } from "./tools.js";
        export default Effect.gen(function* () {
          return yield* readFile({ path: "/tmp/nope" });
        }).pipe(Effect.catchTag("Missing", (e) => Effect.succeed("caught:" + e.path)));`,
    );
    // the CONCATENATED value can only exist if catchTag matched the
    // reconstructed tagged error across the isolate boundary
    expect(facts.resultPrompt).toContain("caught:/tmp/nope");
  }),
  { timeout: 180_000 },
);

test(
  "effect: an uncaught declared failure fails the program model-visibly",
  Effect.gen(function* () {
    const { effectUrl } = yield* stack;
    const facts = yield* session(
      effectUrl,
      `
        import * as Effect from "effect/Effect";
        import { readFile } from "./tools.js";
        export default Effect.gen(function* () {
          return yield* readFile({ path: "/tmp/nope" });
        });`,
    );
    // the loop survived; the model was told the program failed
    expect(facts.answer).toBe("done");
    expect(facts.resultPrompt).toContain("program failed");
  }),
  { timeout: 180_000 },
);
