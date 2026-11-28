import * as Redacted from "effect/Redacted";

/**
 * Parsed PostgreSQL connection parameters exposed on {@link PostgresAttributes}
 * (`origin` and `pooledOrigin`) for interoperability with Edge poolers and
 * SQL tooling.
 */
export interface PostgresOrigin {
  /** Connection URI scheme (`"postgres"` or `"postgresql"`). */
  readonly scheme: "postgres" | "postgresql" | "mysql";
  /** Database hostname. */
  readonly host: string;
  /** Database TCP port (`5432` direct or `6432` PgBouncer). */
  readonly port: number;
  /** Initial database name. */
  readonly database: string;
  /** PostgreSQL role username. */
  readonly user: string;
  /** Redacted database password. */
  readonly password: Redacted.Redacted<string>;
}

/** Parse a Postgres connection URI into structured {@link PostgresOrigin} fields. */
export const parsePostgresOrigin = (uri: string): PostgresOrigin => {
  if (!URL.canParse(uri)) {
    return {
      scheme: "postgres",
      host: "",
      port: 5432,
      database: "",
      user: "",
      password: Redacted.make(""),
    };
  }
  const url = new URL(uri);
  const scheme: PostgresOrigin["scheme"] =
    url.protocol === "postgresql:" ? "postgresql" : "postgres";
  return {
    scheme,
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    database: url.pathname.replace(/^\//, ""),
    user: decodeURIComponent(url.username),
    password: Redacted.make(decodeURIComponent(url.password)),
  };
};

/**
 * Rewrite a Render Postgres direct connection string (`:5432`) to Render's
 * PgBouncer transaction pool port (`6432`). Returns the original string if
 * `uri` cannot be parsed as a URL.
 */
export const toPooledPostgresUrl = (uri: string): string => {
  if (!URL.canParse(uri)) return uri;
  const url = new URL(uri);
  url.port = "6432";
  return url.toString();
};
