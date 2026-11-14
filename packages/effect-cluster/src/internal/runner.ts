// @ts-expect-error resolved by the pool's bundler plugin
import entities from "virtual:cluster-entities";
import { bootstrap } from "./Bootstrap.ts";

await bootstrap(entities as ReadonlyArray<{ readonly name: string; readonly value: unknown }>);
