import type { NamespaceNode } from "./Namespace.ts";

/**
 * Separator used in FQN strings.
 */
export const FQN_SEPARATOR = "/";

/**
 * Encode an FQN for safe filesystem/object-key storage.
 *
 * `%`, `_`, and `\` are percent-escaped BEFORE `/` (the FQN separator)
 * is replaced with `__`, so every `__` in an encoded name is
 * unambiguously a separator. This makes the codec injective: a logical
 * id containing a literal `__` (e.g. `foo__bar`) encodes to
 * `foo%5F%5Fbar` and can never collide with the encoding of `foo/bar`.
 */
export const encodeFqn = (fqn: string): string =>
  fqn
    .replaceAll("%", "%25")
    .replaceAll("_", "%5F")
    .replaceAll("\\", "%5C")
    .replaceAll(FQN_SEPARATOR, "__");

/**
 * Decode a filename back to FQN. Exact inverse of {@link encodeFqn}.
 */
export const decodeFqn = (filename: string): string =>
  filename
    .replaceAll("__", FQN_SEPARATOR)
    .replaceAll("%5C", "\\")
    .replaceAll("%5F", "_")
    .replaceAll("%25", "%");

/**
 * The legacy (lossy) encoding used before {@link encodeFqn} escaped
 * `%`/`_`/`\`: a bare `/` → `__` replacement. State stores keep this
 * for read-fallback so state written by older versions stays readable;
 * writes always use {@link encodeFqn} and clean up the legacy name.
 */
export const encodeFqnLegacy = (fqn: string): string =>
  fqn.replaceAll(FQN_SEPARATOR, "__");

/**
 * Convert a NamespaceNode chain to an array of namespace IDs, from root to leaf.
 *
 * @example
 * ```ts
 * const ns = { Id: "Child", Parent: { Id: "Parent", Parent: { Id: "Root" } } };
 * toPath(ns); // ["Root", "Parent", "Child"]
 * ```
 */
export const toPath = (ns: NamespaceNode | undefined): string[] => {
  if (!ns) return [];
  const path: string[] = [];
  let current: NamespaceNode | undefined = ns;
  while (current) {
    path.unshift(current.Id);
    current = current.Parent;
  }
  return path;
};

/**
 * Create a fully-qualified name (FQN) from a namespace and logical ID.
 * The FQN is a flat key suitable for state storage.
 *
 * @example
 * ```ts
 * const ns = { Id: "Child", Parent: { Id: "Parent" } };
 * toFqn(ns, "MyResource"); // "Parent/Child/MyResource"
 * toFqn(undefined, "MyResource"); // "MyResource"
 * ```
 */
export const toFqn = (
  ns: NamespaceNode | undefined,
  logicalId: string,
): string => {
  const path = toPath(ns);
  path.push(logicalId);
  return path.join(FQN_SEPARATOR);
};

/**
 * Parse an FQN back into namespace path segments and the logical ID.
 *
 * @example
 * ```ts
 * parseFqn("Parent/Child/MyResource"); // { path: ["Parent", "Child"], logicalId: "MyResource" }
 * parseFqn("MyResource"); // { path: [], logicalId: "MyResource" }
 * ```
 */
export const parseFqn = (
  fqn: string,
): { path: string[]; logicalId: string } => {
  const parts = fqn.split(FQN_SEPARATOR);
  const logicalId = parts.pop()!;
  return { path: parts, logicalId };
};

/**
 * Reconstruct a NamespaceNode chain from a path array.
 *
 * @example
 * ```ts
 * fromPath(["Parent", "Child"]);
 * // { Id: "Child", Parent: { Id: "Parent" } }
 * ```
 */
export const fromPath = (path: string[]): NamespaceNode | undefined => {
  if (path.length === 0) return undefined;
  let node: NamespaceNode | undefined;
  for (const id of path) {
    node = { Id: id, Parent: node };
  }
  return node;
};
