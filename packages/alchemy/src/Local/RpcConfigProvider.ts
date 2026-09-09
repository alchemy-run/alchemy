import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

// Only requested nodes cross the websocket. Providers need not enumerate their
// keys, and neither secret values nor fingerprints belong in session URLs.
export type ConfigNode =
  | Exclude<ConfigProvider.Node, { _tag: "Record" }>
  | { _tag: "Record"; keys: string[]; value: string | undefined };

type Path = ConfigProvider.Path;
type Transform = (path: Path) => Path;
interface PathMapping {
  input: Path;
  output: Path;
}
interface MapPath {
  _tag: "MapPath";
  path: Path;
}

export type ConfigReader = (
  path: Path,
  mappings?: ReadonlyArray<PathMapping>,
) => Promise<ConfigNode | MapPath | undefined>;

// mapInput callbacks are synchronous. Suspend a lookup at an unknown source
// path so the sidecar can transform it locally, then retry with that mapping.
// This object never escapes the reader; genuine source failures stay failures.
class UnmappedPath {
  constructor(readonly path: Path) {}
}

export const reader =
  (provider: ConfigProvider.ConfigProvider): ConfigReader =>
  (path, mappings) =>
    Effect.runPromise(
      Effect.suspend(() => {
        const mapped =
          mappings === undefined
            ? provider
            : provider.mapInput((input) => {
                const key = JSON.stringify(input);
                const mapping = mappings.find(
                  (entry) => JSON.stringify(entry.input) === key,
                );
                if (mapping === undefined) throw new UnmappedPath(input);
                return mapping.output;
              });
        return mapped.load(path);
      }).pipe(
        Effect.map((node): ConfigNode | MapPath | undefined =>
          node?._tag === "Record"
            ? { ...node, keys: [...node.keys].sort() }
            : node,
        ),
        Effect.catchCause((cause) => {
          const reason =
            cause.reasons.length === 1 ? cause.reasons[0] : undefined;
          if (reason?._tag === "Die" && reason.defect instanceof UnmappedPath) {
            return Effect.succeed({
              _tag: "MapPath" as const,
              path: reason.defect.path,
            });
          }
          // Provider errors may contain credentials. Do not serialize causes.
          return Effect.fail(new Error("Unable to read sidecar configuration"));
        }),
      ),
    );

const readNode = async (
  read: ConfigReader,
  path: Path,
  transforms: ReadonlyArray<Transform>,
) => {
  const mappings: PathMapping[] | undefined =
    transforms.length === 0 ? undefined : [];
  // A composed provider may consult several differently-nested fallback
  // sources. Negotiate each source path independently, with a finite budget.
  for (let step = 0; step < 128; step++) {
    const result = await read(path, mappings);
    if (result?._tag !== "MapPath") return result;
    if (
      mappings === undefined ||
      mappings.some(
        (entry) => JSON.stringify(entry.input) === JSON.stringify(result.path),
      )
    )
      break;
    mappings.push({
      input: result.path,
      output: transforms.reduce(
        (input, transform) => transform(input),
        result.path,
      ),
    });
  }
  throw new Error("Unable to transform sidecar configuration paths");
};

/** Keeps already-read configuration available between parent reloads. */
export const make = (initial: ConfigReader) => {
  let read = initial;
  const lookups = new Set<{
    path: Path;
    transforms: ReadonlyArray<Transform>;
    node: ConfigNode | undefined;
  }>();
  const makeProvider = (
    transforms: ReadonlyArray<Transform>,
  ): ConfigProvider.ConfigProvider => {
    const nodes = new Map<string, ConfigNode | undefined>();
    const load = async (path: Path) => {
      const key = JSON.stringify(path);
      if (!nodes.has(key)) {
        const node = await readNode(read, path, transforms);
        nodes.set(key, node);
        lookups.add({ path, transforms, node });
      }
      const node = nodes.get(key);
      return node?._tag === "Record"
        ? ConfigProvider.makeRecord(new Set(node.keys), node.value)
        : node;
    };
    return Object.assign(
      ConfigProvider.make((path) =>
        Effect.tryPromise({
          try: () => load(path),
          catch: () =>
            new ConfigProvider.SourceError({
              message: "Unable to read sidecar configuration",
            }),
        }),
      ),
      {
        // Delegate transforms to each original source, after its existing
        // transforms. Wrapping provider.load in make() alone reverses this order.
        mapInput: (transform: Transform) =>
          makeProvider([...transforms, transform]),
      },
    );
  };
  return {
    provider: makeProvider([]),
    // Include absent nodes and transformed views: adding a credential must
    // invalidate a context that previously selected profile authentication.
    changed: async (next: ConfigReader) => {
      for (const { path, transforms, node } of lookups) {
        if (
          JSON.stringify(await readNode(next, path, transforms)) !==
          JSON.stringify(node)
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
