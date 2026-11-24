import * as fs from "node:fs";
import * as path from "node:path";
import { expect, it } from "@effect/vitest";

// The docs page and the skill quote what a report says, so that a reader can
// tell what to change. Each quoted line has to be one the prover can still
// say: its words are looked for in the text of the prover's own messages.

const root = path.resolve(import.meta.dirname, "../../../../..");
const page = fs.readFileSync(
  path.join(root, "website/src/content/docs/domain/verifiable-code.mdx"),
  "utf8",
);
const skill = fs.readFileSync(
  path.join(root, "packages/domain/skills/alchemy-domain/references/testing.md"),
  "utf8",
);

const sources = (dir: string): ReadonlyArray<string> =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory()
      ? sources(file)
      : entry.name.endsWith(".ts")
        ? [fs.readFileSync(file, "utf8")]
        : [];
  });

/** Every message the prover's source writes, as the text between what it fills in. */
const messages: ReadonlyArray<ReadonlyArray<string>> = [
  ...sources(path.join(root, "packages/domain/src/Prove")),
  fs.readFileSync(path.join(root, "packages/domain/src/Prove.ts"), "utf8"),
]
  .flatMap((source) => [
    ...[...source.matchAll(/`((?:[^`\\]|\\.)*)`/g)].map((match) => match[1]!),
    ...[...source.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)].map((match) => match[1]!),
  ])
  .filter((text) => text.includes(" "))
  .map((text) => text.split(/\$\{(?:[^{}]|\{[^{}]*\})*\}/));

/**
 * Whether a quoted line is how a message begins. What the message fills in
 * may be anything, but a line cannot end in it with more than one word: it
 * would then be a line of the page's own.
 */
const begins = (quoted: string, parts: ReadonlyArray<string>): boolean => {
  const [first = "", ...rest] = parts;
  if (first.startsWith(quoted)) return quoted.length > 0;
  if (!quoted.startsWith(first)) return false;
  const left = quoted.slice(first.length);
  if (rest.length === 0) return left === "";
  if (!/\s/.test(left)) return left.length > 0;
  for (let at = 1; at < left.length; at++) if (begins(left.slice(at), rest)) return true;
  return false;
};

const said = (quoted: string): boolean => {
  const [first = "", ...more] = quoted.split(": ");
  return (
    messages.some((parts) => parts[0] !== "" && begins(first, parts)) &&
    // What follows a colon is how some message goes on.
    more.every((part) => messages.some((parts) => parts.some((text) => text.includes(part))))
  );
};

it("a line the prover does not say is found", () => {
  expect(said("loops more than 64 times, a number of times that depends on an input")).toBe(true);
  expect(said("loops more than 64 times, a number of times that depends on the weather")).toBe(
    false,
  );
  expect(said("calls Math.sqrt, which the prover has no model for")).toBe(true);
  expect(said("calls Math.sqrt, which the prover has never heard of")).toBe(false);
});

it("every line of a report the page quotes is one the prover says", () => {
  const start = page.indexOf('```typescript title="What the report says, and what to write"');
  const block = page.slice(start, page.indexOf("\n```\n", start));
  // A message is a comment that starts its line; advice under one is indented.
  const quoted = [...block.matchAll(/^\/\/ (\S.*)$/gm)].map((match) => match[1]!);
  expect(quoted.length).toBeGreaterThan(10);
  expect(quoted.filter((line) => !said(line))).toEqual([]);
});

it("every line of a report the skill quotes is one the prover says", () => {
  const start = skill.indexOf("### Reading a report that fails");
  const section = skill.slice(start, skill.indexOf("\nMore:", start));
  const quoted = section
    .split("\n")
    .filter((line) => line.startsWith("- `"))
    // The messages come before the colon that starts the advice.
    .flatMap((line) =>
      [...line.slice(0, line.indexOf("`: ") + 1).matchAll(/`([^`]+)`/g)].map((match) => match[1]!),
    )
    .filter((text) => text.includes(" "));
  expect(quoted.length).toBeGreaterThan(10);
  expect(quoted.filter((line) => !said(line))).toEqual([]);
});
