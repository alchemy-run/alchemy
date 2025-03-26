/// <reference types="bun" />

import { it } from "bun:test";
import { alchemy } from "../alchemy";
import { destroy } from "../destroy";
import type { Scope } from "../scope";

declare module "../alchemy" {
  interface Alchemy {
    test: typeof test;
  }
}

alchemy.test = test;

export function test(name: string, fn: (scope: Scope) => Promise<void>) {
  return it(name, async () => {
    await alchemy.run(async (scope) => {
      await fn(scope);

      // TODO: auto-destroy resources
      await destroy(scope);
    });
  });
}
