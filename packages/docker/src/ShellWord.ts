/**
 * Docker's word processing (BuildKit `frontend/dockerfile/shell/lex.go`),
 * without an environment: quotes and escapes are resolved and every variable
 * reference is kept as written (`$NAME`, `${NAME:-default}`), as BuildKit
 * does with `SkipUnsetEnv`. Expanding variables is left to the builder.
 */

import * as Data from "effect/Data";
import * as Result from "effect/Result";

/** A word Docker cannot process: an unterminated quote or a bad `${…}`. */
export class ShellWordError extends Data.TaggedError("ShellWordError")<{
  readonly message: string;
}> {}

export interface ShellWordOptions {
  readonly escape: string;
  /** Keep quote characters in the result. */
  readonly rawQuotes?: boolean;
  /** Keep escape characters in the result. */
  readonly rawEscapes?: boolean;
}

const EOF = undefined;
const isSpace = (ch: string) => /\s/u.test(ch);
const isLetter = (ch: string) => /\p{L}/u.test(ch);
const isDigit = (ch: string) => /\p{Nd}/u.test(ch);
const isSpecialParam = (ch: string) => "@*#?-$!0".includes(ch);
const isWhitespace = (ch: string | undefined) => ch === "\t" || ch === "\r" || ch === " ";

/**
 * The word being built. BuildKit's lexer has one per lexer, and every
 * `processStopOn` resets it, including the nested ones inside `${…}`: so
 * `he${X:-y}z` splits to `${X:-y}z`. Docker splits words this way, so we do.
 */
interface WordBuffer {
  value: string;
}

class Words {
  private inWord = false;
  constructor(private readonly shared: WordBuffer) {}
  private get buf() {
    return this.shared.value;
  }
  private set buf(value: string) {
    this.shared.value = value;
  }
  readonly words: string[] = [];
  addChar(ch: string) {
    if (isSpace(ch) && this.inWord) {
      if (this.buf.length !== 0) {
        this.words.push(this.buf);
        this.buf = "";
        this.inWord = false;
      }
    } else if (!isSpace(ch)) {
      this.addRawChar(ch);
    }
  }
  addRawChar(ch: string) {
    this.buf += ch;
    this.inWord = true;
  }
  addString(str: string) {
    for (const ch of str) this.addChar(ch);
  }
  addRawString(str: string) {
    this.buf += str;
    this.inWord = true;
  }
  get(): string[] {
    if (this.buf.length > 0) {
      this.words.push(this.buf);
      this.buf = "";
      this.inWord = false;
    }
    return this.words;
  }
}

class Lexer {
  private readonly chars: string[];
  private pos = 0;
  private rawEscapes: boolean;
  private readonly wordBuffer: WordBuffer = { value: "" };
  /** The first error. Failing also ends the input, so every loop stops. */
  error: ShellWordError | undefined;

  constructor(
    input: string,
    private readonly options: ShellWordOptions,
  ) {
    this.chars = Array.from(input);
    this.rawEscapes = options.rawEscapes ?? false;
  }

  private peek(): string | undefined {
    return this.chars[this.pos];
  }
  private next(): string | undefined {
    return this.chars[this.pos++];
  }
  private fail(message: string): string {
    this.error ??= new ShellWordError({ message });
    this.pos = this.chars.length;
    return "";
  }

  process(): { result: string; words: string[] } {
    return this.processStopOn(EOF, this.rawEscapes, false);
  }

  private processStopOn(
    stop: string | undefined,
    rawEscapes: boolean,
    preservePatternEscapes: boolean,
  ): { result: string; words: string[] } {
    let result = "";
    this.wordBuffer.value = "";
    const words = new Words(this.wordBuffer);
    const saved = this.rawEscapes;
    this.rawEscapes = rawEscapes;
    while (this.peek() !== EOF) {
      const ch = this.peek()!;
      if (stop !== EOF && ch === stop) {
        this.next();
        this.rawEscapes = saved;
        return { result, words: words.get() };
      }
      if (ch === "$") {
        const tmp = this.processDollar();
        result += tmp;
        words.addString(tmp);
      } else if (ch === "<") {
        const tmp = this.processPossibleHeredoc();
        result += tmp;
        words.addRawString(tmp);
      } else if (ch === "'") {
        const tmp = this.processSingleQuote(preservePatternEscapes);
        result += tmp;
        words.addRawString(tmp);
      } else if (ch === '"') {
        const tmp = this.processDoubleQuote(preservePatternEscapes);
        result += tmp;
        words.addRawString(tmp);
      } else {
        let c = this.next()!;
        if (c === this.options.escape) {
          if (this.rawEscapes) {
            words.addRawChar(c);
            result += c;
          }
          const escaped = this.next();
          if (escaped === EOF) break;
          c = escaped;
          words.addRawChar(c);
        } else {
          words.addChar(c);
        }
        result += c;
      }
    }
    this.rawEscapes = saved;
    if (stop !== EOF) {
      this.fail(`unexpected end of statement while looking for matching ${stop}`);
    }
    return { result, words: words.get() };
  }

  private processSingleQuote(preservePatternEscapes: boolean): string {
    let result = "";
    const open = this.next()!;
    if (this.options.rawQuotes) result += open;
    for (;;) {
      const ch = this.next();
      if (ch === EOF) {
        return this.fail("unexpected end of statement while looking for matching single-quote");
      }
      if (ch === "'") {
        if (this.options.rawQuotes) result += ch;
        return result;
      }
      if (preservePatternEscapes && ch === this.options.escape) result += ch;
      result += ch;
    }
  }

  private processDoubleQuote(preservePatternEscapes: boolean): string {
    let result = "";
    const open = this.next()!;
    if (this.options.rawQuotes) result += open;
    for (;;) {
      const peeked = this.peek();
      if (peeked === EOF) {
        return this.fail("unexpected end of statement while looking for matching double-quote");
      }
      if (peeked === '"') {
        const close = this.next()!;
        if (this.options.rawQuotes) result += close;
        return result;
      }
      if (peeked === "$") {
        result += this.processDollar();
        continue;
      }
      let ch = this.next()!;
      if (ch === this.options.escape) {
        const after = this.peek();
        if (after === EOF) continue;
        if (after === '"' || after === "$" || after === this.options.escape) {
          if (this.rawEscapes) result += ch;
          ch = this.next()!;
        } else if (this.rawEscapes && (!this.options.rawQuotes || preservePatternEscapes)) {
          result += ch;
        }
      }
      result += ch;
    }
  }

  private processDollar(): string {
    this.next();
    if (this.peek() !== "{") {
      const name = this.processName();
      return name === "" ? "$" : `$${name}`;
    }
    this.next();
    const first = this.peek();
    if (first === EOF) return this.fail("syntax error: missing '}'");
    if (first === "{" || first === "}" || first === ":") {
      return this.fail("syntax error: bad substitution");
    }
    const name = this.processName();
    let ch = this.next();
    let chs = ch ?? "\uFFFD";
    let nullIsUnset = false;
    switch (ch) {
      case "}":
        return `\${${name}}`;
      case ":":
      case "+":
      case "-":
      case "?":
      case "#":
      case "%": {
        if (ch === ":") {
          nullIsUnset = true;
          ch = this.next();
          chs += ch ?? "\uFFFD";
        }
        const raw = ch === "#" || ch === "%";
        if (nullIsUnset && raw) {
          return this.fail(`unsupported modifier (${chs}) in substitution`);
        }
        const word = this.substitutionPart("}", raw, raw, "syntax error: missing '}'");
        return `\${${name}${chs}${word}}`;
      }
      case "/": {
        if (this.peek() === "/") this.next();
        const pattern = this.substitutionPart("/", true, true, "syntax error: missing '/' in ${}");
        const replacement = this.substitutionPart("}", true, false, "syntax error: missing '}'");
        return `\${${name}/${pattern}/${replacement}}`;
      }
      default:
        return this.fail(`unsupported modifier (${chs}) in substitution`);
    }
  }

  private substitutionPart(
    stop: string,
    rawEscapes: boolean,
    preservePatternEscapes: boolean,
    missing: string,
  ): string {
    const before = this.error;
    const part = this.processStopOn(stop, rawEscapes, preservePatternEscapes).result;
    // An unterminated part reports the missing closer, as BuildKit does.
    if (before === undefined && this.error?.message.startsWith("unexpected end")) {
      this.error = new ShellWordError({ message: missing });
    }
    return part;
  }

  private processName(): string {
    let name = "";
    while (this.peek() !== EOF) {
      const ch = this.peek()!;
      if (name.length === 0 && isDigit(ch)) {
        while (this.peek() !== EOF && isDigit(this.peek()!)) name += this.next();
        return name;
      }
      if (name.length === 0 && isSpecialParam(ch)) return this.next()!;
      if (!isLetter(ch) && !isDigit(ch) && ch !== "_") break;
      name += this.next();
    }
    return name;
  }

  private processPossibleHeredoc(): string {
    this.next();
    if (this.peek() !== "<") return "<";
    this.next();
    let space = "";
    while (isWhitespace(this.peek())) space += this.next();
    return `<<${space}`;
  }
}

const run = <A>(
  input: string,
  options: ShellWordOptions,
  pick: (out: { result: string; words: string[] }) => A,
): Result.Result<A, ShellWordError> => {
  const lexer = new Lexer(input, options);
  const out = lexer.process();
  return lexer.error === undefined ? Result.succeed(pick(out)) : Result.fail(lexer.error);
};

/** The word with quotes and escapes resolved. */
export const processWord = (word: string, options: ShellWordOptions) =>
  run(word, options, (out) => out.result);

/** The input split into words, as a shell would. */
export const processWords = (input: string, options: ShellWordOptions) =>
  run(input, options, (out) => out.words);
