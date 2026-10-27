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
 * The encoding is one-to-one only for FQNs that {@link invalidFqnReason}
 * accepts; resources and actions are refused at registration otherwise.
 */
export const encodeFqn = (fqn: string): string => fqn.replaceAll(FQN_SEPARATOR, "__");

/**
 * Why `fqn` can't be stored, or `undefined` when it can.
 *
 * {@link encodeFqn} turns `/` into `__`, so an id containing `__`, or an `_`
 * at either end of a segment, could encode to another resource's file name
 * (`My/Resource` and `My__Resource` both become `My__Resource`) and the two
 * would share one state row. It could also take the name of a store's own
 * bookkeeping files (`__stack_output__`). Refusing those ids keeps every
 * `__` in an encoded name a separator.
 */
export const invalidFqnReason = (fqn: string): string | undefined => {
  if (fqn.includes("__")) return "it contains '__'";
  if (/(^|\/)_|_($|\/)/.test(fqn)) return "an id starts or ends with '_'";
  return undefined;
};

/**
 * A logical id (or a namespace above it) can't be stored without colliding
 * with another resource's state; see {@link invalidFqnReason}.
 */
export class InvalidLogicalIdError extends Data.TaggedError("InvalidLogicalIdError")<{
  message: string;
  /** Fully qualified logical id that was refused. */
  fqn: string;
}> {}

/** Refuse an FQN whose state file name another FQN could share. */
export const validateFqn = (fqn: string, kind: string) => {
  const reason = invalidFqnReason(fqn);
  return reason === undefined
    ? Effect.void
    : Effect.die(
        new InvalidLogicalIdError({
          message:
            `${kind} '${fqn}' can't be stored: ${reason}. State files are named after ` +
            `the id with '/' written as '__', so this id could share a file with ` +
            `another one. Rename it (e.g. 'My__Bucket' -> 'MyBucket').`,
          fqn,
        }),
      );
};

/**
 * Decode a filename back to FQN.
 */
export const decodeFqn = (filename: string): string => filename.replaceAll("__", FQN_SEPARATOR);

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
