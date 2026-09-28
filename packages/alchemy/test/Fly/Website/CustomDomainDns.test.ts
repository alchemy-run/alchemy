/**
 * `domain.dns` on Fly website composites. Compiles real compositions
 * (registration only — no plan, no apply, no cloud calls) and asserts on
 * the resources the engine collects.
 */
import * as Cloudflare from "@/Cloudflare";
import * as Fly from "@/Fly";
import * as Output from "@/Output";
import * as Stack from "@/Stack";
import { Stage } from "@/Stage";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const providers = Layer.mergeAll(Fly.providers(), Cloudflare.providers());

const { test } = Test.make({ providers });

const ZONE = "alchemy-test-2.us";
const HOSTNAME = `fly-site.${ZONE}`;

interface CompiledResource {
  Type: string;
  Props: any;
}

const compile = (build: Effect.Effect<any, any, any>) =>
  Effect.scoped(
    (build as Effect.Effect<any, any, never>).pipe(
      Stack.make({
        name: "fly-website-dns",
        providers,
        state: inMemoryState(),
      } as any),
      Effect.map(
        (compiled: any) =>
          compiled.resources as Record<string, CompiledResource>,
      ),
    ),
  ).pipe(Effect.provideService(Stage, "test")) as Effect.Effect<
    Record<string, CompiledResource>
  >;

/** Evaluate a compiled prop against fake upstream attributes. */
const evaluate = (value: unknown, upstream: Record<string, unknown>) =>
  Output.evaluate(value, upstream).pipe(
    Effect.provide(inMemoryState()),
    Effect.orDie,
  );

const typesOf = (resources: Record<string, CompiledResource>) =>
  Object.fromEntries(
    Object.entries(resources).map(([fqn, resource]) => [fqn, resource.Type]),
  );

const dnsTypes = (resources: Record<string, CompiledResource>) =>
  Object.values(typesOf(resources)).filter((type) => type.includes("DNS"));

describe(
  "Fly.Website domain.dns (composition)",
  {
    tags: [
      "unit",
      "provider:fly",
      "provider:fly:website",
      "provider:cloudflare",
      "provider:cloudflare:dns",
      "local",
    ],
  },
  () => {
    test(
      "Cloudflare DNS publishes the ACME challenge and address records",
      Effect.gen(function* () {
        const resources = yield* compile(
          Fly.Website.Vite("Web", {
            domain: {
              name: HOSTNAME,
              dns: Cloudflare.DNS.Adapter({ zone: ZONE }),
            },
          }),
        );
        expect(resources["Web/Certificate"]?.Type).toBe("Fly.Certificate");
        expect(resources["Web/Certificate"]?.Props.hostname).toBe(HOSTNAME);

        const validation = resources["Web/CertificateValidation"];
        expect(validation?.Type).toBe("Cloudflare.DNS.RecordList");
        expect(validation?.Props.zone).toBe(ZONE);

        const addresses = resources["Web/Domain-Addresses"];
        expect(addresses?.Type).toBe("Cloudflare.DNS.RecordList");
        expect(addresses?.Props.zone).toBe(ZONE);
        expect(dnsTypes(resources)).toHaveLength(2);

        const upstream = {
          "Web/Certificate": {
            hostname: HOSTNAME,
            dnsRequirements: {
              a: ["66.241.124.1"],
              aaaa: ["2a09:8280:1::1"],
              acmeChallenge: {
                name: `_acme-challenge.${HOSTNAME}`,
                target: `${HOSTNAME}.x1y2.flydns.net`,
              },
            },
          },
          "Web/Shared": { ip: "66.241.124.1" },
        };
        expect(yield* evaluate(validation?.Props.records, upstream)).toEqual([
          {
            name: `_acme-challenge.${HOSTNAME}`,
            type: "CNAME",
            value: `${HOSTNAME}.x1y2.flydns.net`,
          },
        ]);
        expect(yield* evaluate(addresses?.Props.records, upstream)).toEqual([
          { name: HOSTNAME, type: "A", value: "66.241.124.1" },
          { name: HOSTNAME, type: "AAAA", value: "2a09:8280:1::1" },
        ]);
        // No ACME challenge listed yet: nothing to publish.
        expect(
          yield* evaluate(validation?.Props.records, {
            ...upstream,
            "Web/Certificate": { hostname: HOSTNAME },
          }),
        ).toEqual([]);
      }),
    );

    test(
      "a plain hostname declares no DNS resources",
      Effect.gen(function* () {
        const plain = yield* compile(
          Fly.Website.Vite("Web", { domain: HOSTNAME }),
        );
        expect(plain["Web/Certificate"]?.Props.hostname).toBe(HOSTNAME);
        expect(dnsTypes(plain)).toEqual([]);

        // `{ name }` without `dns` is the same composition as the string.
        const named = yield* compile(
          Fly.Website.Vite("Web", { domain: { name: HOSTNAME } }),
        );
        expect(typesOf(named)).toEqual(typesOf(plain));
        expect(named["Web/Certificate"]?.Props.hostname).toBe(HOSTNAME);
        expect(named["Web/Certificate"]?.Props.kind).toBe(
          plain["Web/Certificate"]?.Props.kind,
        );
      }),
    );
  },
);
