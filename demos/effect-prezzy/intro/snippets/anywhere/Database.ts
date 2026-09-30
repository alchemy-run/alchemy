import * as Context from "effect/Context";
import type * as SqlClient from "effect/sql/SqlClient";

/** The Database module's interface: a SQL client. */
export class Database extends Context.Service<Database, SqlClient.SqlClient>()("Database") {}
