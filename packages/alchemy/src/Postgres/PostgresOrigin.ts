import * as Redacted from "effect/Redacted";

export type PostgresOrigin = {
  scheme: "postgres" | "postgresql";
  host: string;
  port: number;
  database: string;
  user: string;
  password: Redacted.Redacted<string>;
};

export const parsePostgresOrigin = (uri: string): PostgresOrigin => {
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

export const buildConnectionUri = (origin: PostgresOrigin): string => {
  const password = Redacted.value(origin.password);
  return `${origin.scheme}://${encodeURIComponent(origin.user)}:${encodeURIComponent(password)}@${origin.host}:${origin.port}/${origin.database}`;
};
