import * as Context from "effect/Context";

/**
 * Platform-supplied defaults for `alchemy/SQL/MySQL` clients, merged below
 * the connection URL and explicit config (defaults < url < config).
 */
export interface MySQLDefaultOptions {
  readonly disablePreparedStatements?: boolean;
  readonly poolConfig?: Record<string, unknown>;
}

/**
 * `Context.Reference` read at init by the MySQL clients. The default is
 * empty — plain mysql2 behavior — and a platform binding layers in what its
 * runtime needs; on Workers, provide `Cloudflare.MySQLBinding`. A custom
 * platform (or another text-protocol proxy) supplies its own:
 *
 * ```typescript
 * Layer.succeed(MySQLDefaults, { disablePreparedStatements: true })
 * ```
 */
export const MySQLDefaults = Context.Reference<MySQLDefaultOptions>(
  "alchemy/SQL/MySQLDefaults",
  { defaultValue: () => ({}) },
);
