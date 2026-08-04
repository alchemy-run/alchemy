/**
 * Browser-side connection helper for SpacetimeDB.
 *
 * Plain TypeScript with no Effect dependency so Vite/bundlers can ship it
 * to the browser. Persists the server-issued identity token in
 * `localStorage` so anonymous connections don't churn a new identity on
 * every reload.
 *
 * @example Basic usage
 * ```typescript
 * import { withTokenPersistence, storageKeyFor } from "alchemy/SpacetimeDB";
 *
 * const builder = withTokenPersistence(
 *   DbConnection.builder().withUri(uri).withDatabaseName(name),
 * );
 * ```
 */
export interface BrowserStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const storageKeyFor = (uri: string, databaseName: string): string =>
  `spacetimedb.token.${uri}.${databaseName}`;

const memoryStorage: BrowserStorage = (() => {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
})();

const resolveStorage = (override?: BrowserStorage): BrowserStorage => {
  if (override) return override;
  try {
    if (typeof globalThis !== "undefined" && globalThis.localStorage) {
      return globalThis.localStorage as BrowserStorage;
    }
  } catch {
    // localStorage may throw in private modes.
  }
  return memoryStorage;
};

export interface BrowserConnectionOptions {
  readonly storageKey?: string;
  readonly storage?: BrowserStorage;
  readonly onConnect?: (identity: unknown, token: string) => void;
  readonly onConnectError?: (error: Error) => void;
  readonly onDisconnect?: (error: Error | null) => void;
}

interface BuilderLike {
  withUri(uri: string): BuilderLike;
  withDatabaseName(name: string): BuilderLike;
  withToken?(token?: string): BuilderLike;
  onConnect(
    cb: (conn: unknown, identity: unknown, token: string) => void,
  ): BuilderLike;
  onConnectError(cb: (ctx: unknown, error: Error) => void): BuilderLike;
  onDisconnect?(cb: (ctx: unknown, error: Error | null) => void): BuilderLike;
  build(): unknown;
}

/**
 * Wrap a SpacetimeDB `DbConnection.builder()` so the saved identity token
 * is applied via `withToken()` and the fresh token from each connect is
 * persisted back to storage.
 *
 * Implementation: a chain-aware Proxy. Every setter returns a Proxy over
 * the resulting builder so `.build()` is always intercepted. The intercept
 * reads the latest captured uri/name, applies the saved token, wraps
 * `onConnect` / `onConnectError` for persistence, and forwards to the
 * real builder.
 */
export const withTokenPersistence = <B extends BuilderLike>(
  builder: B,
  options: BrowserConnectionOptions = {},
): B => {
  const state = {
    uri: "",
    name: "",
    onConnectWrapped: false,
  };

  const build = (current: BuilderLike): unknown => {
    const storage = resolveStorage(options.storage);
    const storageKey =
      options.storageKey ??
      (state.uri && state.name
        ? storageKeyFor(state.uri, state.name)
        : "spacetimedb.token");

    let configured: BuilderLike = current;
    const saved = storage?.getItem(storageKey);
    if (saved && configured.withToken) {
      configured = configured.withToken(saved);
    }
    configured = configured.onConnect((conn, identity, token) => {
      try {
        storage?.setItem(storageKey, token);
      } catch {
        /* ignore */
      }
      options.onConnect?.(identity, token);
    });
    configured = configured.onConnectError((_ctx, err) => {
      try {
        storage?.removeItem(storageKey);
      } catch {
        /* ignore */
      }
      options.onConnectError?.(err);
    });

    return (configured as unknown as { build: () => unknown }).build();
  };

  const wrap = (target: BuilderLike): BuilderLike =>
    new Proxy(target, {
      get(t, prop, recv) {
        if (prop === "withUri") {
          return (uri: string) => {
            state.uri = uri;
            const next = (target.withUri as (u: string) => BuilderLike).call(
              target,
              uri,
            );
            return wrap(next);
          };
        }
        if (prop === "withDatabaseName") {
          return (name: string) => {
            state.name = name;
            const next = (
              target.withDatabaseName as (n: string) => BuilderLike
            ).call(target, name);
            return wrap(next);
          };
        }
        if (prop === "build") {
          return () => build(target);
        }
        return Reflect.get(t as object, prop, recv);
      },
    });

  return wrap(builder) as B;
};
