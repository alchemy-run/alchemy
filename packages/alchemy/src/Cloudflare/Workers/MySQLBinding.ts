import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MySQLDefaults } from "../../SQL/MySQLDefaults.ts";
import { Worker } from "./Worker.ts";

/**
 * Provide the MySQL client defaults a Worker needs: the text protocol
 * (Hyperdrive's MySQL proxy has no `COM_STMT_PREPARE`) and mysql2's
 * eval-free row parsers (workerd forbids runtime code generation).
 *
 * ```typescript
 * Effect.gen(function* () {
 *   const conn = yield* Cloudflare.Hyperdrive.Connect(Hyperdrive);
 *   const sql = yield* SQL.MySQL({ url: conn.connectionString });
 *   // ...
 * }).pipe(
 *   Effect.provide(
 *     Layer.mergeAll(Cloudflare.Hyperdrive.ConnectBinding, Cloudflare.MySQLBinding),
 *   ),
 * )
 * ```
 *
 * @binding
 */
export const MySQLBinding = Layer.effect(
  MySQLDefaults,
  Effect.gen(function* () {
    // Anchor to the Worker host — these defaults only apply on workerd.
    yield* Worker;
    return {
      disablePreparedStatements: true,
      poolConfig: { disableEval: true },
    };
  }),
);
