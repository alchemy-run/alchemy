import { describe, expect, layer } from "@alchemy.run/test";
/**
 * Which import cycles between a model and its members load, in every order.
 *
 * Each scenario under `fixtures/` is one help desk whose files import each
 * other in a cycle: the process's prose mentions the model, the model's
 * policy holds the process, and one of its views follows it. They differ
 * only in which of them are written as thunks. Each entry file is loaded first in a fresh process, as
 * a Worker, a page or a test might, and the desk is then built and its
 * mentions resolved.
 */
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Stream from "effect/Stream";

/** Load `entry` first in a fresh process, then build the scenario. */
const load = Effect.fn(function* (scenario: string, entry: string) {
  const path = yield* Path.Path;
  const dir = path.join(import.meta.dirname, "fixtures");
  const child = yield* ChildProcess.make("bun", [path.join(dir, "load.ts"), scenario, entry], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString);
  yield* child.exitCode;
  const line = out.split("\n").find((each) => each.startsWith('{"ok"'));
  return JSON.parse(line ?? JSON.stringify({ ok: false, error: out })) as {
    readonly ok: boolean;
    readonly error?: string;
    readonly tools?: ReadonlyArray<string>;
  };
});

/** Each scenario, and whether loading each of its files first works. */
const matrix = Effect.fn(function* (scenario: string, entries: ReadonlyArray<string>) {
  const results = yield* Effect.forEach(entries, (entry) => load(scenario, entry), {
    concurrency: "unbounded",
  });
  return Object.fromEntries(entries.map((entry, index) => [entry, results[index]!]));
});

const desk = ["Desk.model.ts", "Workload.view.ts", "Helper.process.ts", "Handover.policy.ts"];
const studio = ["Author.process.ts", "Reviewer.process.ts"];
const okOf = (results: Record<string, { readonly ok: boolean }>) =>
  Object.fromEntries(Object.entries(results).map(([entry, { ok }]) => [entry, ok]));

layer(BunServices.layer)("Domain: import cycles", (it) => {
  describe("a model, a view and a process that import each other", { tags: ["unit"] }, () => {
    it.effect(
      "without thunks, no file loads: the prose reads the model before it exists",
      () =>
        Effect.gen(function* () {
          const results = yield* matrix("eager", desk);
          expect(okOf(results)).toEqual({
            "Desk.model.ts": false,
            "Workload.view.ts": false,
            "Helper.process.ts": false,
            "Handover.policy.ts": false,
          });
          expect(results["Desk.model.ts"]!.error).toContain("before initialization");
        }),
      { timeout: 60_000 },
    );

    it.effect(
      "a thunk in the prose loads only when the model's file is loaded first",
      () =>
        Effect.gen(function* () {
          expect(okOf(yield* matrix("prose-thunk", desk))).toEqual({
            "Desk.model.ts": true,
            "Workload.view.ts": false,
            "Helper.process.ts": false,
            "Handover.policy.ts": false,
          });
        }),
      { timeout: 60_000 },
    );

    it.effect(
      "a thunk in the model too loads unless the process's file is loaded first",
      () =>
        Effect.gen(function* () {
          // The view still follows the process at once: loading the process
          // first loads the model, then the view, before the process exists.
          expect(okOf(yield* matrix("model-thunk", desk))).toEqual({
            "Desk.model.ts": true,
            "Workload.view.ts": true,
            "Helper.process.ts": false,
            "Handover.policy.ts": false,
          });
        }),
      { timeout: 60_000 },
    );

    it.effect(
      "with thunks in the prose, the model and the view, every file loads first",
      () =>
        Effect.gen(function* () {
          const results = yield* matrix("lazy", desk);
          expect(okOf(results)).toEqual({
            "Desk.model.ts": true,
            "Workload.view.ts": true,
            "Helper.process.ts": true,
            "Handover.policy.ts": true,
          });
          // And the prose's thunks resolved to the model's own tools.
          for (const { tools } of Object.values(results)) {
            expect(tools).toEqual(["Desk_TicketDetail_get", "Desk_CloseTicket_send"]);
          }
        }),
      { timeout: 60_000 },
    );
  });

  describe("two processes that mention each other", { tags: ["unit"] }, () => {
    it.effect(
      "without thunks, neither loads",
      () =>
        Effect.gen(function* () {
          expect(okOf(yield* matrix("mutual-eager", studio))).toEqual({
            "Author.process.ts": false,
            "Reviewer.process.ts": false,
          });
        }),
      { timeout: 60_000 },
    );

    it.effect(
      "with thunks in the prose, both load and each can start the other",
      () =>
        Effect.gen(function* () {
          const results = yield* matrix("mutual-lazy", studio);
          expect(okOf(results)).toEqual({
            "Author.process.ts": true,
            "Reviewer.process.ts": true,
          });
          expect(results["Author.process.ts"]!.tools).toEqual(["start_reviewer", "send_reviewer"]);
        }),
      { timeout: 60_000 },
    );
  });
});
