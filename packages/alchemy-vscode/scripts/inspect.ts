/**
 * Tokenize a file with the real VS Code grammars plus this extension's
 * injection, so the highlighting can be checked without launching an editor.
 *
 *   bun run --filter alchemy-vscode inspect            # tokens for the fixture
 *   bun run --filter alchemy-vscode inspect --check    # assert the key scopes
 *   bun scripts/inspect.ts ../../services/alchemy-org/src/Coding.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as oniguruma from "vscode-oniguruma";
import * as vsctm from "vscode-textmate";

const root = path.resolve(import.meta.dirname, "..");

/** Where an installed editor keeps its bundled grammars. */
const EDITOR_EXTENSION_DIRS = [
  "/Applications/Cursor.app/Contents/Resources/app/extensions",
  "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions",
  "/usr/share/cursor/resources/app/extensions",
  "/usr/share/code/resources/app/extensions",
];

const BUNDLED_GRAMMARS: Record<string, string> = {
  "source.ts": "typescript-basics/syntaxes/TypeScript.tmLanguage.json",
  "source.tsx": "typescript-basics/syntaxes/TypeScriptReact.tmLanguage.json",
  "source.js": "javascript/syntaxes/JavaScript.tmLanguage.json",
  "source.json": "json/syntaxes/JSON.tmLanguage.json",
  "source.shell": "shellscript/syntaxes/shell-unix-bash.tmLanguage.json",
  "text.html.markdown": "markdown-basics/syntaxes/markdown.tmLanguage.json",
  "text.html.basic": "html/syntaxes/html.tmLanguage.json",
};

const extensionsDir = EDITOR_EXTENSION_DIRS.find((dir) => fs.existsSync(dir));
if (extensionsDir === undefined) {
  console.error(
    "no editor installation found — looked in:\n  " +
      EDITOR_EXTENSION_DIRS.join("\n  "),
  );
  process.exit(1);
}

const wasm = fs.readFileSync(
  fileURLToPath(import.meta.resolve("vscode-oniguruma/release/onig.wasm")),
);

const onigLib = oniguruma.loadWASM(wasm.buffer as ArrayBuffer).then(() => ({
  createOnigScanner: (sources: string[]) => new oniguruma.OnigScanner(sources),
  createOnigString: (str: string) => new oniguruma.OnigString(str),
}));

const readGrammar = (file: string): vsctm.IRawGrammar =>
  vsctm.parseRawGrammar(fs.readFileSync(file, "utf8"), file);

const registry = new vsctm.Registry({
  onigLib,
  loadGrammar: async (scopeName) => {
    if (scopeName === "inline.alchemy-prose") {
      return readGrammar(
        path.join(root, "syntaxes/alchemy-prose.injection.json"),
      );
    }
    const bundled = BUNDLED_GRAMMARS[scopeName];
    if (bundled === undefined) return null;
    const file = path.join(extensionsDir, bundled);
    return fs.existsSync(file) ? readGrammar(file) : null;
  },
  getInjections: (scopeName) =>
    scopeName.startsWith("source.ts") || scopeName.startsWith("source.js")
      ? ["inline.alchemy-prose"]
      : undefined,
});

interface Token {
  readonly line: number;
  readonly text: string;
  readonly scopes: readonly string[];
}

const tokenize = async (file: string): Promise<Token[]> => {
  const grammar = await registry.loadGrammar(
    file.endsWith("x") ? "source.tsx" : "source.ts",
  );
  if (grammar === null)
    throw new Error("failed to load the TypeScript grammar");

  const tokens: Token[] = [];
  let state = vsctm.INITIAL;
  const lines = fs.readFileSync(file, "utf8").split("\n");
  for (const [index, line] of lines.entries()) {
    const result = grammar.tokenizeLine(line, state);
    for (const token of result.tokens) {
      tokens.push({
        line: index + 1,
        text: line.slice(token.startIndex, token.endIndex),
        scopes: token.scopes,
      });
    }
    state = result.ruleStack;
  }
  return tokens;
};

const target = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const file = path.resolve(root, target ?? "fixtures/sample.ts");
const tokens = await tokenize(file);

if (!process.argv.includes("--check")) {
  for (const token of tokens) {
    if (token.text.trim() === "") continue;
    console.log(
      `${String(token.line).padStart(4)}  ${JSON.stringify(token.text).padEnd(34)}  ${token.scopes.join(" ")}`,
    );
  }
  process.exit(0);
}

const has = (token: Token, scope: string): boolean =>
  token.scopes.some((s) => s === scope || s.startsWith(`${scope}.`));

/** Some token reading exactly `text` must carry `scope`. */
const expect = (text: string, scope: string): boolean => {
  const matches = tokens.filter((token) => token.text === text);
  if (matches.length === 0) {
    console.error(`FAIL  no token reading ${JSON.stringify(text)}`);
    return false;
  }
  if (!matches.some((token) => has(token, scope))) {
    console.error(
      `FAIL  ${JSON.stringify(text)} is not ${scope}: ${matches[0]!.scopes.join(" ")}`,
    );
    return false;
  }
  console.log(`ok    ${JSON.stringify(text)} is ${scope}`);
  return true;
};

/** No token reading exactly `text` may carry `scope`. */
const refute = (text: string, scope: string): boolean => {
  const bad = tokens.filter(
    (token) => token.text === text && has(token, scope),
  );
  if (bad.length > 0) {
    console.error(`FAIL  ${JSON.stringify(text)} leaked into ${scope}`);
    return false;
  }
  console.log(`ok    ${JSON.stringify(text)} is not ${scope}`);
  return true;
};

const results = [
  // the prose body reads as markdown, not as one string
  expect("Writing code in the repository checkout", "markup.heading"),
  expect("Read before you edit", "markup.bold"),
  expect(
    "Verify with the test suite; the suite is the oracle of done-ness.",
    "markup.list",
  ),
  expect(
    "A reconcile is ONE flow: observe, ensure, sync, return.",
    "markup.quote",
  ),
  expect("AWS/S3/Bucket.ts", "markup.inline.raw"),
  // …at any indentation: nested prose is past markdown's three-space limit
  expect("Deeply indented", "markup.heading"),
  expect("The margin belongs to the code, not to the document.", "markup.list"),
  refute("Blocks still read as ", "markup.raw.block"),
  // fenced code is the fence's language, and the fence closes
  expect("reconcile", "meta.embedded.block.typescript"),
  expect("function", "storage.type.function"),
  expect(" one flow, three starting points", "comment.line"),
  expect("typescript", "fenced_code.block.language.markdown"),
  expect("bun", "meta.embedded.block.shellscript"),
  refute(
    "A tilde fence needs no escaping, and reads the same to the model:",
    "markup.fenced_code",
  ),
  // tables: every pipe is punctuation, not cell text
  expect("|", "punctuation.definition.table.markdown"),
  expect("---", "punctuation.separator.table.markdown"),
  // splices stay TypeScript
  expect("Grep", "meta.embedded.line.alchemy-splice"),
  // a call is a tag too, and its arguments keep their own colors
  expect("pull request", "markup.bold"),
  expect("task", "meta.embedded.line.alchemy-splice"),
  expect(
    "  The work itself, standing alone — the issue reference and the",
    "meta.embedded.block.alchemy-prose",
  ),
  expect("hand_to_engineer", "string.quoted"),
  expect("Dispatch", "entity.name.function"),
  // a body ending in a parenthesis closes there — the `not-prose` checks
  // below are what prove the rest of the file survived it
  expect("Increment the counter (once)", "meta.embedded.block.alchemy-prose"),
  expect("run(now)", "meta.embedded.block.alchemy-prose"),
  // …but a call split over lines is left alone, deliberately
  expect("  Prose the grammar declines to claim.", "string.template"),
  refute(
    "  Prose the grammar declines to claim.",
    "meta.embedded.block.alchemy-prose",
  ),
  // the template terminates: code after it is code again, and a plain call is
  // never mistaken for prose
  expect("make", "entity.name.function.tagged-template.alchemy"),
  expect("not-prose", "string.quoted"),
  refute("not-prose", "meta.embedded.block.alchemy-prose"),
];

process.exit(results.every(Boolean) ? 0 : 1);
