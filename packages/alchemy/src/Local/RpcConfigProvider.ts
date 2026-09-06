import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

// Only requested nodes cross the websocket. Providers need not enumerate their
// keys, and neither secret values nor fingerprints belong in session URLs.
export type ConfigNode =
  | Exclude<ConfigProvider.Node, { _tag: "Record" }>
  | { _tag: "Record"; keys: string[]; value: string | undefined };

export type ConfigReader = (
  path: ConfigProvider.Path,
) => Promise<ConfigNode | undefined>;

export const reader =
  (provider: ConfigProvider.ConfigProvider): ConfigReader =>
  (path) =>
    Effect.runPromise(
      provider.load(path).pipe(
        Effect.map((node): ConfigNode | undefined =>
          node?._tag === "Record"
            ? { ...node, keys: [...node.keys].sort() }
            : node,
        ),
        // Provider errors may contain credentials. Do not serialize their causes.
        Effect.catchCause(() =>
          Effect.fail(new Error("Unable to read sidecar configuration")),
        ),
      ),
    );

/** Keeps already-read configuration available between parent reloads. */
export const make = (initial: ConfigReader) => {
  let read = initial;
  const nodes = new Map<string, ConfigNode | undefined>();
  const load = async (path: ConfigProvider.Path) => {
    const key = JSON.stringify(path);
    if (!nodes.has(key)) nodes.set(key, await read(path));
    const node = nodes.get(key);
    return node?._tag === "Record"
      ? ConfigProvider.makeRecord(new Set(node.keys), node.value)
      : node;
  };
  return {
    provider: ConfigProvider.make((path) =>
      Effect.tryPromise({
        try: () => load(path),
        catch: () =>
          new ConfigProvider.SourceError({
            message: "Unable to read sidecar configuration",
          }),
      }),
    ),
    // Include absent nodes: adding a credential must invalidate a context that
    // previously selected profile authentication because that key was missing.
    changed: async (next: ConfigReader) => {
      for (const [key, node] of nodes) {
        if (
          JSON.stringify(await next(JSON.parse(key))) !== JSON.stringify(node)
        )
          return true;
      }
      return false;
    },
    update: (next: ConfigReader) => {
      read = next;
    },
  };
};
