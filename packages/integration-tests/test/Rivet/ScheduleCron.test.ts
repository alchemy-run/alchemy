import * as Rivet from "@alchemy.run/rivet";
import {
  ALARM_ACTION,
  DISPATCH_ACTION,
  makeDurableObjectState,
  type ActorContextLike,
  type CronFire,
  type CronJobInfo,
  type ScheduledEventInfo,
} from "@alchemy.run/rivet/DurableObjectState";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";

/** Minimal activation shape `makeDurableObjectState` needs for gated storage. */
const makeActivation = () => {
  const id = "test";
  const construction = `${id}:construct`;
  return { id, construction, open: new Set([construction]), next: 0 };
};

const mockContext = (): ActorContextLike & {
  readonly schedules: Map<string, ScheduledEventInfo>;
  readonly crons: Map<string, CronJobInfo>;
  readonly history: Map<string, CronFire[]>;
} => {
  const schedules = new Map<string, ScheduledEventInfo>();
  const crons = new Map<string, CronJobInfo>();
  const history = new Map<string, CronFire[]>();
  let nextId = 1;
  const dbRows = new Map<string, string>();

  const db: ActorContextLike["db"] = {
    execute: async (query, ...args) => {
      if (query.includes("CREATE TABLE")) return [];
      if (query.startsWith("SELECT") && query.includes("_alchemy_meta")) {
        const key = args[0] as string;
        const value = dbRows.get(key);
        return value === undefined ? [] : [{ value }];
      }
      if (
        query.startsWith("INSERT INTO _alchemy_meta") ||
        query.startsWith("UPDATE _alchemy_meta")
      ) {
        const key = (query.startsWith("UPDATE") ? args[1] : args[0]) as string;
        const value = args[0] as string;
        if (query.startsWith("INSERT")) dbRows.set(args[0] as string, args[1] as string);
        else dbRows.set(key, value);
        return [];
      }
      if (query.startsWith("DELETE FROM _alchemy_meta")) {
        dbRows.delete(args[0] as string);
        return [];
      }
      if (query.includes("_alchemy_kv")) return [];
      return [];
    },
    transaction: async (callback) => callback(db),
  };

  return {
    key: ["room"],
    db,
    schedules,
    crons,
    history,
    schedule: {
      after: async (duration, action, ...args) => {
        const id = `sched-${nextId++}`;
        schedules.set(id, { id, action, args, runAt: Date.now() + duration });
        return id;
      },
      at: async (timestamp, action, ...args) => {
        const id = `sched-${nextId++}`;
        schedules.set(id, { id, action, args, runAt: timestamp });
        return id;
      },
      cancel: async (id) => schedules.delete(id),
      get: async (id) => schedules.get(id),
      list: async () => [...schedules.values()],
    },
    cron: {
      set: async (options) => {
        crons.set(options.name, {
          name: options.name,
          kind: "cron",
          expression: options.expression,
          timezone: options.timezone ?? "UTC",
          action: options.action,
          args: options.args ?? [],
          nextRunAt: Date.now() + 60_000,
          maxHistory: options.maxHistory ?? 100,
        });
      },
      every: async (options) => {
        crons.set(options.name, {
          name: options.name,
          kind: "every",
          interval: options.interval,
          action: options.action,
          args: options.args ?? [],
          nextRunAt: Date.now() + options.interval,
          maxHistory: options.maxHistory ?? 100,
        });
      },
      get: async (name) => crons.get(name),
      list: async () => [...crons.values()],
      delete: async (name) => crons.delete(name),
      history: async (name) => history.get(name) ?? [],
    },
    waitUntil: () => undefined,
    keepAwake: (promise) => promise,
  };
};

describe(
  "Rivet DurableObject schedule and cron",
  { tags: ["provider:rivet", "unit", "local"] },
  () => {
    it.effect("rewrites schedule actions through the dispatch action", () =>
      Effect.gen(function* () {
        const c = mockContext();
        const state = makeDurableObjectState(c, makeActivation());
        const id = yield* state.schedule.after(5_000, "sendReminder", { text: "hi" });
        const stored = c.schedules.get(id)!;
        expect(stored.action).toBe(DISPATCH_ACTION);
        expect(stored.args).toEqual(["sendReminder", { text: "hi" }]);
        const viewed = yield* state.schedule.get(id);
        expect(viewed?.action).toBe("sendReminder");
        expect(viewed?.args).toEqual([{ text: "hi" }]);
      }),
    );

    it.effect("leaves the alarm action unwrapped", () =>
      Effect.gen(function* () {
        const c = mockContext();
        const state = makeDurableObjectState(c, makeActivation());
        const id = yield* state.schedule.at(Date.now() + 1_000, ALARM_ACTION, "token");
        expect(c.schedules.get(id)?.action).toBe(ALARM_ACTION);
        expect(c.schedules.get(id)?.args).toEqual(["token"]);
      }),
    );

    it.effect("rewrites cron actions and restores them on get/list", () =>
      Effect.gen(function* () {
        const c = mockContext();
        const state = makeDurableObjectState(c, makeActivation());
        yield* state.cron.set({
          name: "daily",
          expression: "0 9 * * *",
          action: "report",
          args: [1],
          timezone: "UTC",
        });
        expect(c.crons.get("daily")?.action).toBe(DISPATCH_ACTION);
        expect(c.crons.get("daily")?.args).toEqual(["report", 1]);
        const viewed = yield* state.cron.get("daily");
        expect(viewed?.action).toBe("report");
        expect(viewed?.args).toEqual([1]);
        yield* state.cron.every({ name: "tick", interval: 10_000, action: "pulse" });
        expect(c.crons.get("tick")?.action).toBe(DISPATCH_ACTION);
        expect((yield* state.cron.list()).map((job) => job.action).sort()).toEqual([
          "pulse",
          "report",
        ]);
      }),
    );

    it.effect("exports Cron", () =>
      Effect.sync(() => {
        expect(typeof Rivet.Cron).toBe("function");
        expect(Rivet.CRON_RUN_ACTION).toBe("run");
      }),
    );
  },
);
