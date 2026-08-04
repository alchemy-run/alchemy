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
 * `Context.Reference` read by `resolveMySQLConfig`. The default is empty —
 * plain mysql2 behavior — and each runtime layers in what its platform
 * needs; the Cloudflare Worker bridge provides
 * `{ disablePreparedStatements: true, poolConfig: { disableEval: true } }`:
 *
 * ```typescript
 * Layer.succeed(MySQLDefaults, { disablePreparedStatements: true })
 * ```
 */
export const MySQLDefaults = Context.Reference<MySQLDefaultOptions>(
  "alchemy/SQL/MySQLDefaults",
  { defaultValue: () => ({}) },
);
