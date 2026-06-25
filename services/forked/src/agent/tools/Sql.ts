import * as AI from "alchemy/AI";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";

export const sql = AI.Parameter("sql", S.String)`
The SQL statement to execute.`;

export class Sql extends AI.Tool<Sql>()("sql")`
Execute a ${sql} statement against the agent session's private SQLite database,
backed by Durable Object storage, and return the resulting rows. The schema is
entirely yours — issue \`CREATE TABLE\`, \`INSERT\`, \`SELECT\`, etc. to persist
whatever state you need across turns (plans, findings, scratch data).` {}

export const SqlLive = Layer.effect(
  Sql,
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.fn("sql")(function* (params) {
      const { sql } = params as { sql: string };
      const result = yield* state.storage.sql.exec(sql);
      return yield* result.toArray();
    });
  }),
);
