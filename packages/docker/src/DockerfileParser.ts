import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { isDockerByteSize } from "./internal/DockerByteSize.ts";
import { processWord, processWords } from "./ShellWord.ts";

/**
 * A Dockerfile parsed into stages and instructions, with the line each one
 * starts on. Builders that are not Docker (E2B, Modal, Daytona) lower this
 * structure into their own build steps instead of running `docker build`.
 *
 * The parser is a port of BuildKit's (`frontend/dockerfile/parser` and the
 * checks in `instructions`), and is tested against it: parser directives,
 * line continuations, heredocs, exec and shell forms, `--flag[=value]`
 * options, Docker's quoting, and the files BuildKit rejects. It does not
 * expand variables: lowering decides whether a builder expands them or
 * Alchemy does.
 */

/** The Dockerfile could not be parsed. */
export class DockerfileSyntaxError extends Data.TaggedError("DockerfileSyntaxError")<{
  readonly message: string;
  /** 1-based line the error was found on. */
  readonly line: number;
}> {}

/** A `--name` or `--name=value` option on an instruction. */
export interface Flag {
  readonly name: string;
  readonly value: string | undefined;
}

/** A heredoc attached to an instruction (`RUN <<EOF … EOF`). */
export interface Heredoc {
  /** The delimiter word, e.g. `EOF`. */
  readonly name: string;
  /** The body, without the closing delimiter line. */
  readonly content: string;
  /** `<<-`: leading tabs were stripped from the body. */
  readonly stripTabs: boolean;
  /** A quoted delimiter (`<<"EOF"`): the body is not expanded. */
  readonly quoted: boolean;
}

/** The exec form (`["bun", "index.mjs"]`) or the shell form (`bun index.mjs`). */
export type Command =
  | { readonly form: "exec"; readonly argv: ReadonlyArray<string> }
  | { readonly form: "shell"; readonly script: string };

interface InstructionBase {
  /** 1-based line the instruction starts on. */
  readonly line: number;
  /** The instruction as written: the joined logical line, plus heredoc bodies. */
  readonly raw: string;
  readonly flags: ReadonlyArray<Flag>;
}

export interface RunInstruction extends InstructionBase {
  readonly _tag: "RUN";
  readonly command: Command;
  readonly heredocs: ReadonlyArray<Heredoc>;
}

export interface CopyInstruction extends InstructionBase {
  readonly _tag: "COPY" | "ADD";
  /** Context-relative sources, URLs (ADD), or `<<NAME` heredoc references. */
  readonly sources: ReadonlyArray<string>;
  readonly destination: string;
  readonly heredocs: ReadonlyArray<Heredoc>;
}

export interface EnvInstruction extends InstructionBase {
  readonly _tag: "ENV";
  readonly vars: ReadonlyArray<readonly [name: string, value: string]>;
}

export interface ArgInstruction extends InstructionBase {
  readonly _tag: "ARG";
  readonly vars: ReadonlyArray<readonly [name: string, defaultValue: string | undefined]>;
}

export interface ValueInstruction extends InstructionBase {
  readonly _tag: "WORKDIR" | "USER" | "STOPSIGNAL";
  readonly value: string;
}

export interface CommandInstruction extends InstructionBase {
  readonly _tag: "CMD" | "ENTRYPOINT" | "SHELL";
  readonly command: Command;
}

export interface OtherInstruction extends InstructionBase {
  readonly _tag: "EXPOSE" | "LABEL" | "HEALTHCHECK" | "VOLUME" | "ONBUILD" | "MAINTAINER";
  /** Everything after the instruction name and its flags. */
  readonly args: string;
}

export type Instruction =
  | RunInstruction
  | CopyInstruction
  | EnvInstruction
  | ArgInstruction
  | ValueInstruction
  | CommandInstruction
  | OtherInstruction;

export type InstructionName = Instruction["_tag"] | "FROM";

/** One `FROM` and the instructions after it. */
export interface Stage {
  /** 1-based line of the `FROM`. */
  readonly line: number;
  /** The `FROM` line as written. */
  readonly raw: string;
  /** The base: an image reference, an earlier stage's name, or `scratch`. */
  readonly image: string;
  /** `FROM … AS name`. */
  readonly name: string | undefined;
  readonly flags: ReadonlyArray<Flag>;
  readonly instructions: ReadonlyArray<Instruction>;
}

export interface ParsedDockerfile {
  /** Parser directives, e.g. `{ syntax: "docker/dockerfile:1", escape: "\\" }`. */
  readonly directives: Readonly<Record<string, string>>;
  /** `ARG`s declared before the first `FROM`. */
  readonly globalArgs: ReadonlyArray<ArgInstruction>;
  readonly stages: ReadonlyArray<Stage>;
}

/** Each instruction's flags, as BuildKit's instruction layer declares them. */
const FLAGS: Partial<Record<InstructionName, Record<string, "bool" | "string" | "strings">>> = {
  FROM: { platform: "string" },
  RUN: { mount: "strings", network: "string", security: "string", device: "strings" },
  COPY: {
    chown: "string",
    from: "string",
    chmod: "string",
    link: "bool",
    exclude: "strings",
    parents: "bool",
  },
  ADD: {
    chown: "string",
    chmod: "string",
    link: "bool",
    "keep-git-dir": "bool",
    checksum: "string",
    unpack: "bool",
    exclude: "strings",
  },
  HEALTHCHECK: {
    interval: "string",
    timeout: "string",
    "start-period": "string",
    "start-interval": "string",
    retries: "string",
  },
};

const KNOWN = new Set<InstructionName>([
  "FROM",
  "RUN",
  "COPY",
  "ADD",
  "ENV",
  "ARG",
  "WORKDIR",
  "USER",
  "STOPSIGNAL",
  "CMD",
  "ENTRYPOINT",
  "SHELL",
  "EXPOSE",
  "LABEL",
  "HEALTHCHECK",
  "VOLUME",
  "ONBUILD",
  "MAINTAINER",
]);

const HEREDOC_CAPABLE = new Set<string>(["RUN", "COPY", "ADD"]);
const DIRECTIVES = new Set(["syntax", "escape", "check"]);
const WHITESPACE = /[\t\v\f\r ]+/;
const HEREDOC_WORD = /^(\d*)<<(-?)\s*([^<]*)$/;
const VALID_STAGE_NAME = /^[a-z][a-z0-9-_.]*$/;

const fail = (message: string, line: number) =>
  Effect.fail(new DockerfileSyntaxError({ message, line }));

/** `JSON.parse`, or `undefined` when the text is not JSON. */
const jsonOf = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const isSpace = (ch: string) => /\s/u.test(ch);

/** The instruction word and the rest of the line. */
const splitInstruction = (text: string): [string, string] => {
  const trimmed = text.trim();
  const at = trimmed.search(WHITESPACE);
  return at === -1
    ? [trimmed, ""]
    : [trimmed.slice(0, at), trimmed.slice(at).replace(WHITESPACE, "")];
};
const trimNewline = (line: string) => line.replace(/[\r\n]+$/, "");
const trimLeadingWhitespace = (line: string) => line.replace(/^\s+/u, "");
const isComment = (line: string) => trimLeadingWhitespace(line).startsWith("#");
const regexEscape = (s: string) => s.replace(/[\\^$.*+?()[\]{}|`]/g, "\\$&");

/** `[^\x]\x[ \t]*$` or a line of only `\x`: a continuation, unless the escape is escaped. */
const continuation = (escape: string) => {
  const e = regexEscape(escape);
  return new RegExp(`([^${e}])${e}[ \\t]*$|^${e}[ \\t]*$`);
};

/**
 * BuildKit's flag splitter: `--name[=value]` words before the arguments,
 * quotes and escapes resolved. Like BuildKit it walks bytes and writes each
 * byte back as a character, so a non-ASCII flag value comes out
 * double-encoded (`µ` becomes `Âµ`), as `docker build` reads it.
 */
const extractFlags = (line: string, escape: string): { rest: string; flags: string[] } => {
  const bytes = new TextEncoder().encode(line);
  const at = (pos: number) => String.fromCharCode(bytes[pos]!);
  const restFrom = (pos: number) => new TextDecoder().decode(bytes.slice(pos));
  const words: string[] = [];
  let phase: "spaces" | "word" | "quote" = "spaces";
  let word = "";
  let quote = "";
  let blankOk = false;
  for (let pos = 0; pos <= bytes.length; pos++) {
    const ch = pos < bytes.length ? at(pos) : "";
    if (phase === "spaces") {
      if (pos === bytes.length) break;
      if (isSpace(ch)) continue;
      if (ch !== "-" || pos + 1 === bytes.length || at(pos + 1) !== "-") {
        return { rest: restFrom(pos), flags: words };
      }
      phase = "word";
    }
    if (pos === bytes.length) {
      if (word !== "--" && (blankOk || word.length > 0)) words.push(word);
      break;
    }
    if (phase === "word") {
      if (isSpace(ch)) {
        phase = "spaces";
        if (word === "--") return { rest: restFrom(pos), flags: words };
        if (blankOk || word.length > 0) words.push(word);
        word = "";
        blankOk = false;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        blankOk = true;
        phase = "quote";
        continue;
      }
      if (ch === escape) {
        if (pos + 1 === bytes.length) continue;
        pos++;
        word += at(pos);
        continue;
      }
      word += ch;
      continue;
    }
    // quote
    if (ch === quote) {
      phase = "word";
      continue;
    }
    if (ch === escape) {
      if (pos + 1 === bytes.length) {
        phase = "word";
        continue;
      }
      pos++;
      word += at(pos);
      continue;
    }
    word += ch;
  }
  return { rest: "", flags: words };
};

/** BuildKit's `parseWords`: split on unquoted whitespace, keeping quotes and escapes. */
const parseWords = (rest: string, escape: string): string[] => {
  const words: string[] = [];
  let phase: "spaces" | "word" | "quote" = "spaces";
  let quote = "";
  let blankOk = false;
  let word = "";
  const chars = Array.from(rest);
  for (let pos = 0; pos <= chars.length; pos++) {
    let ch = pos < chars.length ? chars[pos]! : "";
    if (phase === "spaces") {
      if (pos === chars.length) break;
      if (isSpace(ch)) continue;
      phase = "word";
    }
    if (pos === chars.length) {
      if (blankOk || word.length > 0) words.push(word);
      break;
    }
    if (phase === "word") {
      if (isSpace(ch)) {
        phase = "spaces";
        if (blankOk || word.length > 0) words.push(word);
        word = "";
        blankOk = false;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        blankOk = true;
        phase = "quote";
      }
      if (ch === escape) {
        if (pos + 1 === chars.length) continue;
        word += ch;
        pos++;
        ch = chars[pos]!;
      }
      word += ch;
      continue;
    }
    if (ch === quote) phase = "word";
    if (ch === escape && quote !== "'") {
      if (pos + 1 === chars.length) {
        phase = "word";
        continue;
      }
      pos++;
      word += ch;
      ch = chars[pos]!;
    }
    word += ch;
  }
  return words;
};

/** A JSON array of strings; `undefined` when the text is not a JSON array. */
const parseJson = Effect.fn(function* (rest: string, line: number) {
  const trimmed = trimLeadingWhitespace(rest);
  const value = trimmed.startsWith("[") ? jsonOf(trimmed) : undefined;
  if (!Array.isArray(value)) return undefined;
  if (!value.every((item): item is string => typeof item === "string")) {
    return yield* fail(
      "when using JSON array syntax, arrays must be comprised of strings only",
      line,
    );
  }
  return value as string[];
});

const commandOf = Effect.fn(function* (rest: string, line: number) {
  const argv = rest === "" ? undefined : yield* parseJson(rest, line);
  return (argv === undefined ? { form: "shell", script: rest } : { form: "exec", argv }) as Command;
});

interface Line {
  readonly start: number;
  readonly end: number;
  /** The logical line: continuations joined, comments dropped. */
  readonly text: string;
  readonly raw: string;
  readonly heredocs: ReadonlyArray<Heredoc>;
}

/** BuildKit's `ParseHeredoc`: `<<NAME`, `<<-NAME`, `3<<"NAME"`; heredocs always lex with `\\`. */
const heredocOf = Effect.fn(function* (word: string, line: number) {
  const match = HEREDOC_WORD.exec(word);
  const rest = match?.[3] ?? "";
  if (match === null || rest.length === 0) return undefined;
  const plain = processWords(rest, { escape: "\\" });
  if (Result.isFailure(plain)) return yield* fail(plain.failure.message, line);
  if (plain.success.length !== 1) return undefined;
  const raw = processWords(rest, { escape: "\\", rawQuotes: true });
  if (Result.isFailure(raw)) return yield* fail(raw.failure.message, line);
  const quotes = (s: string) => (s.match(/['"]/g) ?? []).length;
  const name = plain.success[0]!;
  // A quote anywhere in the delimiter turns expansion off.
  return {
    name,
    stripTabs: match[2] === "-",
    quoted: quotes(name) !== quotes(raw.success[0] ?? ""),
  } satisfies Omit<Heredoc, "content">;
});

const heredocsOf = Effect.fn(function* (text: string, line: number) {
  const words = processWords(text, { escape: "\\", rawQuotes: true, rawEscapes: true });
  const heredocs: Array<Omit<Heredoc, "content">> = [];
  for (const word of Result.isFailure(words) ? [] : words.success) {
    const heredoc = yield* heredocOf(word, line);
    if (heredoc !== undefined) heredocs.push(heredoc);
  }
  return heredocs;
});

/** `RUN`, `COPY` and `ADD` (also as an `ONBUILD` trigger) take heredocs, except in JSON form. */
const canContainHeredoc = (text: string, escape: string) => {
  let [name, rest] = splitInstruction(text);
  if (name.toUpperCase() === "ONBUILD") [name, rest] = splitInstruction(rest);
  if (!HEREDOC_CAPABLE.has(name.toUpperCase())) return false;
  const args = extractFlags(rest, escape).rest.trim();
  return !(args.startsWith("[") && Array.isArray(jsonOf(args)));
};

const readLines = Effect.fn(function* (text: string) {
  // Lines keep their endings: heredoc bodies keep `\r\n`, as BuildKit does.
  const physical = text.split(/(?<=\n)/);
  if (physical.length > 0) physical[0] = physical[0]!.replace(/^\uFEFF/, "");
  // BuildKit reads lines with a 64 KiB scanner: a longer line fails the file.
  const encoder = new TextEncoder();
  const tooLong = physical.findIndex((line) => encoder.encode(trimNewline(line)).length >= 65536);
  if (tooLong !== -1) {
    return yield* fail("dockerfile line greater than max allowed size of 65535", tooLong + 1);
  }
  const directives: Record<string, string> = {};
  let escape = "\\";
  let continued = continuation(escape);
  let directivesDone = false;
  let lineNo = 0;

  // Parser directives: `# key=value` for syntax, escape and check, before
  // any other line. An unknown key, a comment or a blank line ends them.
  const directive = Effect.fn(function* (token: string) {
    if (directivesDone) return;
    const match = token.startsWith("#")
      ? /^([a-zA-Z][a-zA-Z0-9]*)\s*=\s*(.+?)\s*$/.exec(trimLeadingWhitespace(token.slice(1)))
      : null;
    const key = match?.[1]?.toLowerCase();
    if (match === null || key === undefined || !DIRECTIVES.has(key)) {
      directivesDone = true;
      return;
    }
    if (key in directives) {
      return yield* fail(`only one ${key} parser directive can be used`, lineNo + 1);
    }
    const value = match[2]!;
    if (key === "escape") {
      if (value !== "`" && value !== "\\") {
        return yield* fail(`invalid escape token '${value}' does not match \` or \\`, lineNo + 1);
      }
      escape = value;
      continued = continuation(escape);
    }
    directives[key] = value;
  });
  const processLine = Effect.fn(function* (line: string, stripLeft: boolean) {
    let token = trimNewline(line);
    if (stripLeft) token = trimLeadingWhitespace(token);
    yield* directive(token);
    return isComment(token) ? "" : token;
  });
  const trimContinuation = (line: string): [string, boolean] =>
    continued.test(line) ? [line.replace(continued, "$1"), false] : [line, true];

  const lines: Line[] = [];
  let cursor = 0;
  while (cursor < physical.length) {
    const first = physical[cursor++]!;
    const firstToken = yield* processLine(first, true);
    lineNo++;
    const start = lineNo;
    let [joined, ended] = trimContinuation(firstToken);
    if (ended && joined.length === 0) continue;
    const raw = [trimNewline(first)];
    // Comment and blank lines inside a continuation are skipped; a
    // continued line keeps its leading whitespace.
    while (!ended && cursor < physical.length) {
      const next = physical[cursor++]!;
      raw.push(trimNewline(next));
      const token = yield* processLine(next, false);
      lineNo++;
      if (isComment(next) || trimLeadingWhitespace(token).length === 0) continue;
      let part: string;
      [part, ended] = trimContinuation(token);
      joined += part;
    }

    const heredocs: Heredoc[] = [];
    if (joined.includes("<<") && canContainHeredoc(joined, escape)) {
      for (const heredoc of yield* heredocsOf(joined, start)) {
        let content = "";
        let terminated = false;
        while (cursor < physical.length) {
          const body = physical[cursor++]!;
          lineNo++;
          raw.push(trimNewline(body));
          const candidate = trimNewline(body);
          if ((heredoc.stripTabs ? candidate.replace(/^\t+/, "") : candidate) === heredoc.name) {
            terminated = true;
            break;
          }
          content += body;
        }
        if (!terminated) return yield* fail("unterminated heredoc", start);
        heredocs.push({
          ...heredoc,
          content: heredoc.stripTabs ? content.replace(/^\t+/gm, "") : content,
        });
      }
    }
    lines.push({ start, end: lineNo, text: joined, raw: raw.join("\n"), heredocs });
  }
  return { directives, escape, lines };
});

/** BuildKit's word processing, with no variable expanded. */
const wordOf = (word: string, escape: string, line: number) => {
  const result = processWord(word, { escape });
  return Result.isFailure(result)
    ? fail(result.failure.message, line)
    : Effect.succeed(result.success);
};

/** Checks raw `--name[=value]` words against the instruction's declared flags. */
const validateFlags = Effect.fn(function* (
  name: InstructionName,
  raw: ReadonlyArray<string>,
  line: number,
) {
  const declared = FLAGS[name] ?? {};
  const used = new Set<string>();
  const flags: Flag[] = [];
  for (const arg of raw) {
    if (!arg.startsWith("--")) return yield* fail(`arg should start with -- : ${arg}`, line);
    const eq = arg.indexOf("=");
    const flagName = eq === -1 ? arg : arg.slice(0, eq);
    const value = eq === -1 ? undefined : arg.slice(eq + 1);
    const key = flagName.slice(2);
    const type = Object.hasOwn(declared, key) ? declared[key] : undefined;
    if (type === undefined) return yield* fail(`unknown flag: ${flagName}`, line);
    if (used.has(key) && type !== "strings") {
      return yield* fail(`duplicate flag specified: ${flagName}`, line);
    }
    used.add(key);
    if (type === "bool") {
      if (value === "") return yield* fail(`missing a value on flag: ${flagName}`, line);
      if (value !== undefined && !["true", "false"].includes(value.toLowerCase())) {
        return yield* fail(`expecting boolean value for flag ${flagName}, not: ${value}`, line);
      }
    } else if (value === undefined) {
      return yield* fail(`missing a value on flag: ${flagName}`, line);
    }
    flags.push({ name: key, value });
  }
  return flags;
});

/** `ENV`/`LABEL` pairs: `k=v …`, or the legacy `k value with spaces`. */
const nameValues = Effect.fn(function* (rest: string, key: string, escape: string, line: number) {
  const words = parseWords(rest, escape);
  if (words.length === 0) return [];
  if (!words[0]!.includes("=")) {
    const at = rest.search(WHITESPACE);
    if (at === -1) return yield* fail(`${key} must have two arguments`, line);
    return [[rest.slice(0, at), rest.slice(at).replace(WHITESPACE, "")] as const];
  }
  const pairs: Array<readonly [string, string]> = [];
  for (const word of words) {
    const index = word.indexOf("=");
    if (index === -1) {
      return yield* fail(
        `Syntax error - can't find = in "${word}". Must be of the form: name=value`,
        line,
      );
    }
    pairs.push([word.slice(0, index), word.slice(index + 1)]);
  }
  return pairs;
});

const whitespaceList = (rest: string) => (rest === "" ? [] : rest.split(WHITESPACE));

/** Go's `strconv.ParseBool`. */
const goBool = (value: string): boolean | undefined =>
  ["1", "t", "T", "TRUE", "true", "True"].includes(value)
    ? true
    : ["0", "f", "F", "FALSE", "false", "False"].includes(value)
      ? false
      : undefined;

/** Go's `strconv.ParseUint(value, base, 32)`. */
const goUint32 = (value: string, base: 8 | 10) =>
  (base === 8 ? /^[0-7]+$/ : /^[0-9]+$/).test(value) && parseInt(value, base) <= 0xffffffff;

/** Go's `strconv.ParseInt(value, 10, 32)`. */
const goInt32 = (value: string): number | undefined => {
  if (!/^[+-]?[0-9]+$/.test(value)) return undefined;
  const n = Number(value);
  return n >= -0x80000000 && n <= 0x7fffffff ? n : undefined;
};

const DURATION_UNITS: Record<string, number> = {
  ns: 1,
  us: 1e3,
  µs: 1e3,
  μs: 1e3,
  ms: 1e6,
  s: 1e9,
  m: 60e9,
  h: 3600e9,
};

/** Go's `time.ParseDuration`, in nanoseconds. */
const goDuration = (value: string): number | undefined => {
  let rest = value;
  let sign = 1;
  if (rest.startsWith("-") || rest.startsWith("+")) {
    if (rest[0] === "-") sign = -1;
    rest = rest.slice(1);
  }
  if (rest === "0") return 0;
  if (rest === "") return undefined;
  let total = 0;
  while (rest !== "") {
    const match = /^([0-9]*(?:\.[0-9]*)?)([^0-9.]+)/u.exec(rest);
    if (match === null || match[1] === "" || match[1] === ".") return undefined;
    const unit = DURATION_UNITS[match[2]!];
    if (unit === undefined) return undefined;
    total += Number(match[1]) * unit;
    rest = rest.slice(match[0].length);
  }
  return sign * total;
};

/** `go-csvvalue` `Fields`: comma-separated, `"quoted"` with `""` escapes; `undefined` on a bad quote or empty input. */
const csvFields = (input: string): string[] | undefined => {
  let line = input.replace(/\r?\n$/, "");
  if (line === "") return undefined;
  const fields: string[] = [];
  for (;;) {
    if (!line.startsWith('"')) {
      const comma = line.indexOf(",");
      const field = comma === -1 ? line : line.slice(0, comma);
      if (field.includes('"')) return undefined;
      fields.push(field);
      if (comma === -1) return fields;
      line = line.slice(comma + 1);
      continue;
    }
    line = line.slice(1);
    let field = "";
    for (;;) {
      const quote = line.indexOf('"');
      if (quote === -1) return undefined;
      field += line.slice(0, quote);
      line = line.slice(quote + 1);
      if (line.startsWith('"')) {
        field += '"';
        line = line.slice(1);
        continue;
      }
      if (line.startsWith(",")) {
        fields.push(field);
        line = line.slice(1);
        break;
      }
      if (line === "") {
        fields.push(field);
        return fields;
      }
      return undefined;
    }
  }
};

const MOUNT_TYPES = ["bind", "cache", "tmpfs", "secret", "ssh"];
const SHARING_MODES = ["shared", "private", "locked"];

/**
 * `RUN --mount`, checked as BuildKit does: when parsing (only `from` may
 * not use a variable), then when docker build expands it.
 */
const checkMount = Effect.fn(function* (value: string, escape: string, line: number) {
  const fields = csvFields(value);
  if (fields === undefined) return yield* fail("failed to parse csv mounts", line);
  for (const field of fields) {
    const eq = field.indexOf("=");
    if (eq === -1 || field.slice(0, eq).toLowerCase() !== "from") continue;
    const v = field.slice(eq + 1);
    const dollar = v.indexOf("$");
    if (dollar !== -1 && dollar !== v.length - 1) {
      return yield* fail(
        "'from' doesn't support variable expansion, define alias stage instead",
        line,
      );
    }
  }
  let type = "bind";
  let from = "";
  let source = "";
  let target = "";
  let id = "";
  let sharing = "";
  const fileInfoKeys: string[] = [];
  for (const field of fields) {
    const eq = field.indexOf("=");
    const key = (eq === -1 ? field : field.slice(0, eq)).toLowerCase();
    if (eq === -1) {
      if (["readonly", "ro", "readwrite", "rw"].includes(key)) {
        continue;
      }
      if (key === "required") {
        if (type === "secret" || type === "ssh") continue;
        return yield* fail(`unexpected key '${key}' for mount type '${type}'`, line);
      }
      return yield* fail(`invalid field '${field}' must be a key=value pair`, line);
    }
    const v = yield* wordOf(field.slice(eq + 1), escape, line);
    const invalid = () => fail(`invalid value for ${key}: ${v}`, line);
    switch (key) {
      case "type":
        if (!MOUNT_TYPES.includes(v.toLowerCase())) {
          return yield* fail(`unsupported mount type "${v}"`, line);
        }
        type = v.toLowerCase();
        break;
      case "from":
        from = v;
        break;
      case "source":
      case "src":
        source = v;
        break;
      case "target":
      case "dst":
      case "destination":
        target = v;
        break;
      case "readonly":
      case "ro":
      case "readwrite":
      case "rw":
        if (goBool(v) === undefined) return yield* invalid();
        break;
      case "required":
        if (type !== "secret" && type !== "ssh") {
          return yield* fail(`unexpected key '${key}' for mount type '${type}'`, line);
        }
        if (goBool(v) === undefined) return yield* invalid();
        break;
      case "size":
        if (type !== "tmpfs") {
          return yield* fail(`unexpected key '${key}' for mount type '${type}'`, line);
        }
        if (!isDockerByteSize(v)) return yield* invalid();
        break;
      case "id":
        id = v;
        break;
      case "sharing":
        if (!SHARING_MODES.includes(v.toLowerCase())) {
          return yield* fail(`unsupported sharing value "${v}"`, line);
        }
        sharing = v.toLowerCase();
        break;
      case "mode":
        if (!goUint32(v, 8)) return yield* fail(`invalid value ${v} for mode`, line);
        fileInfoKeys.push("mode");
        break;
      case "uid":
      case "gid":
        if (!goUint32(v, 10)) return yield* fail(`invalid value ${v} for ${key}`, line);
        fileInfoKeys.push(key);
        break;
      case "env":
        break;
      default:
        return yield* fail(`unexpected key '${key}' in '${field}'`, line);
    }
  }
  const fileInfo = type === "secret" || type === "ssh" || type === "cache";
  for (const key of ["mode", "uid", "gid"]) {
    if (!fileInfo && fileInfoKeys.includes(key)) {
      return yield* fail(`${key} not allowed for "${type}" type mounts`, line);
    }
  }
  if (type === "secret") {
    if (from !== "") return yield* fail("secret mount should not have a from", line);
    if (sharing !== "") return yield* fail("secret mount should not define sharing", line);
    if (source === "" && target === "" && id === "") {
      return yield* fail("invalid secret mount. one of source, target required", line);
    }
    if (source !== "" && id !== "") return yield* fail("both source and id can't be set", line);
  }
  if (sharing !== "" && type !== "cache") {
    return yield* fail(`invalid cache sharing set for ${type} mount`, line);
  }
});

/** `RUN --device`: `name[,required[=bool]]`. */
const checkDevice = Effect.fn(function* (value: string, line: number) {
  const fields = csvFields(value);
  if (fields === undefined) return yield* fail("failed to parse csv devices", line);
  let name = "";
  for (const field of fields) {
    const eq = field.indexOf("=");
    const key = (eq === -1 ? field : field.slice(0, eq)).toLowerCase();
    if (eq === -1) {
      if (key === "required") continue;
      if (name === "") {
        name = field;
        continue;
      }
      return yield* fail(`invalid field '${field}' must be a key=value pair`, line);
    }
    const v = field.slice(eq + 1);
    if (key === "name") {
      if (name !== "") return yield* fail(`device name already set to ${name}`, line);
      name = v;
    } else if (key === "required") {
      if (goBool(v) === undefined) return yield* fail(`invalid value for ${key}: ${v}`, line);
    } else if (name === "") {
      name = field;
    } else {
      return yield* fail(`unexpected key '${key}' in '${field}'`, line);
    }
  }
});

const checkRunFlags = Effect.fn(function* (
  flags: ReadonlyArray<Flag>,
  escape: string,
  line: number,
) {
  for (const flag of flags) {
    const value = flag.value ?? "";
    if (flag.name === "network" && !["default", "none", "host"].includes(value)) {
      return yield* fail(`invalid network mode "${value}"`, line);
    }
    if (flag.name === "security" && !["insecure", "sandbox"].includes(value)) {
      return yield* fail(`security "${value}" is not valid`, line);
    }
    if (flag.name === "device") yield* checkDevice(value, line);
    if (flag.name === "mount") yield* checkMount(value, escape, line);
  }
});

const checkHealthcheckFlags = Effect.fn(function* (flags: ReadonlyArray<Flag>, line: number) {
  for (const flag of flags) {
    const value = flag.value ?? "";
    if (value === "") continue;
    if (flag.name === "retries") {
      const retries = goInt32(value);
      if (retries === undefined) return yield* fail(`invalid --retries value ${value}`, line);
      if (retries < 0) return yield* fail(`--retries cannot be negative (${retries})`, line);
      continue;
    }
    const duration = goDuration(value);
    if (duration === undefined) return yield* fail(`time: invalid duration "${value}"`, line);
    if (duration !== 0 && duration < 1e6) {
      return yield* fail(`Interval "${flag.name}" cannot be less than 1ms`, line);
    }
  }
});

/**
 * What BuildKit's parser (before the instruction checks) rejects in an
 * instruction: a JSON array of non-strings, and malformed `ENV`/`LABEL`
 * pairs. All an `ONBUILD` trigger is checked for.
 */
const checkSyntax = Effect.fn(function* (text: string, escape: string, line: number) {
  const [word, after] = splitInstruction(text);
  const name = word.toUpperCase();
  const rest = (after === "" ? "" : extractFlags(after, escape).rest).trim();
  if (["RUN", "CMD", "ENTRYPOINT", "SHELL", "COPY", "ADD", "VOLUME"].includes(name)) {
    if (rest !== "") yield* parseJson(rest, line);
  } else if (name === "HEALTHCHECK") {
    const command = splitInstruction(rest)[1];
    if (command !== "") yield* parseJson(command, line);
  } else if (name === "ENV" || name === "LABEL") {
    yield* nameValues(rest, name, escape, line);
  }
});

/** Every word processes; returns them processed. */
const wordsOf = Effect.fn(function* (words: ReadonlyArray<string>, escape: string, line: number) {
  const out: string[] = [];
  for (const word of words) out.push(yield* wordOf(word, escape, line));
  return out;
});

const isEmptyCommand = (command: Command) =>
  command.form === "shell" ? command.script === "" : command.argv.length === 0;

type Parsed =
  | { readonly stage: Omit<Stage, "instructions"> }
  | { readonly instruction: Instruction };

const instructionOf = (
  logical: Line,
  text: string,
  escape: string,
): Effect.Effect<Parsed, DockerfileSyntaxError> =>
  Effect.gen(function* () {
    const line = logical.start;
    const [word, after] = splitInstruction(text);
    const name = word.toUpperCase() as InstructionName;
    if (!KNOWN.has(name)) return yield* fail(`unknown instruction: ${word}`, line);
    const extracted = after === "" ? { rest: "", flags: [] } : extractFlags(after, escape);
    const rest = extracted.rest.trim();
    const raw = logical.raw;
    // HEALTHCHECK NONE declares no flags and never checks them.
    const flags =
      name === "HEALTHCHECK" && /^none(\s|$)/i.test(rest)
        ? extracted.flags.map((raw) => {
            const eq = raw.indexOf("=");
            return eq === -1
              ? { name: raw.slice(2), value: undefined }
              : { name: raw.slice(2, eq), value: raw.slice(eq + 1) };
          })
        : yield* validateFlags(name, extracted.flags, line);
    const base = { line, raw, flags };

    switch (name) {
      case "FROM": {
        const args = whitespaceList(rest);
        let stageName: string | undefined;
        if (args.length === 3 && args[1]!.toLowerCase() === "as") {
          stageName = args[2]!.toLowerCase();
          if (!VALID_STAGE_NAME.test(stageName)) {
            return yield* fail(
              `invalid name for build stage: "${args[2]}", name can't start with a number or contain symbols`,
              line,
            );
          }
        } else if (args.length !== 1) {
          return yield* fail("FROM requires either one or three arguments", line);
        }
        const image = yield* wordOf(args[0]!, escape, line);
        return { stage: { line, raw, image, name: stageName, flags } };
      }
      case "RUN":
        yield* checkRunFlags(flags, escape, line);
        return {
          instruction: {
            ...base,
            _tag: name,
            command: yield* commandOf(rest, line),
            heredocs: logical.heredocs,
          },
        };
      case "CMD":
      case "ENTRYPOINT":
        return { instruction: { ...base, _tag: name, command: yield* commandOf(rest, line) } };
      case "SHELL": {
        const command = yield* commandOf(rest, line);
        if (isEmptyCommand(command))
          return yield* fail("SHELL requires at least one argument", line);
        if (command.form !== "exec") {
          return yield* fail("SHELL requires the arguments to be in JSON form", line);
        }
        return { instruction: { ...base, _tag: name, command } };
      }
      case "COPY":
      case "ADD": {
        const json = yield* parseJson(rest, line);
        const args = json ?? whitespaceList(rest);
        if (args.length < 2) {
          return yield* fail(
            `${name} requires at least two arguments, but only one was provided. Destination could not be determined`,
            line,
          );
        }
        if (json === undefined && (yield* heredocOf(args.at(-1)!, line)) !== undefined) {
          return yield* fail(`${name} cannot accept a heredoc as a destination`, line);
        }
        // docker build expands chown, chmod and checksum, and every source
        // and the destination, the JSON form's included.
        yield* wordsOf(
          flags
            .filter((f) => ["chown", "chmod", "checksum"].includes(f.name))
            .map((f) => f.value ?? ""),
          escape,
          line,
        );
        const words: string[] = [];
        for (const arg of args) {
          words.push(
            json === undefined && arg.startsWith("<<") ? arg : yield* wordOf(arg, escape, line),
          );
        }
        return {
          instruction: {
            ...base,
            _tag: name,
            sources: words.slice(0, -1),
            destination: words.at(-1)!,
            heredocs: logical.heredocs,
          },
        };
      }
      case "ENV": {
        const pairs = yield* nameValues(rest, "ENV", escape, line);
        if (pairs.length === 0) return yield* fail("ENV requires at least one argument", line);
        const vars: Array<readonly [string, string]> = [];
        for (const [key, value] of pairs) {
          if (key.length === 0) return yield* fail("ENV names can not be blank", line);
          vars.push([yield* wordOf(key, escape, line), yield* wordOf(value, escape, line)]);
        }
        return { instruction: { ...base, _tag: name, vars } };
      }
      case "ARG": {
        const words = parseWords(rest, escape);
        if (words.length === 0) return yield* fail("ARG requires at least one argument", line);
        const vars: Array<readonly [string, string | undefined]> = [];
        for (const word of words) {
          const index = word.indexOf("=");
          if (index === 0) return yield* fail("ARG names can not be blank", line);
          vars.push(
            index === -1
              ? [yield* wordOf(word, escape, line), undefined]
              : [
                  yield* wordOf(word.slice(0, index), escape, line),
                  yield* wordOf(word.slice(index + 1), escape, line),
                ],
          );
        }
        return { instruction: { ...base, _tag: name, vars } };
      }
      case "WORKDIR":
      case "USER":
      case "STOPSIGNAL":
        if (rest === "") return yield* fail(`${name} requires exactly one argument`, line);
        return { instruction: { ...base, _tag: name, value: yield* wordOf(rest, escape, line) } };
      case "MAINTAINER":
        if (rest === "") return yield* fail("MAINTAINER requires exactly one argument", line);
        return { instruction: { ...base, _tag: name, args: rest } };
      case "EXPOSE":
      case "VOLUME": {
        const args =
          name === "VOLUME"
            ? ((yield* parseJson(rest, line)) ?? whitespaceList(rest))
            : whitespaceList(rest);
        if (args.length === 0) return yield* fail(`${name} requires at least one argument`, line);
        if (name === "VOLUME") {
          if (args.some((volume) => volume.trim() === "")) {
            return yield* fail("VOLUME specified can not be an empty string", line);
          }
          yield* wordsOf(args, escape, line);
        }
        return { instruction: { ...base, _tag: name, args: rest } };
      }
      case "LABEL": {
        const pairs = yield* nameValues(rest, "LABEL", escape, line);
        if (pairs.length === 0) return yield* fail("LABEL requires at least one argument", line);
        if (pairs.some(([key]) => key.length === 0)) {
          return yield* fail("LABEL names can not be blank", line);
        }
        yield* wordsOf(pairs.flat(), escape, line);
        return { instruction: { ...base, _tag: name, args: rest } };
      }
      case "HEALTHCHECK": {
        if (rest === "") return yield* fail("HEALTHCHECK requires at least one argument", line);
        const [type, command] = splitInstruction(rest);
        if (type.toUpperCase() === "NONE") {
          if (command !== "") return yield* fail("HEALTHCHECK NONE takes no arguments", line);
        } else if (type.toUpperCase() !== "CMD") {
          return yield* fail(`Unknown type "${type.toUpperCase()}" in HEALTHCHECK (try CMD)`, line);
        } else if (isEmptyCommand(yield* commandOf(command, line))) {
          return yield* fail("Missing command after HEALTHCHECK CMD", line);
        } else {
          yield* checkHealthcheckFlags(flags, line);
        }
        return { instruction: { ...base, _tag: name, args: rest } };
      }
      case "ONBUILD": {
        if (rest === "") return yield* fail("ONBUILD requires at least one argument", line);
        const trigger = splitInstruction(rest)[0].toUpperCase();
        if (trigger === "ONBUILD") {
          return yield* fail("Chaining ONBUILD via `ONBUILD ONBUILD` isn't allowed", line);
        }
        if (trigger === "MAINTAINER" || trigger === "FROM") {
          return yield* fail(`${trigger} isn't allowed as an ONBUILD trigger`, line);
        }
        // BuildKit parses the trigger, but checks it only when a child image runs it.
        yield* checkSyntax(rest, escape, line);
        return { instruction: { ...base, _tag: name, args: rest } };
      }
    }
  });

/**
 * Parse Dockerfile text into stages and instructions, as BuildKit reads it:
 * the same directives, continuations, heredocs, word splitting and quoting,
 * and the same files rejected. Values have their quotes and escapes
 * resolved; variables are left as written for the builder to expand.
 */
export const parse = (text: string): Effect.Effect<ParsedDockerfile, DockerfileSyntaxError> =>
  Effect.gen(function* () {
    const { directives, escape, lines } = yield* readLines(text);
    if (lines.length === 0) return yield* fail("file with no instructions", 1);
    const globalArgs: ArgInstruction[] = [];
    const stages: Array<Omit<Stage, "instructions"> & { instructions: Instruction[] }> = [];
    for (const logical of lines) {
      const parsed = yield* instructionOf(logical, logical.text, escape);
      if ("stage" in parsed) {
        stages.push({ ...parsed.stage, instructions: [] });
        continue;
      }
      const stage = stages.at(-1);
      if (stage !== undefined) {
        stage.instructions.push(parsed.instruction);
      } else if (parsed.instruction._tag === "ARG") {
        globalArgs.push(parsed.instruction);
      } else {
        return yield* fail("no build stage in current context", logical.start);
      }
    }
    if (stages.length === 0) return yield* fail("no build stage in current context", 1);
    return { directives, globalArgs, stages } satisfies ParsedDockerfile;
  });

/**
 * Render a parsed Dockerfile back to text, one instruction per entry, each
 * exactly as written (continuations and heredoc bodies included).
 */
export const renderLines = (dockerfile: ParsedDockerfile): string[] => [
  ...Object.entries(dockerfile.directives).map(([key, value]) => `# ${key}=${value}`),
  ...dockerfile.globalArgs.map((arg) => arg.raw),
  ...dockerfile.stages.flatMap((stage) => [stage.raw, ...stage.instructions.map((i) => i.raw)]),
];

/** Render a parsed Dockerfile back to text. */
export const render = (dockerfile: ParsedDockerfile): string =>
  `${renderLines(dockerfile).join("\n")}\n`;
