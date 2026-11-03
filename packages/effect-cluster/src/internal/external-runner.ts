// @ts-expect-error resolved by the pool's bundler plugin
import entities from "virtual:cluster-entities";
// @ts-expect-error resolved by the pool's bundler plugin
import program from "virtual:cluster-program";
import { runExternal } from "./Bootstrap.ts";

await runExternal(
  entities as ReadonlyArray<{ readonly name: string; readonly value: unknown }>,
  program as string,
);
