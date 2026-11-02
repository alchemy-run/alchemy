import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/**
 * A Dockerfile parsed into stages and instructions, with the line each one
 * starts on. Builders that are not Docker (E2B, Modal, Daytona) lower this
 * structure into their own build steps instead of running `docker build`.
 *
 * The parser follows the Dockerfile reference: parser directives
 * (`# escape=`), line continuations, comments inside continuations,
 * heredocs (`<<EOF`, `<<-EOF`, quoted delimiters), exec and shell forms,
 * and `--flag[=value]` options. It does not expand variables: lowering
 * decides whether a builder expands them or Alchemy does.
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

const FLAGGED = new Set<InstructionName>(["FROM", "RUN", "COPY", "ADD", "HEALTHCHECK"]);
const HEREDOC_CAPABLE = new Set<InstructionName>(["RUN", "COPY", "ADD"]);

const HEREDOC = /<<(-?)(["']?)([A-Za-z_][A-Za-z0-9_]*)\2/g;

/**
 * Split on unquoted whitespace, honoring single quotes, double quotes, and
 * the escape character, and removing the quotes.
 */
const splitWords = (input: string, escape: string): string[] => {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < input.length; index++) {
    const char = input[index]!;
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else if (char === escape && quote === '"' && index + 1 < input.length) {
        current += input[++index];
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      inWord = true;
    } else if (char === escape && index + 1 < input.length) {
      current += input[++index];
      inWord = true;
    } else if (/\s/.test(char)) {
      if (inWord) {
        words.push(current);
        current = "";
        inWord = false;
      }
    } else {
      current += char;
      inWord = true;
    }
  }
  if (inWord) words.push(current);
  return words;
};

/** Strip leading `--name[=value]` options. */
const takeFlags = (args: string): { flags: Flag[]; rest: string } => {
  const flags: Flag[] = [];
  let rest = args.trimStart();
  for (;;) {
    const match = /^--([A-Za-z][A-Za-z0-9-]*)(?:=((?:"[^"]*"|'[^']*'|\S)*))?(?:\s+|$)/.exec(rest);
    if (match === null) break;
    const raw = match[2];
    const value =
      raw === undefined
        ? undefined
        : (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
          ? raw.slice(1, -1)
          : raw;
    flags.push({ name: match[1]!, value });
    rest = rest.slice(match[0].length);
  }
  return { flags, rest };
};

/** Exec form when the arguments are a JSON array of strings, otherwise shell form. */
const parseCommand = (args: string): Command => {
  const trimmed = args.trim();
  if (trimmed.startsWith("[")) {
    try {
      const value: unknown = JSON.parse(trimmed);
      if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
        return { form: "exec", argv: value };
      }
    } catch {
      // Not JSON: Docker treats it as the shell form.
    }
  }
  return { form: "shell", script: trimmed };
};

/** `KEY=value KEY2="v 2"`, or the legacy `KEY value with spaces`. */
const parseKeyValues = (
  args: string,
  escape: string,
  allowLegacy: boolean,
): Array<readonly [string, string | undefined]> => {
  const trimmed = args.trim();
  const first = /^\S+/.exec(trimmed)?.[0] ?? "";
  if (allowLegacy && !first.includes("=")) {
    const value = trimmed.slice(first.length).trim();
    return [[first, splitWords(value, escape).join(" ")]];
  }
  return splitWords(trimmed, escape).map((word) => {
    const index = word.indexOf("=");
    return index === -1
      ? ([word, undefined] as const)
      : ([word.slice(0, index), word.slice(index + 1)] as const);
  });
};

interface LogicalLine {
  readonly line: number;
  readonly text: string;
  readonly heredocs: ReadonlyArray<Heredoc>;
  readonly raw: string;
}

/**
 * Parse Dockerfile text into stages and instructions.
 */
export const parse = (text: string): Effect.Effect<ParsedDockerfile, DockerfileSyntaxError> =>
  Effect.suspend(() => {
    const physical = text.replace(/^﻿/, "").split(/\r?\n/);
    const directives: Record<string, string> = {};

    // Parser directives: `# key=value` lines at the very top, before any
    // instruction, comment, or blank line.
    let cursor = 0;
    for (; cursor < physical.length; cursor++) {
      const match = /^#\s*([A-Za-z]+)\s*=\s*(.*?)\s*$/.exec(physical[cursor]!);
      if (match === null) break;
      const key = match[1]!.toLowerCase();
      if (key in directives) break;
      directives[key] = match[2]!;
    }
    const escape = directives.escape ?? "\\";
    if (escape !== "\\" && escape !== "`") {
      return Effect.fail(
        new DockerfileSyntaxError({ message: `invalid escape directive: ${escape}`, line: 1 }),
      );
    }

    // Join continuations into logical lines and collect heredoc bodies.
    const lines: LogicalLine[] = [];
    while (cursor < physical.length) {
      const startLine = cursor + 1;
      const first = physical[cursor++]!;
      if (/^\s*(#|$)/.test(first)) continue;

      const rawParts = [first];
      let joined = "";
      let current = first;
      for (;;) {
        const trimmedEnd = current.replace(/\s+$/, "");
        if (trimmedEnd.endsWith(escape) && cursor <= physical.length) {
          joined += trimmedEnd.slice(0, -escape.length);
          // Skip comment and blank lines inside a continuation.
          while (cursor < physical.length && /^\s*(#.*)?$/.test(physical[cursor]!)) {
            rawParts.push(physical[cursor++]!);
          }
          if (cursor >= physical.length) break;
          current = physical[cursor++]!;
          rawParts.push(current);
          continue;
        }
        joined += current;
        break;
      }

      const name = (/^\s*(\S+)/.exec(joined)?.[1] ?? "").toUpperCase() as InstructionName;
      const heredocs: Heredoc[] = [];
      if (HEREDOC_CAPABLE.has(name)) {
        for (const match of joined.matchAll(HEREDOC)) {
          const stripTabs = match[1] === "-";
          const delimiter = match[3]!;
          const body: string[] = [];
          let closed = false;
          while (cursor < physical.length) {
            const bodyLine = physical[cursor++]!;
            rawParts.push(bodyLine);
            const candidate = stripTabs ? bodyLine.replace(/^\t+/, "") : bodyLine;
            if (candidate === delimiter) {
              closed = true;
              break;
            }
            body.push(candidate);
          }
          if (!closed) {
            return Effect.fail(
              new DockerfileSyntaxError({
                message: `unterminated heredoc <<${delimiter}`,
                line: startLine,
              }),
            );
          }
          heredocs.push({
            name: delimiter,
            content: body.length === 0 ? "" : `${body.join("\n")}\n`,
            stripTabs,
            quoted: match[2] !== "",
          });
        }
      }
      lines.push({ line: startLine, text: joined.trim(), heredocs, raw: rawParts.join("\n") });
    }

    const globalArgs: ArgInstruction[] = [];
    const stages: Array<Omit<Stage, "instructions"> & { instructions: Instruction[] }> = [];

    for (const logical of lines) {
      const nameMatch = /^(\S+)\s*([\s\S]*)$/.exec(logical.text)!;
      const name = nameMatch[1]!.toUpperCase() as InstructionName;
      if (!KNOWN.has(name)) {
        return Effect.fail(
          new DockerfileSyntaxError({
            message: `unknown instruction: ${nameMatch[1]}`,
            line: logical.line,
          }),
        );
      }
      const { flags, rest } = FLAGGED.has(name)
        ? takeFlags(nameMatch[2]!)
        : { flags: [] as Flag[], rest: nameMatch[2]! };
      const base = { line: logical.line, raw: logical.raw, flags };

      if (name === "FROM") {
        const words = splitWords(rest, escape);
        if (words.length !== 1 && !(words.length === 3 && words[1]!.toUpperCase() === "AS")) {
          return Effect.fail(
            new DockerfileSyntaxError({
              message: "FROM takes an image and an optional `AS name`",
              line: logical.line,
            }),
          );
        }
        stages.push({
          line: logical.line,
          raw: logical.raw,
          image: words[0]!,
          name: words[2],
          flags,
          instructions: [],
        });
        continue;
      }

      let instruction: Instruction;
      switch (name) {
        case "RUN":
          instruction = {
            ...base,
            _tag: name,
            command: parseCommand(rest),
            heredocs: logical.heredocs,
          };
          break;
        case "COPY":
        case "ADD": {
          const command = parseCommand(rest);
          const words = command.form === "exec" ? [...command.argv] : splitWords(rest, escape);
          if (words.length < 2) {
            return Effect.fail(
              new DockerfileSyntaxError({
                message: `${name} needs at least one source and a destination`,
                line: logical.line,
              }),
            );
          }
          instruction = {
            ...base,
            _tag: name,
            sources: words.slice(0, -1),
            destination: words.at(-1)!,
            heredocs: logical.heredocs,
          };
          break;
        }
        case "ENV":
          instruction = {
            ...base,
            _tag: name,
            vars: parseKeyValues(rest, escape, true).map(
              ([key, value]) => [key, value ?? ""] as const,
            ),
          };
          break;
        case "ARG":
          instruction = { ...base, _tag: name, vars: parseKeyValues(rest, escape, false) };
          break;
        case "WORKDIR":
        case "USER":
        case "STOPSIGNAL":
          instruction = { ...base, _tag: name, value: rest.trim() };
          break;
        case "CMD":
        case "ENTRYPOINT":
        case "SHELL":
          instruction = { ...base, _tag: name, command: parseCommand(rest) };
          break;
        default:
          instruction = { ...base, _tag: name, args: rest.trim() };
      }

      const stage = stages.at(-1);
      if (stage === undefined) {
        if (instruction._tag !== "ARG") {
          return Effect.fail(
            new DockerfileSyntaxError({
              message: `${instruction._tag} before the first FROM`,
              line: logical.line,
            }),
          );
        }
        globalArgs.push(instruction);
      } else {
        stage.instructions.push(instruction);
      }
    }

    if (stages.length === 0) {
      return Effect.fail(new DockerfileSyntaxError({ message: "no FROM instruction", line: 1 }));
    }
    return Effect.succeed({ directives, globalArgs, stages });
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
