/**
 * The entry of a pool's node image. The pool's bundler resolves
 * `virtual:rivet-durable-objects` to the Durable Object classes the pool
 * hosts.
 *
 * @internal
 */
// @ts-expect-error resolved by the pool's bundler plugin
import durableObjects from "virtual:rivet-durable-objects";
import { bootstrap } from "./Bootstrap.ts";

await bootstrap(durableObjects as ReadonlyArray<unknown>);
