import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import * as Cloudflare from "../../../Cloudflare/index.ts";
import * as Ai from "../../index.ts";

export const sql = Ai.Parameter("sql", S.String)`The SQL query to execute.`;

export class Sql extends Ai.Tool<Sql>()("sql")`
Execute a ${sql} query on the database and return the result.` {}

export const SqlDurableObjectLive = Layer.effect(
  Sql,
  Effect.gen(function* () {
    // declare environment dependencies (e.g. this tool runs in a Durable Object)
    const object = yield* Cloudflare.DurableObjectState;

    return Effect.gen(function* () {
      // use environment dependencies when an instance of the environment is instantiated
      yield* object.storage.sql.exec("CREATE TABLE IF NOT EXIST ...");

      return ({ sql }) =>
        object.storage.sql
          .exec(sql)
          .pipe(Effect.flatMap((result) => result.toArray()));
    });
  }),
);
