/**
 * The Files-changed filter: a line of globs, typed the way a `.gitignore`
 * or a shell reads them, deciding which of a PR's paths stay in view.
 *
 * - patterns are separated by whitespace or commas
 * - `*` matches within one path segment, `**` across segments, `?` one
 *   character, `{a,b}` either
 * - a pattern with no `/` matches the file's BASENAME (`*.ts` finds
 *   `src/a.ts`); with a `/` it matches the whole path from the root
 * - a bare word with no glob characters matches anywhere in the path
 *   (`review` finds `src/review/Reviewer.ts`)
 * - `!pattern` EXCLUDES; a filter of only exclusions starts from all
 *
 * Empty (or whitespace) keeps everything.
 */
export interface FileFilter {
  /** Whether `path` is shown under the filter. */
  readonly matches: (path: string) => boolean;
  /** True when the filter narrows anything at all. */
  readonly active: boolean;
}

const GLOB_CHARS = /[*?{[]/;

const escape = (s: string): string => s.replace(/[.+^$()|[\]\\]/g, "\\$&");

/** One glob → a RegExp over a whole path (or basename). */
const toRegExp = (glob: string): RegExp => {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // `**/` swallows any number of directories, including none
        i++;
        if (glob[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else out += ".*";
      } else out += "[^/]*";
    } else if (ch === "?") out += "[^/]";
    else if (ch === "{") {
      const close = glob.indexOf("}", i);
      if (close === -1) out += "\\{";
      else {
        out += `(?:${glob
          .slice(i + 1, close)
          .split(",")
          .map(escape)
          .join("|")})`;
        i = close;
      }
    } else out += escape(ch);
  }
  return new RegExp(`^${out}$`);
};

interface Rule {
  readonly negated: boolean;
  readonly test: (path: string) => boolean;
}

const toRule = (token: string): Rule | undefined => {
  const negated = token.startsWith("!");
  const body = negated ? token.slice(1) : token;
  if (body === "") return undefined;
  if (!GLOB_CHARS.test(body)) {
    // a bare word: anywhere in the path (a `/` inside narrows the same way)
    const needle = body.toLowerCase();
    return { negated, test: (path) => path.toLowerCase().includes(needle) };
  }
  const re = toRegExp(body.replace(/^\.\//, ""));
  const whole = body.includes("/");
  return {
    negated,
    test: (path) =>
      re.test(whole ? path : (path.slice(path.lastIndexOf("/") + 1) ?? path)),
  };
};

/** Split on whitespace and commas — except the commas inside `{a,b}`. */
const tokenize = (input: string): string[] => {
  const tokens: string[] = [];
  let current = "";
  let depth = 0;
  for (const ch of input) {
    if (ch === "{") depth++;
    else if (ch === "}") depth = Math.max(0, depth - 1);
    if ((/\s/.test(ch) || ch === ",") && depth === 0) {
      if (current !== "") tokens.push(current);
      current = "";
    } else current += ch;
  }
  if (current !== "") tokens.push(current);
  return tokens;
};

export const parseFileFilter = (input: string): FileFilter => {
  const rules = tokenize(input)
    .map(toRule)
    .filter((rule): rule is Rule => rule !== undefined);
  if (rules.length === 0) return { matches: () => true, active: false };
  const includes = rules.filter((rule) => !rule.negated);
  const excludes = rules.filter((rule) => rule.negated);
  return {
    active: true,
    matches: (path) =>
      (includes.length === 0 || includes.some((rule) => rule.test(path))) &&
      !excludes.some((rule) => rule.test(path)),
  };
};
