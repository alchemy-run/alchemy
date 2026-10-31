/**
 * The conformance counter on the AWS pool, declared apart from its
 * implementation so callers bundle only the declaration.
 */
import * as Rivet from "@alchemy.run/rivet";
import type { CounterShape } from "../../Cloudflare/Workers/conformance/counter-shape.ts";

export class Counter extends Rivet.DurableObject<Counter, CounterShape>()("Counter") {}
