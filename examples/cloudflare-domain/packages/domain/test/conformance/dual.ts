import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { parse, surface } from "@alchemy.run/domain/Prove/Surface";
import type { Group } from "./cases.ts";

// A function of Effect is written both ways: `f(self, x)`, and `f(x)` to be
// given `self` by `pipe`. Effect declares each such function with its
// signatures in a block (`export const map: { ... } = `), so the list of them
// is read from its source. For every one the prover has a model for, the
// tables have to call it both ways: where none calls it piped, the piped
// call is written here from a call with `self` first, and where none calls
// it with `self` first, that call is written from a piped one. Each is
// compared with the real code.

const source = path.join(
  path.dirname(createRequire(import.meta.url).resolve("effect/package.json")),
  "src",
);

/** Declared with a block of signatures, and not written both ways. */
const ONE_WAY: ReadonlySet<string> = new Set([
  ...["effect/Array:copy", "effect/Array:isArray", "effect/Effect:annotateCurrentSpan"],
  ...["effect/Effect:gen", "effect/Filter:fromPredicate", "effect/Function:dual"],
  ...["effect/HashMap:isHashMap", "effect/HashSet:isHashSet", "effect/Match:typeTags"],
  ...["effect/Sink:find", "effect/Filter:tagged"],
  // Each is written as an overloaded function and has one way to be called.
  ...["effect/Sink:takeWhile", "effect/Sink:takeWhileEffect", "effect/Schedule:cron"],
  // Each of these takes the latch or the semaphore first either way, and then the effect.
  ...["effect/Latch:whenOpen", "effect/Semaphore:withPermit", "effect/Semaphore:withPermits"],
  "effect/Semaphore:withPermitsIfAvailable",
  // An effect and a function of how it ended: the effect comes first either way.
  ...["effect/Effect:forkChild", "effect/Effect:forkDetach"],
  // The set or the handle comes first either way, and then the effect.
  ...["effect/FiberSet:run", "effect/FiberHandle:run", "effect/FiberMap:run"],
  ...["effect/TxSemaphore:withPermit", "effect/TxSemaphore:withPermits"],
  "effect/PartitionedSemaphore:withPermitsIfAvailable",
  // Written with the channel or the stream first, and no other way.
  ...["effect/Channel:transformPull", "effect/Stream:transformPull"],
  "effect/Stream:transformPullBracket",
  ...["effect/PartitionedSemaphore:withPermit", "effect/PartitionedSemaphore:withPermits"],
  // Two ways to write its options, with a capacity and without: neither takes a value from `pipe`.
  "effect/RcMap:make",
  // A function of the language, which is never given a value by `pipe`.
  "Array:isArray",
  // A metric of numbers and one of bigints: two ways to write its options, neither given by `pipe`.
  ...["effect/Metric:counter", "effect/Metric:gauge"],
  // The service comes first either way: `Layer.succeed(Rate)(value)`.
  ...["effect/Layer:succeed", "effect/Layer:sync", "effect/Layer:effect", "effect/Layer:mock"],
  // A key and a value, or a record of them: neither is given by `pipe`.
  "effect/Effect:annotateLogsScoped",
  // Reported both ways, and never run: the `unread` lines of a table call it each way.
  "effect/RequestResolver:persisted",
]);

const declared = new Map<string, ReadonlySet<string>>();
const blocksOf = (module: string): ReadonlySet<string> => {
  const known = declared.get(module);
  if (known) return known;
  const file = path.join(source, `${module.replace(/^effect\//, "")}.ts`);
  const text = fs.existsSync(file)
    ? fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "")
    : "";
  const names = new Set(
    [...text.matchAll(/^export const (\w+): \{\n[\s\S]*?\n\} = /gm)].map((match) => match[1]!),
  );
  declared.set(module, names);
  return names;
};

/** Every function the prover has a model for that Effect writes both ways. */
export const duals = (): ReadonlyArray<string> =>
  surface().library.filter((key) => {
    const [module = "", name = ""] = key.split(":");
    return !ONE_WAY.has(key) && blocksOf(module).has(name);
  });

interface Node {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [field: string]: unknown;
}

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && "type" in value;

const OPEN = "(async function* () { (";
const CLOSE = "\n); });";

export interface Piped {
  /** The functions no table calls either way: there is no call to write the other from. */
  readonly missing: ReadonlyArray<string>;
  /** A table for each one that had calls to write from: the way no table wrote, for each function. */
  readonly groups: ReadonlyArray<Group>;
  /** How many functions the tables already call both ways. */
  readonly tabled: number;
}

export const piped = async (groups: ReadonlyArray<Group>): Promise<Piped> => {
  const keys = new Set(duals());
  // How a table writes a module: its import name.
  const modules = new Map(
    [...keys].map((key) => {
      const module = key.split(":")[0]!;
      return [module === "effect/BigInt" ? "BigInts" : module.replace(/^effect\//, ""), module];
    }),
  );
  interface Written {
    readonly group: Group;
    readonly known: boolean;
    readonly expression: string;
  }
  // Each function's first call of each way, as the call of the other way.
  const first = new Map<string, Written>();
  const last = new Map<string, Written>();
  for (const group of groups)
    for (const [expression, known] of [
      ...group.both.map((each) => [each, false] as const),
      ...(group.known ?? []).map((each) => [each, true] as const),
    ]) {
      const text = `${OPEN}${expression}${CLOSE}`;
      const walk = (node: Node, parent: Node | undefined, index: number): void => {
        const callee = node.type === "CallExpression" ? (node.callee as Node) : undefined;
        const object = callee?.type === "MemberExpression" ? (callee.object as Node) : undefined;
        const module =
          object?.type === "Identifier" ? modules.get(object.name as string) : undefined;
        // A function of `effect/Function` is imported bare.
        const key =
          callee?.type === "Identifier"
            ? `effect/Function:${callee.name as string}`
            : module && `${module}:${(callee!.property as Node).name as string}`;
        if (key && keys.has(key)) {
          const over = parent?.type === "CallExpression" ? (parent.callee as Node) : undefined;
          const step =
            over !== undefined &&
            over !== node &&
            ((over.type === "Identifier" && over.name === "flow") ||
              (over.type === "Identifier" && over.name === "pipe" && index >= 1) ||
              (over.type === "MemberExpression" && (over.property as Node).name === "pipe"));
          const args = node.arguments as ReadonlyArray<Node>;
          const cut = (each: Node) => text.slice(each.start, each.end);
          const rewritten = (call: string): Written => ({
            group,
            known,
            expression: `${text.slice(0, node.start)}${call}${text.slice(node.end)}`.slice(
              OPEN.length,
              -CLOSE.length,
            ),
          });
          if (step) {
            // `f(x)` as a step is `(self) => f(self, x)`.
            if (!last.has(key))
              last.set(
                key,
                rewritten(
                  `((self_) => ${cut(callee!)}(${["self_", ...args.map(cut)].join(", ")}))`,
                ),
              );
          }
          // Called at once, `f(x)(self)`, it is neither: what it was given is not known to be `self`.
          else if (over !== node && args.length >= 1 && !first.has(key)) {
            const [self, ...rest] = args;
            first.set(
              key,
              rewritten(`pipe(${cut(self!)}, ${cut(callee!)}(${rest.map(cut).join(", ")}))`),
            );
          }
        }
        for (const [field, child] of Object.entries(node))
          if (Array.isArray(child))
            child.forEach((each, at) => isNode(each) && walk(each, node, at));
          else if (isNode(child)) walk(child, node, field === "callee" ? -1 : 0);
      };
      walk((await parse(text)) as Node, undefined, -1);
    }
  // The way a table did not write, from the way one did.
  const derived = [...keys].flatMap((key) => {
    const piped = first.get(key);
    const direct = last.get(key);
    return piped && direct ? [] : piped ? [piped] : direct ? [direct] : [];
  });
  const both = [...keys].filter((key) => first.has(key) && last.has(key));
  return {
    tabled: both.length,
    missing: [...keys].filter((key) => !first.has(key) && !last.has(key)),
    groups: groups.flatMap((group) => {
      const mine = derived.filter((each) => each.group === group);
      return mine.length === 0
        ? []
        : [
            {
              ...group,
              name: `${group.name}Piped`,
              chunk: 1,
              both: mine.filter((each) => !each.known).map((each) => each.expression),
              known: mine.filter((each) => each.known).map((each) => each.expression),
              unread: [],
            },
          ];
    }),
  };
};
