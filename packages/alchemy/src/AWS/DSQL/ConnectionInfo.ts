import * as Effect from "effect/Effect";
import { generateDbAuthToken } from "../Connection/DbAuthToken.ts";
import { formatSqlConnectionUrl, type SqlConnectionInfo } from "../Connection/internal.ts";

const DSQL_PORT = 5432;

/**
 * The connection descriptor for a DSQL cluster endpoint, with a freshly
 * presigned IAM auth token as the password (client-side SigV4 — no API
 * call). `admin` connects as the built-in `admin` role.
 */
export const dsqlConnectionInfo = Effect.fn(function* (options: {
  host: string;
  admin?: boolean;
  username?: string;
  database?: string;
}) {
  const { host } = options;
  const admin = options.admin ?? false;
  const username = admin ? "admin" : options.username;
  const database = options.database ?? "postgres";
  const password = yield* generateDbAuthToken({
    service: "dsql",
    hostname: host,
    action: admin ? "DbConnectAdmin" : "DbConnect",
  });
  return {
    host,
    port: DSQL_PORT,
    database,
    username,
    password,
    ssl: true,
    url: formatSqlConnectionUrl({
      host,
      port: DSQL_PORT,
      database,
      username,
      password,
      ssl: true,
    }),
  } satisfies SqlConnectionInfo;
});
