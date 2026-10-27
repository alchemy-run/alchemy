/**
 * A path-glob matcher that runs in O(path × pattern) time for every pattern.
 *
 * Glob dialects (gitignore, dockerignore, include/exclude globs) used to be
 * compiled to JavaScript regular expressions. A backtracking regex engine
 * takes exponential time on patterns such as `a*a*a*a*a*a*a*a`, so a short
 * line in an ignore file could hang the CLI. This module compiles a pattern
 * into a list of tokens and matches by tracking every position the pattern
 * could be at after each character (an NFA simulation), which never
 * backtracks.
 *
 * Each dialect decides how its syntax maps onto the tokens; see
 * {@link compileGlob}.
 */

/** One step of a compiled pattern. */
export type GlobToken =
  /** One literal character. */
  | { readonly kind: "char"; readonly char: string }
  /** Any one character except `/`. */
  | { readonly kind: "any" }
  /** Any run of characters (possibly empty) without `/`. */
  | { readonly kind: "star" }
  /** Any run of characters (possibly empty), `/` included. */
  | { readonly kind: "globstar" }
  /** Zero or more whole directories: empty, or any run ending in `/`. */
  | { readonly kind: "dirs" }
  /** One character (never `/`) from a bracket expression. */
  | { readonly kind: "class"; readonly test: (char: string) => boolean };

export interface GlobOptions {
  /**
   * How `**` that is not a whole path segment (`a**b`) behaves: like `*`
   * (git) or like a run that may cross `/` (Docker).
   * @default "star"
   */
  readonly innerGlobstar?: "star" | "globstar";
  /**
   * What an unterminated `[` means: a pattern that matches nothing (git) or
   * a literal `[` (Docker).
   * @default "never"
   */
  readonly unclosedBracket?: "never" | "literal";
  /** Compare letters case-insensitively. @default false */
  readonly caseInsensitive?: boolean;
}

export interface Glob {
  readonly tokens: ReadonlyArray<GlobToken>;
  /** Whether `path` matches the whole pattern. */
  readonly test: (path: string) => boolean;
}

const POSIX_CLASSES: Record<string, (char: string) => boolean> = {
  alnum: (c) => /[0-9A-Za-z]/.test(c),
  alpha: (c) => /[A-Za-z]/.test(c),
  blank: (c) => c === " " || c === "\t",
  cntrl: (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
  digit: (c) => c >= "0" && c <= "9",
  graph: (c) => c.charCodeAt(0) > 32 && c.charCodeAt(0) < 127,
  lower: (c) => c >= "a" && c <= "z",
  print: (c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) < 127,
  punct: (c) => /[!-/:-@[-`{-~]/.test(c),
  space: (c) => /[ \t\n\v\f\r]/.test(c),
  upper: (c) => c >= "A" && c <= "Z",
  xdigit: (c) => /[0-9A-Fa-f]/.test(c),
};

/**
 * Parse the bracket expression starting at `pattern[start] === "["`, with
 * git's wildmatch rules: `!` or `^` negates, a leading `]` is literal, `\`
 * escapes, `a-z` is a range and `[:digit:]` a POSIX class.
 *
 * @returns the matcher and the index just past the closing `]`, or
 *   `undefined` when the expression never closes (or names an unknown
 *   POSIX class).
 */
const parseBracket = (
  pattern: string,
  start: number,
  caseInsensitive: boolean,
): { test: (char: string) => boolean; end: number } | undefined => {
  let i = start + 1;
  const negated = pattern[i] === "!" || pattern[i] === "^";
  if (negated) i++;
  const tests: Array<(char: string) => boolean> = [];
  let first = true;
  while (i < pattern.length && (first || pattern[i] !== "]")) {
    first = false;
    let char = pattern[i]!;
    if (char === "[" && pattern[i + 1] === ":") {
      const close = pattern.indexOf(":]", i + 2);
      if (close !== -1) {
        const name = pattern.slice(i + 2, close);
        const test = POSIX_CLASSES[name];
        if (test === undefined) return undefined;
        tests.push(test);
        i = close + 2;
        continue;
      }
    }
    if (char === "\\") {
      i++;
      if (i >= pattern.length) return undefined;
      char = pattern[i]!;
    }
    i++;
    if (pattern[i] === "-" && i + 1 < pattern.length && pattern[i + 1] !== "]") {
      let high = pattern[i + 1]!;
      i += 2;
      if (high === "\\") {
        if (i >= pattern.length) return undefined;
        high = pattern[i]!;
        i++;
      }
      const low = char;
      tests.push((c) => c >= low && c <= high);
      continue;
    }
    const literal = char;
    tests.push((c) => c === literal);
  }
  if (i >= pattern.length) return undefined;
  const matches = (c: string) => tests.some((test) => test(c));
  const folded = caseInsensitive
    ? (c: string) => matches(c) || matches(c.toLowerCase()) || matches(c.toUpperCase())
    : matches;
  return { test: negated ? (c) => !folded(c) : folded, end: i + 1 };
};

/**
 * Compile a glob. `*` and `?` never match `/`; `**` as a whole segment
 * matches across directories (`**​/` zero or more directories, a trailing
 * `**` everything below); `\` escapes the next character.
 *
 * Returns `undefined` when the pattern can never match (an unterminated
 * bracket expression under `unclosedBracket: "never"`).
 */
export const compileGlob = (pattern: string, options: GlobOptions = {}): Glob | undefined => {
  const { innerGlobstar = "star", unclosedBracket = "never", caseInsensitive = false } = options;
  const tokens: GlobToken[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "\\" && i + 1 < pattern.length) {
      tokens.push({ kind: "char", char: pattern[++i]! });
    } else if (char === "*") {
      let end = i;
      while (pattern[end + 1] === "*") end++;
      const run = end - i + 1;
      const atSegmentStart = i === 0 || pattern[i - 1] === "/";
      const next = pattern[end + 1];
      i = end;
      if (run >= 2 && next === "/" && (atSegmentStart || innerGlobstar === "globstar")) {
        tokens.push({ kind: "dirs" });
        i++; // the `/` is part of the token
      } else if (
        run >= 2 &&
        ((atSegmentStart && next === undefined) || innerGlobstar === "globstar")
      ) {
        tokens.push({ kind: "globstar" });
      } else {
        tokens.push({ kind: "star" });
      }
    } else if (char === "?") {
      tokens.push({ kind: "any" });
    } else if (char === "[") {
      const bracket = parseBracket(pattern, i, caseInsensitive);
      if (bracket !== undefined) {
        tokens.push({ kind: "class", test: bracket.test });
        i = bracket.end - 1;
      } else if (unclosedBracket === "literal") {
        tokens.push({ kind: "char", char });
      } else {
        return undefined;
      }
    } else {
      tokens.push({ kind: "char", char });
    }
  }
  return { tokens, test: (path) => matchTokens(tokens, path, caseInsensitive) };
};

// State `2 * i` is "before token i"; `2 * i + 1` is "inside a `dirs` token i,
// having consumed some characters but not yet the closing `/`".
const matchTokens = (
  tokens: ReadonlyArray<GlobToken>,
  path: string,
  caseInsensitive: boolean,
): boolean => {
  const size = 2 * (tokens.length + 1);
  let current = new Uint8Array(size);
  let next = new Uint8Array(size);
  const fold = caseInsensitive ? (c: string) => c.toLowerCase() : (c: string) => c;

  // Add state `s` and everything reachable from it without input.
  const close = (states: Uint8Array, s: number) => {
    while (!states[s]) {
      states[s] = 1;
      if (s % 2 === 1) return;
      const token = tokens[s / 2];
      if (token === undefined) return;
      // `star`, `globstar` and `dirs` all match the empty string.
      if (token.kind !== "star" && token.kind !== "globstar" && token.kind !== "dirs") return;
      s += 2;
    }
  };

  close(current, 0);
  for (const char of path) {
    next.fill(0);
    for (let s = 0; s < size; s++) {
      if (!current[s]) continue;
      const i = s >> 1;
      const token = tokens[i];
      if (token === undefined) continue;
      if (s % 2 === 1) {
        // Inside `dirs`: keep consuming, or end the run at a `/`.
        close(next, s);
        if (char === "/") close(next, 2 * (i + 1));
        continue;
      }
      switch (token.kind) {
        case "char":
          if (fold(char) === fold(token.char)) close(next, 2 * (i + 1));
          break;
        case "any":
          if (char !== "/") close(next, 2 * (i + 1));
          break;
        case "class":
          if (char !== "/" && token.test(char)) close(next, 2 * (i + 1));
          break;
        case "star":
          if (char !== "/") close(next, s);
          break;
        case "globstar":
          close(next, s);
          break;
        case "dirs":
          close(next, s + 1);
          if (char === "/") close(next, 2 * (i + 1));
          break;
      }
    }
    if (!next.includes(1)) return false;
    [current, next] = [next, current];
  }
  return current[2 * tokens.length] === 1;
};
