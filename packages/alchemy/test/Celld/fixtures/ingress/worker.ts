/**
 * The exposed ingress worker's deploy module: the SAME conformance
 * fetch surface, published through a public ALB with a custom domain on
 * the standing Cloudflare test zone — the DNS records ride the
 * `Cloudflare.CloudflareDns()` layer on the impl's provide chain.
 */
import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  Counter,
  CounterLive,
} from "../../../Cloudflare/Workers/conformance/counter.ts";
import { conformanceFetch } from "../../../Cloudflare/Workers/conformance/routes.ts";
import { INGRESS_DOMAIN, IngressCells, IngressWorker } from "./fleet.ts";

export default IngressWorker.make(
  {
    fleet: IngressCells,
    main: import.meta.url,
    expose: "public",
    domain: INGRESS_DOMAIN,
  },
  Effect.gen(function* () {
    const counters = yield* Counter;
    return { fetch: conformanceFetch(counters) };
  }).pipe(
    Effect.provide(Layer.mergeAll(CounterLive, Cloudflare.CloudflareDns())),
  ),
);
