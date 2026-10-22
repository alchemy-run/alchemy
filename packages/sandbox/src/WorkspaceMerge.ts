/**
 * The merge rule of a workspace, as plain functions: which of a patch's
 * paths conflict with changes made since its base.
 *
 * Two paths conflict when they're the same path or one is inside the other
 * (deleting a directory conflicts with adding a file to it), unless both
 * match an `lww` pattern: there the newest change wins.
 *
 * Shared by every workspace host (NOT exported from `index.ts`).
 */

/** Whether `a` and `b` are the same path, or one is inside the other. */
export const related = (a: string, b: string) =>
  a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

const escape = (text: string) => text.replace(/[.+^${}()|[\]\\]/g, "\\$&");

/** A glob as a regular expression: `*` within a name, `**` across directories. */
const compile = (pattern: string): RegExp => {
  const trimmed = pattern.replace(/^\/+/, "").replace(/\/+$/, "");
  // A pattern without a slash matches a name at any depth.
  const segments = (trimmed.includes("/") ? trimmed : `**/${trimmed}`).split("/");
  let source = "";
  segments.forEach((segment, i) => {
    const first = i === 0;
    const last = i === segments.length - 1;
    if (segment === "**") {
      // `a/**` matches `a` itself; `**/b` matches `b` at the root.
      source += first && last ? ".*" : last ? "(?:/.*)?" : first ? "(?:.*/)?" : "/(?:.*/)?";
      return;
    }
    if (!first && segments[i - 1] !== "**") source += "/";
    source += [...segment]
      .map((c) => (c === "*" ? "[^/]*" : c === "?" ? "[^/]" : escape(c)))
      .join("");
  });
  return new RegExp(`^${source}$`);
};

const cache = new Map<string, RegExp>();

/** Whether `path` matches one of `patterns`. */
export const matches = (path: string, patterns: ReadonlyArray<string>) =>
  patterns.some((pattern) => {
    let compiled = cache.get(pattern);
    if (!compiled) {
      compiled = compile(pattern);
      cache.set(pattern, compiled);
    }
    return compiled.test(path);
  });

/**
 * The paths of `patch` that conflict with `since`: every change logged
 * after the patch's base. `null` in `since` is a change nobody could name
 * (everything may have changed).
 */
export const conflicts = (
  patch: ReadonlyArray<string>,
  since: ReadonlyArray<ReadonlyArray<string> | null>,
  lww: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const found = new Set<string>();
  for (const path of patch) {
    const newest = matches(path, lww);
    for (const entry of since) {
      if (entry === null) {
        if (!newest) found.add(path);
        continue;
      }
      if (entry.some((other) => related(path, other) && !(newest && matches(other, lww)))) {
        found.add(path);
      }
    }
  }
  return [...found].sort();
};
