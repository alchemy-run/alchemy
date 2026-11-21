import { withMySqlExecutor, withPgExecutor } from "@alchemy.run/sql/Migrations/Executors";
import type { MigrationError, SqlExecutor } from "@alchemy.run/sql/Migrations/Format";
import type * as Effect from "effect/Effect";
import { RDS_CA_BUNDLE } from "./internal/RdsCaBundle.ts";

/**
 * Where and as whom a migration connects. Plain JSON: the Lambda transport
 * sends it to the migration runner in the invocation payload.
 */
export interface MigrationConnectionTarget {
  dialect: "postgres" | "mysql";
  host: string;
  port: number;
  database: string | undefined;
  username: string;
  password: string;
}

// Fail fast on an unreachable endpoint instead of hanging the deploy.
const CONNECT_TIMEOUT_MILLIS = 15_000;

/**
 * Open one `pg` client or `mysql2` connection to an RDS endpoint for the
 * scope of `use`, closing it afterwards. Shared by the direct transport
 * (on the deploying machine) and the migration runner Lambda (in the VPC).
 *
 * TLS is always on and verified: RDS certificates chain to the private
 * Amazon RDS CAs, so the connection trusts exactly the RDS CA bundle.
 */
export const withMigrationConnection = <A, E, R>(
  target: MigrationConnectionTarget,
  use: (executor: SqlExecutor) => Effect.Effect<A, E, R>,
): Effect.Effect<A, MigrationError | E, R> =>
  target.dialect === "postgres"
    ? withPgExecutor(
        {
          host: target.host,
          port: target.port,
          database: target.database,
          user: target.username,
          password: target.password,
          ssl: { ca: RDS_CA_BUNDLE, rejectUnauthorized: true },
          connectionTimeoutMillis: CONNECT_TIMEOUT_MILLIS,
        },
        use,
      )
    : withMySqlExecutor(
        {
          host: target.host,
          port: target.port,
          database: target.database,
          user: target.username,
          password: target.password,
          ssl: { ca: RDS_CA_BUNDLE, rejectUnauthorized: true },
          connectTimeout: CONNECT_TIMEOUT_MILLIS,
        },
        use,
      );
