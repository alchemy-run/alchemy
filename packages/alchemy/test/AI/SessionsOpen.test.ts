/**
 * `Sessions.open` — the operator's "new session": a key is admitted
 * DURABLY before any input, so it lists (idle) for every client and
 * survives the tab that named it; the first input builds the shell
 * over that admission (one `admitted`, never two).
 */
import * as AI from "@/AI/index.ts";
import { DriverLocal } from "@/AI/DriverLocal.ts";
import { ThreadStorage } from "@/AI/ThreadStorage.ts";
import { ThreadStorageMemory } from "@/AI/ThreadStorageMemory.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  Researcher,
  ResearcherCharter,
  Search,
} from "./fixtures/researcher.ts";
import * as Model from "./fixtures/ScriptedModel.ts";

const interpret = (term: AI.Interpretable, charter: AI.Charter) =>
  Effect.orDie(
    Effect.flatMap(AI.Driver, (driver) => driver.interpret(term, charter)),
  );

describe("Sessions.open (DriverLocal)", () => {
  it.live(
    "an opened key lists idle before any input; the first input reuses the admission",
    () => {
      const model = Model.make([() => [Model.text("hello"), Model.finish()]]);
      const search = Layer.succeed(Search, ((input: { query: string }) =>
        Effect.succeed(`results for ${input.query}`)) as never);
      const storage = ThreadStorageMemory;
      // one shared index: the driver's Events feed it (captured from
      // the interpreting context), Sessions.list reads it (layers
      // memoize by reference)
      const index = AI.SessionIndexMemory();
      const layer = Layer.mergeAll(
        DriverLocal.pipe(
          Layer.provide(storage),
          Layer.provide(index),
          Layer.provide(model.layer),
        ),
        AI.SessionIndexStream.pipe(Layer.provide(index)),
        storage,
        search,
        RuntimeContext.phantom,
      );

      return Effect.gen(function* () {
        const researcher = yield* interpret(Researcher, ResearcherCharter);
        const sessions = yield* AI.Sessions;
        const threads = yield* ThreadStorage;

        // nothing yet
        expect(yield* sessions.list()).toHaveLength(0);

        // OPEN: the row lands at once, idle, with no input and no
        // sampling — the charter's init has not run
        yield* sessions.open("Researcher", "w1");
        const listed = yield* sessions.list();
        expect(listed.map((row) => row.key)).toEqual(["w1"]);
        expect(listed[0]!.status).toBe("idle");
        expect(listed[0]!.firstInput).toBeUndefined();
        expect(model.calls).toHaveLength(0);

        // idempotent: a second open changes nothing
        yield* sessions.open("Researcher", "w1");
        expect(yield* sessions.list()).toHaveLength(1);

        // the first input builds the shell over the persisted
        // admission — exactly ONE `admitted` in the durable log
        const answer = yield* researcher.dispatch("say hello", { key: "w1" });
        expect(answer).toBe("hello");
        const handle = yield* threads.open("Researcher", "w1");
        const log = yield* handle.observations(0);
        expect(
          log.filter((observation) => observation.type === "admitted"),
        ).toHaveLength(1);
        expect(log.map((observation) => observation.type)).toContain("input");
        expect(yield* sessions.list()).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(layer));
    },
    { timeout: 30_000 },
  );
});
