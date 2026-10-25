import { getProperty, walk } from "../ast.ts";
import { domainFile } from "../file.ts";
import type { Node, Rule } from "../types.ts";

type Range = readonly [number, number];

const within = (node: Node, ranges: ReadonlyArray<Range>): boolean =>
  ranges.some(([start, end]) => node.start >= start && node.end <= end);

/** An identifier that refers to a binding (not a declaration, a key or a member name). */
const isReference = (node: Node): boolean => {
  const parent = node.parent;
  if (parent === undefined) return true;
  if (
    (parent.type === "VariableDeclarator" || parent.type === "FunctionDeclaration") &&
    parent.id === node
  ) {
    return false;
  }
  if (parent.type === "MemberExpression" && parent.property === node && !parent.computed)
    return false;
  if (parent.type === "Property" && parent.key === node && !parent.computed && !parent.shorthand) {
    return false;
  }
  return true;
};

/**
 * SKILL.md: "Never `throw` for an outcome a caller handles. Fail with tagged
 * errors (`Domain.Rejection`, `Schema.TaggedError`). The one exception is an
 * `evolve` guard: an event that cannot apply to the current state is a bug in
 * `decide`, so `evolve` throws, the command dies, and nothing commits."
 *
 * A `throw` is reported everywhere except in an aggregate's `evolve`, and in a
 * local helper that only `evolve` calls (`mustBeOpen(s)`). Such a guard helper
 * may also be called from the aggregate's `reply`, which reads the same next
 * state before anything is stored. A `throw` written in `reply`, `decide`, a
 * view, a policy, a projection or a saga is reported.
 */
export const noThrow: Rule = {
  meta: {
    type: "problem",
    docs: {
      description: "No `throw` in the domain, except a guard in an aggregate's `evolve`.",
    },
    messages: {
      throw:
        "Don't `throw` in the domain. Return or `yield*` a `Domain.Rejection` or a `Schema.TaggedError`, so the failure is typed. Only an aggregate's `evolve` may throw, to guard against an event that cannot apply.",
    },
  },
  create(context) {
    let evolve: Array<Range> = [];
    let guards: Array<Range> = [];
    return {
      Program(program) {
        evolve = [];
        guards = [];
        if (!context.sourceCode.text.includes("throw")) return;
        const file = domainFile(context, program);
        const reply: Array<Range> = [];
        for (const block of file.blocks) {
          if (block.kind !== "Aggregate") continue;
          const evolveValue = getProperty(block.definition, "evolve")?.value;
          if (evolveValue) evolve.push([evolveValue.start, evolveValue.end]);
          const replyValue = getProperty(block.definition, "reply")?.value;
          if (replyValue) reply.push([replyValue.start, replyValue.end]);
        }
        if (evolve.length === 0 || file.helpers.size === 0) return;

        // Where each local helper is referenced.
        const references = new Map<string, Array<Node>>();
        walk(program, (node) => {
          if (node.type !== "Identifier" || !file.helpers.has(node.name) || !isReference(node)) {
            return;
          }
          const list = references.get(node.name) ?? [];
          list.push(node);
          references.set(node.name, list);
        });

        // A guard helper: referenced from `evolve` (or another guard), and otherwise only from
        // `evolve`, `reply` or another guard.
        const allowed = new Set<string>();
        for (let changed = true; changed;) {
          changed = false;
          const guardRanges = [...allowed].map((name) => {
            const fn = file.helpers.get(name)!;
            return [fn.start, fn.end] as const;
          });
          for (const [name, refs] of references) {
            if (allowed.has(name)) continue;
            const fn = file.helpers.get(name)!;
            const outside = refs.filter((ref) => !(ref.start >= fn.start && ref.end <= fn.end));
            const fromEvolve = outside.some(
              (ref) => within(ref, evolve) || within(ref, guardRanges),
            );
            const onlyFolds = outside.every(
              (ref) => within(ref, evolve) || within(ref, reply) || within(ref, guardRanges),
            );
            if (fromEvolve && onlyFolds) {
              allowed.add(name);
              changed = true;
            }
          }
        }
        guards = [...allowed].map((name) => {
          const fn = file.helpers.get(name)!;
          return [fn.start, fn.end] as const;
        });
      },
      ThrowStatement(node) {
        if (within(node, evolve) || within(node, guards)) return;
        context.report({ node, messageId: "throw" });
      },
    };
  },
};
