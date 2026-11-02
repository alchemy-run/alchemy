// @ts-expect-error resolved by the runners' bundler plugin
import entities from "virtual:cluster-entities";
import { runExternal } from "./Bootstrap.ts";

await runExternal(entities as ReadonlyArray<{ readonly name: string; readonly value: unknown }>);
