import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { NamespaceNode } from "./Namespace.ts";

/**
 * Separator used in FQN strings.
 */
export const FQN_SEPARATOR = "/";

/**
 * Encode an FQN for safe filesystem storage.
 * Replaces `/` (FQN separator) with `__` to avoid subdirectory creation.
 *
 * Not one-to-one: `My/Bucket` and `My__Bucket` both encode to `My__Bucket`.
 * Stores that key rows by this encoding refuse FQNs that
 * {@link encodedFqnReason} rejects.
 */
export const encodeFqn = (fqn: string): string => fqn.replaceAll(FQN_SEPARATOR, "__");

/**
 * Decode a filename back to FQN.
 */
export const decodeFqn = (filename: string): string => filename.replaceAll("__", FQN_SEPARATOR);

/**
 * Why a store that names rows `encodeFqn(fqn)` can't hold `fqn`, or
 * `undefined` when it can.
 *
 * A row's FQN is read back from its name with {@link decodeFqn}, so an FQN
 * is safe exactly when decoding its encoded name gives it back. Every safe
 * FQN then has a name no other safe FQN shares (decoding that name can only
 * return one of them). `My__Bucket` is refused: its name decodes to
 * `My/Bucket`, so the store would list a resource that isn't declared and
 * plan to delete it.
 */
export const encodedFqnReason = (fqn: string): string | undefined =>
  decodeFqn(encodeFqn(fqn)) === fqn
    ? undefined
    : `its state file name reads back as '${decodeFqn(encodeFqn(fqn))}'`;

/**
 * A logical id (or a namespace above it) can't be stored in the configured
 * state store without being mistaken for another one.
 */
export class InvalidLogicalIdError extends Data.TaggedError("InvalidLogicalIdError")<{
  message: string;
  /** Fully qualified logical id that was refused. */
  fqn: string;
}> {}

/** Die with {@link InvalidLogicalIdError} when `reason` is defined. */
export const refuseFqn = (fqn: string, kind: string, reason: string | undefined) =>
  reason === undefined
    ? Effect.void
    : Effect.die(
        new InvalidLogicalIdError({
          message:
            `${kind} '${fqn}' can't be stored in this state store: ${reason}. ` +
            `The store writes '/' as '__' in file names, so ids may not contain ` +
            `'__', and a namespace may not end in '_'. Rename it (e.g. 'My__Bucket' -> 'MyBucket').`,
          fqn,
        }),
      );

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
export const toFqn = (ns: NamespaceNode | undefined, logicalId: string): string => {
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
export const parseFqn = (fqn: string): { path: string[]; logicalId: string } => {
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
