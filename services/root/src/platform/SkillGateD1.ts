import * as AI from "alchemy/AI";
import * as D1 from "alchemy/Cloudflare/D1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { database, inWorker } from "./Database.ts";

const TABLE = `
CREATE TABLE IF NOT EXISTS agent_skills (
  agent   TEXT NOT NULL,
  skill   TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  PRIMARY KEY (agent, skill)
)`;

/**
 * The per-agent skill switches, on the org database. No row means
 * ENABLED — grants are on by default; only an explicit switch-off is
 * stored. Yields the config client both the gate Layer and the PATCH
 * route share.
 */
export const skillConfig = Effect.gen(function* () {
  const db = yield* D1.QueryDatabase(database);
  const ensured = yield* Effect.cached(
    inWorker(db.exec(TABLE.trim().replaceAll(/\s+/g, " ")).pipe(Effect.asVoid)),
  );

  const enabled = Effect.fn(function* (agent: string, skill: string) {
    yield* ensured;
    const row = yield* inWorker(
      db
        .prepare(
          "SELECT enabled FROM agent_skills WHERE agent = ? AND skill = ?",
        )
        .bind(agent, skill)
        .first<{ enabled: number }>(),
    );
    return row === null || row.enabled === 1;
  });

  const set = Effect.fn(function* (
    agent: string,
    skill: string,
    value: boolean,
  ) {
    yield* ensured;
    yield* inWorker(
      db
        .prepare(
          `INSERT INTO agent_skills (agent, skill, enabled) VALUES (?, ?, ?)
             ON CONFLICT(agent, skill) DO UPDATE SET enabled = excluded.enabled`,
        )
        .bind(agent, skill, value ? 1 : 0)
        .run(),
    );
  });

  /** Every stored switch-off, as `agent/skill` keys. */
  const disabled = Effect.fn(function* () {
    yield* ensured;
    const rows = yield* inWorker(
      db
        .prepare("SELECT agent, skill FROM agent_skills WHERE enabled = 0")
        .all<{ agent: string; skill: string }>(),
    );
    return new Set(rows.results.map((row) => `${row.agent}/${row.skill}`));
  });

  return { enabled, set, disabled };
});

/**
 * The org's `AI.SkillGate` over D1 — consulted by the driver at the
 * activation doors (the `skill` intrinsic, spawn handoffs). FAILS
 * OPEN: a database hiccup must never brick an agent's activation,
 * only skip the humans' override.
 */
export const SkillGateD1 = Layer.effect(
  AI.SkillGate,
  Effect.map(skillConfig, (config) =>
    AI.SkillGate.of({
      enabled: (agent, skill) =>
        config
          .enabled(agent, skill)
          .pipe(Effect.catchCause(() => Effect.succeed(true))),
    }),
  ),
);
