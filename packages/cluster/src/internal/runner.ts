// @ts-expect-error resolved by the runners' bundler plugin
import entities from "virtual:cluster-entities";
import { bootstrap } from "./Bootstrap.ts";

await bootstrap(entities as ReadonlyArray<unknown>);
