// oxlint-disable unicorn/prefer-string-starts-ends-with no-control-regex

// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
//
import { compileGlob, type Glob } from "./glob.ts";

// TypeScript port of `ignore` (https://github.com/kaelzhang/node-ignore) v7.0.5.
// Copyright (c) 2013 Kael Zhang <i@kael.me>, contributors. MIT License.

function makeArray<T>(subject: T | readonly T[]): T[] {
  return Array.isArray(subject) ? [...subject] : [subject as T];
}

const UNDEFINED = undefined;
const EMPTY = "";
const SPACE = " ";
const ESCAPE = "\\";
const REGEX_TEST_BLANK_LINE = /^\s+$/;
const REGEX_INVALID_TRAILING_BACKSLASH = /(?:[^\\]|^)\\$/;
const REGEX_REPLACE_LEADING_EXCAPED_EXCLAMATION = /^\\!/;
const REGEX_REPLACE_LEADING_EXCAPED_HASH = /^\\#/;
const REGEX_SPLITALL_CRLF = /\r?\n/g;

// Invalid:
// - /foo,
// - ./foo,
// - ../foo,
// - .
// - ..
// Valid:
// - .foo
const REGEX_TEST_INVALID_PATH = /^\.{0,2}\/|^\.{1,2}$/;

const REGEX_TEST_TRAILING_SLASH = /\/$/;
const MODE_IGNORE = "regex";
const MODE_CHECK_IGNORE = "checkRegex";

type MatcherMode = typeof MODE_IGNORE | typeof MODE_CHECK_IGNORE;

const SLASH = "/";

// Do not use ternary expression here, since "istanbul ignore next" is buggy
let TMP_KEY_IGNORE: string | symbol = "node-ignore";
/* istanbul ignore else */
if (typeof Symbol !== "undefined") {
  TMP_KEY_IGNORE = Symbol.for("node-ignore");
}
const KEY_IGNORE = TMP_KEY_IGNORE;

const define = <T>(object: object, key: PropertyKey, value: T): T => {
  Object.defineProperty(object, key, { value });
  return value;
};

const RETURN_FALSE = () => false;

const isString = (subject: unknown): subject is string => typeof subject === "string";

// > A blank line matches no files, so it can serve as a separator for readability.
const checkPattern = (pattern: string): boolean =>
  Boolean(
    pattern &&
    !REGEX_TEST_BLANK_LINE.test(pattern) &&
    !REGEX_INVALID_TRAILING_BACKSLASH.test(pattern) &&
    // > A line starting with # serves as a comment.
    pattern.indexOf("#") !== 0,
  );

const splitPattern = (pattern: string): string[] =>
  pattern.split(REGEX_SPLITALL_CRLF).filter(Boolean);

// Alchemy modification: rules match with the linear-time engine in
// `glob.ts` instead of upstream's compiled regular expressions, which
// backtrack exponentially on patterns like `a**a**a**a**a**a**a**a`. The
// engine also implements POSIX bracket classes (`[[:digit:]]`), which the
// regex compiler silently failed to match.

// > Trailing spaces are ignored unless they are quoted with backslash ("\")
const REGEX_TRAILING_SPACES = /((?:\\\\)*?)(\\?\s+)$/;

class IgnoreRule {
  readonly pattern: string;
  readonly mark: string | undefined;
  readonly negative: boolean;
  readonly body!: string;
  readonly ignoreCase!: boolean;
  private _matcher?: RuleMatcher | null;

  constructor(
    pattern: string,
    mark: string | undefined,
    body: string,
    ignoreCase: boolean,
    negative: boolean,
  ) {
    this.pattern = pattern;
    this.mark = mark;
    this.negative = negative;

    define(this, "body", body);
    define(this, "ignoreCase", ignoreCase);
  }

  // `path` is relative; a trailing `/` marks a directory.
  test(path: string, mode: MatcherMode): boolean {
    if (this._matcher === undefined) {
      this._matcher = compileRule(this.body, this.ignoreCase) ?? null;
    }
    const matcher = this._matcher;
    if (matcher === null) return false;
    const isDirectory = REGEX_TEST_TRAILING_SLASH.test(path);
    if (matcher.directoryOnly && !isDirectory) return false;
    const stripped = isDirectory ? path.slice(0, -1) : path;
    // > If there is a separator at the beginning or middle (or both) of the
    // > pattern, then the pattern is relative to the directory level of the
    // > particular .gitignore file itself. Otherwise the pattern may also
    // > match at any level below the .gitignore level.
    const target = matcher.anchored ? stripped : stripped.slice(stripped.lastIndexOf(SLASH) + 1);
    if (matcher.glob.test(target)) return true;
    // When doing `git check-ignore`, 'abc/*' DOES match 'abc/'.
    return (
      mode === MODE_CHECK_IGNORE &&
      isDirectory &&
      matcher.parent !== undefined &&
      matcher.parent.test(target)
    );
  }
}

interface RuleMatcher {
  readonly glob: Glob;
  // > If there is a separator at the end of the pattern then the pattern
  // > will only match directories.
  readonly directoryOnly: boolean;
  readonly anchored: boolean;
  // For a pattern ending in `/*`, the pattern without it.
  readonly parent: Glob | undefined;
}

const compileRule = (body: string, ignoreCase: boolean): RuleMatcher | undefined => {
  let pattern = body
    // Remove BOM
    .replace(/^\uFEFF/, EMPTY)
    // (a\ ) -> (a )
    // (a  ) -> (a)
    // (a \ ) -> (a  )
    .replace(
      REGEX_TRAILING_SPACES,
      (_, m1: string, m2: string) => m1 + (m2.indexOf(ESCAPE) === 0 ? `${ESCAPE}${SPACE}` : EMPTY),
    );
  const directoryOnly = REGEX_TEST_TRAILING_SLASH.test(pattern);
  if (directoryOnly) pattern = pattern.slice(0, -1);
  // > A leading slash matches the beginning of the pathname.
  const anchored = pattern.includes(SLASH);
  if (pattern.startsWith(SLASH)) pattern = pattern.slice(1);
  if (!pattern) return UNDEFINED;
  const options = { caseInsensitive: ignoreCase };
  const glob = compileGlob(pattern, options);
  if (glob === UNDEFINED) return UNDEFINED;
  const parent =
    pattern.endsWith("/*") && !pattern.endsWith("\\/*")
      ? compileGlob(pattern.slice(0, -2), options)
      : UNDEFINED;
  return { glob, directoryOnly, anchored, parent };
};

const createRule = ({ pattern, mark }: PatternParams, ignoreCase: boolean): IgnoreRule => {
  let negative = false;
  let body = pattern;

  // > An optional prefix "!" which negates the pattern;
  if (body.indexOf("!") === 0) {
    negative = true;
    body = body.substr(1);
  }

  body = body
    // > Put a backslash ("\") in front of the first "!" for patterns that
    // >   begin with a literal "!", for example, `"\!important!.txt"`.
    .replace(REGEX_REPLACE_LEADING_EXCAPED_EXCLAMATION, "!")
    // > Put a backslash ("\") in front of the first hash for patterns that
    // >   begin with a hash.
    .replace(REGEX_REPLACE_LEADING_EXCAPED_HASH, "#");

  return new IgnoreRule(pattern, mark, body, ignoreCase, negative);
};

class RuleManager {
  private readonly _ignoreCase: boolean;
  _rules: IgnoreRule[] = [];
  private _added = false;

  constructor(ignoreCase: boolean) {
    this._ignoreCase = ignoreCase;
  }

  _add(pattern: string | Ignore | PatternParams): void {
    // #32
    const ignorePattern = pattern as Ignore & Record<PropertyKey, unknown>;
    if (pattern && ignorePattern[KEY_IGNORE]) {
      this._rules = this._rules.concat(ignorePattern._rules._rules);
      this._added = true;
      return;
    }

    if (isString(pattern)) {
      pattern = {
        pattern,
      };
    }

    const patternParams = pattern as PatternParams;
    if (checkPattern(patternParams.pattern)) {
      const rule = createRule(patternParams, this._ignoreCase);
      this._added = true;
      this._rules.push(rule);
    }
  }

  // @param {Array<string> | string | Ignore} pattern
  add(pattern: string | Ignore | PatternParams | readonly (string | Ignore)[]): boolean {
    this._added = false;

    const patterns: readonly (string | Ignore | PatternParams)[] = isString(pattern)
      ? splitPattern(pattern)
      : Array.isArray(pattern)
        ? pattern
        : [pattern as Ignore | PatternParams];
    patterns.forEach(this._add, this);

    return this._added;
  }

  // Test one single path without recursively checking parent directories
  //
  // - checkUnignored `boolean` whether should check if the path is unignored,
  //   setting `checkUnignored` to `false` could reduce additional
  //   path matching.
  // - check `string` either `MODE_IGNORE` or `MODE_CHECK_IGNORE`

  // @returns {TestResult} true if a file is ignored
  test(path: string, checkUnignored: boolean, mode: MatcherMode): IgnoreTestResult {
    let ignored = false;
    let unignored = false;
    let matchedRule: IgnoreRule | undefined;

    this._rules.forEach((rule) => {
      const { negative } = rule;

      //          |           ignored : unignored
      // -------- | ---------------------------------------
      // negative |   0:0   |   0:1   |   1:0   |   1:1
      // -------- | ------- | ------- | ------- | --------
      //     0    |  TEST   |  TEST   |  SKIP   |    X
      //     1    |  TESTIF |  SKIP   |  TEST   |    X

      // - SKIP: always skip
      // - TEST: always test
      // - TESTIF: only test if checkUnignored
      // - X: that never happen
      if (
        (unignored === negative && ignored !== unignored) ||
        (negative && !ignored && !unignored && !checkUnignored)
      ) {
        return;
      }

      const matched = rule.test(path, mode);

      if (!matched) {
        return;
      }

      ignored = !negative;
      unignored = negative;

      matchedRule = negative ? UNDEFINED : rule;
    });

    const ret: IgnoreTestResult = {
      ignored,
      unignored,
    };

    if (matchedRule) {
      ret.rule = matchedRule;
    }

    return ret;
  }
}

type ErrorConstructor = new (message: string) => Error;
type InvalidPathHandler = (message: string, constructor: ErrorConstructor) => boolean;

const throwError: InvalidPathHandler = (message, Ctor) => {
  throw new Ctor(message);
};

interface CheckPath {
  (path: unknown, originalPath: unknown, doThrow: InvalidPathHandler): boolean;
  isNotRelative: (path: string) => boolean;
  convert: (path: string) => string;
}

const checkPath: CheckPath = (path, originalPath, doThrow) => {
  if (!isString(path)) {
    return doThrow(`path must be a string, but got \`${originalPath}\``, TypeError);
  }

  // We don't know if we should ignore EMPTY, so throw
  if (!path) {
    return doThrow(`path must not be empty`, TypeError);
  }

  // Check if it is a relative path
  if (checkPath.isNotRelative(path)) {
    const r = "`path.relative()`d";
    return doThrow(`path should be a ${r} string, but got "${originalPath}"`, RangeError);
  }

  return true;
};

const isNotRelative = (path: string): boolean => REGEX_TEST_INVALID_PATH.test(path);

checkPath.isNotRelative = isNotRelative;

// On windows, the following function will be replaced
/* istanbul ignore next */
checkPath.convert = (path) => path;

class Ignore {
  readonly [KEY_IGNORE]?: true;
  readonly _rules: RuleManager;
  private readonly _strictPathCheck: boolean;
  private _ignoreCache!: Record<string, IgnoreTestResult>;
  private _testCache!: Record<string, IgnoreTestResult>;

  constructor({
    ignorecase = true,
    ignoreCase = ignorecase,
    allowRelativePaths = false,
  }: IgnoreOptions = {}) {
    define(this, KEY_IGNORE, true);

    this._rules = new RuleManager(ignoreCase);
    this._strictPathCheck = !allowRelativePaths;
    this._initCache();
  }

  _initCache(): void {
    // A cache for the result of `.ignores()`
    this._ignoreCache = Object.create(null);

    // A cache for the result of `.test()`
    this._testCache = Object.create(null);
  }

  add(pattern: string | Ignore | readonly (string | Ignore)[] | PatternParams): this {
    if (this._rules.add(pattern)) {
      // Some rules have just added to the ignore,
      //   making the behavior changed,
      //   so we need to re-initialize the result cache
      this._initCache();
    }

    return this;
  }

  // legacy
  addPattern(pattern: string | readonly string[]): this {
    return this.add(pattern);
  }

  // @returns {TestResult}
  _test(
    originalPath: string,
    cache: Record<string, IgnoreTestResult>,
    checkUnignored: boolean,
    slices?: string[],
  ): IgnoreTestResult {
    const path =
      originalPath &&
      // Supports nullable path
      checkPath.convert(originalPath);

    checkPath(path, originalPath, this._strictPathCheck ? throwError : RETURN_FALSE);

    return this._t(path, cache, checkUnignored, slices);
  }

  checkIgnore(path: string): IgnoreTestResult {
    // If the path doest not end with a slash, `.ignores()` is much equivalent
    //   to `git check-ignore`
    if (!REGEX_TEST_TRAILING_SLASH.test(path)) {
      return this.test(path);
    }

    const slices = path.split(SLASH).filter(Boolean);
    slices.pop();

    if (slices.length) {
      const parent = this._t(slices.join(SLASH) + SLASH, this._testCache, true, slices);

      if (parent.ignored) {
        return parent;
      }
    }

    return this._rules.test(path, false, MODE_CHECK_IGNORE);
  }

  _t(
    // The path to be tested
    path: string,

    // The cache for the result of a certain checking
    cache: Record<string, IgnoreTestResult>,

    // Whether should check if the path is unignored
    checkUnignored: boolean,

    // The path slices
    slices?: string[],
  ): IgnoreTestResult {
    if (path in cache) {
      return cache[path];
    }

    if (!slices) {
      // path/to/a.js
      // ['path', 'to', 'a.js']
      slices = path.split(SLASH).filter(Boolean);
    }

    slices.pop();

    // If the path has no parent directory, just test it
    if (!slices.length) {
      return (cache[path] = this._rules.test(path, checkUnignored, MODE_IGNORE));
    }

    const parent = this._t(slices.join(SLASH) + SLASH, cache, checkUnignored, slices);

    // If the path contains a parent directory, check the parent first
    return (cache[path] = parent.ignored
      ? // > It is not possible to re-include a file if a parent directory of
        // >   that file is excluded.
        parent
      : this._rules.test(path, checkUnignored, MODE_IGNORE));
  }

  ignores(path: string): boolean {
    return this._test(path, this._ignoreCache, false).ignored;
  }

  // Alchemy addition: match one path against the rules without checking its
  // parent directories, so callers can start the parent walk below a
  // boundary (e.g. a working directory inside an ignored folder).
  matches(path: string): IgnoreTestResult {
    return this._rules.test(checkPath.convert(path), true, MODE_IGNORE);
  }

  createFilter(): (path: string) => boolean {
    return (path: string) => !this.ignores(path);
  }

  filter(paths: readonly string[]): string[] {
    return makeArray(paths).filter(this.createFilter());
  }

  // @returns {TestResult}
  test(path: string): IgnoreTestResult {
    return this._test(path, this._testCache, true);
  }
}

const factory = (options?: IgnoreOptions): Ignore => new Ignore(options);

const isPathValid = (path: string): boolean =>
  checkPath(path && checkPath.convert(path), path, RETURN_FALSE);

const setupWindows = () => {
  const makePosix = (str: string): string =>
    /^\\\\\?\\/.test(str) || /["<>|\u0000-\u001F]+/u.test(str) ? str : str.replace(/\\/g, "/");

  checkPath.convert = makePosix;

  // 'C:\\foo'     <- 'C:\\foo' has been converted to 'C:/'
  // 'd:\\foo'
  const REGEX_TEST_WINDOWS_PATH_ABSOLUTE = /^[a-z]:\//i;
  checkPath.isNotRelative = (path: string) =>
    REGEX_TEST_WINDOWS_PATH_ABSOLUTE.test(path) || isNotRelative(path);
};

// Windows
// --------------------------------------------------------------
/* istanbul ignore next */
if (
  // Detect `process` so that it can run in browsers.
  typeof process !== "undefined" &&
  process.platform === "win32"
) {
  setupWindows();
}

// ES module exports (upstream uses `module.exports`). Upstream also exposes
// `setupWindows` via `Symbol.for("setupWindows")` for its own test suite; we
// drop that hook since it's unused.

export default factory as unknown as (options?: IgnoreOptions) => IgnoreInstance;
export { Ignore, isPathValid };

// --- Type declarations -----------------------------------------------------
// (not part of the verbatim upstream source; mirrors upstream `index.d.ts`)

type Pathname = string;

interface PatternParams {
  pattern: string;
  mark?: string;
}

interface IgnoreTestResult {
  ignored: boolean;
  unignored: boolean;
  rule?: IgnoreRule;
}

export interface IgnoreOptions {
  ignorecase?: boolean;
  /** For compatibility. */
  ignoreCase?: boolean;
  allowRelativePaths?: boolean;
}

export interface IgnoreInstance {
  add(
    patterns: string | IgnoreInstance | readonly (string | IgnoreInstance)[] | PatternParams,
  ): this;
  filter(pathnames: readonly Pathname[]): Pathname[];
  createFilter(): (pathname: Pathname) => boolean;
  ignores(pathname: Pathname): boolean;
  /** Alchemy addition: match one path without checking parent directories. */
  matches(pathname: Pathname): {
    ignored: boolean;
    unignored: boolean;
  };
  test(pathname: Pathname): {
    ignored: boolean;
    unignored: boolean;
    rule?: { pattern: string; mark?: string; negative: boolean };
  };
  checkIgnore(pathname: Pathname): {
    ignored: boolean;
    unignored: boolean;
    rule?: { pattern: string; mark?: string; negative: boolean };
  };
}
