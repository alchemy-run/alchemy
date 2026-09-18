/**
 * The exposed ingress worker's deploy module: the SAME conformance
 * fetch surface, published through a public ALB with a custom domain on
 * the standing Cloudflare test zone — the DNS records ride the
 * `Cloudflare.CloudflareDns()` layer on the impl's provide chain.
 */
import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { conformanceFetch } from "../../../Cloudflare/Workers/conformance/routes.ts";
import { Counter, CounterLive } from "./counter.ts";
import { INGRESS_DOMAIN, IngressWorker } from "./fleet.ts";

export default IngressWorker.make(
  {
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
