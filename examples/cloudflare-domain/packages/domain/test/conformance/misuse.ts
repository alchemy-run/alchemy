// Every function the prover has a model for, called in ways a handler should
// not call it: with nothing, with too little, with the wrong kinds of values.
// Each call is reported, or read as the real code runs it.

import { surface } from "@alchemy.run/domain/Prove/Surface";
import type { Group } from "./cases.ts";

/** The arguments each function is called with, written in the inputs `a` and `b`. */
const SHAPES: ReadonlyArray<string> = [``, `a`, `"x", a`, `a, b, a`, `{}, a`, `[a], () => b`];

const numbers = {
  input: `a: Small, b: Small`,
  pins: `[{ a: 1, b: 2 }]`,
  differs: `command.a !== pin.a || command.b !== pin.b`,
  bind: (known: boolean) =>
    known ? `const a = pin.a; const b = pin.b;` : `const a = command.a; const b = command.b;`,
};

/** One table for each module the prover has models of, named after it. */
export const misuseGroups = (only?: ReadonlyArray<string>): ReadonlyArray<Group> => {
  const byModule = new Map<string, Array<string>>();
  for (const key of surface().library) {
    const at = key.lastIndexOf(":");
    const module = key.slice(0, at);
    const path = key.slice(at + 1);
    if (!module.startsWith("effect/") || path === "" || /[^\w.$]/.test(path)) continue;
    byModule.set(module, [...(byModule.get(module) ?? []), path]);
  }
  return [...byModule]
    .filter(([module]) => !only || only.includes(module))
    .map(([module, paths]): Group => {
      const name = module.slice("effect/".length).replace(/\W/g, "");
      return {
        name: `Misuse${name}`,
        ...numbers,
        prelude: [`import * as Under from "${module}";`],
        both: [],
        misuse: paths
          .filter(
            (path) =>
              !process.env.MISUSE_PATHS || process.env.MISUSE_PATHS.split(",").includes(path),
          )
          .flatMap((path) => SHAPES.map((shape) => `Under.${path}(${shape})`)),
      };
    });
};
