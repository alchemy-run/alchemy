/** A small TypeScript / YAML highlighter in VS Code's Dark+ colours: enough for slides. */
export interface Token {
  text: string;
  color: string;
}

const KEYWORD = new Set([
  "import",
  "export",
  "default",
  "return",
  "async",
  "await",
  "yield",
  "new",
  "class",
  "extends",
  "type",
  "from",
  "as",
  "typeof",
  "if",
  "else",
]);
const STORAGE = new Set([
  "const",
  "let",
  "function",
  "true",
  "false",
  "null",
  "undefined",
  "never",
  "void",
  "string",
]);
const C = {
  keyword: "#c586c0",
  storage: "#569cd6",
  string: "#ce9178",
  number: "#b5cea8",
  comment: "#6a9955",
  type: "#4ec9b0",
  call: "#dcdcaa",
  ident: "#9cdcfe",
  punct: "#d4d4d4",
};

const TS =
  /(\/\/.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+\b)|([A-Za-z_$][\w$]*)|(\s+)|(.)/g;

export const highlightTs = (line: string): Token[] => {
  const out: Token[] = [];
  for (const m of line.matchAll(TS)) {
    const [text, comment, string, number, ident, space] = m;
    const next = line.slice(m.index! + text.length);
    const c = comment
      ? C.comment
      : string
        ? C.string
        : number
          ? C.number
          : ident
            ? KEYWORD.has(ident)
              ? C.keyword
              : STORAGE.has(ident)
                ? C.storage
                : /^\s*\(/.test(next) || (/^\s*</.test(next) && /^[a-z]/.test(ident))
                  ? C.call
                  : /^[A-Z]/.test(ident)
                    ? C.type
                    : C.ident
            : space
              ? C.punct
              : C.punct;
    out.push({ text, color: c });
  }
  return out;
};

export const highlightYaml = (line: string): Token[] => {
  if (/^\s*#/.test(line)) return [{ text: line, color: C.comment }];
  const m = line.match(/^(\s*-?\s*)([\w.]+)(:)(.*)$/);
  if (!m) return [{ text: line, color: C.string }];
  return [
    { text: m[1]!, color: C.punct },
    { text: m[2]!, color: C.ident },
    { text: m[3]!, color: C.punct },
    { text: m[4]!, color: C.string },
  ];
};
