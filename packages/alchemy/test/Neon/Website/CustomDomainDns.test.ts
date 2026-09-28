/**
 * `domain.dns` on Neon website composites. Compiles real compositions
 * (registration only — no plan, no apply, no cloud calls) and asserts on
 * the resources the engine collects.
 */
import * as Cloudflare from "@/Cloudflare";
import * as Neon from "@/Neon";
import * as Output from "@/Output";
import * as Stack from "@/Stack";
import { Stage } from "@/Stage";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const providers = Layer.mergeAll(Neon.providers(), Cloudflare.providers());

const { test } = Test.make({ providers });

const ZONE = "alchemy-test-2.us";
const HOSTNAME = `neon-site.${ZONE}`;

interface CompiledResource {
  Type: string;
  Props: any;
}

const compile = (build: Effect.Effect<any, any, any>) =>
  Effect.scoped(
    (build as Effect.Effect<any, any, never>).pipe(
      Stack.make({
        name: "neon-website-dns",
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
  "Neon.Website domain.dns (composition)",
  {
    tags: [
      "unit",
      "provider:neon",
      "provider:neon:website",
      "provider:cloudflare",
      "provider:cloudflare:dns",
      "local",
    ],
  },
  () => {
    test(
      "Cloudflare DNS publishes a DNS-only CNAME to the Neon target",
      Effect.gen(function* () {
        const resources = yield* compile(
          Neon.Website.Vite("Web", {
            domain: {
              name: HOSTNAME,
              dns: Cloudflare.DNS.Adapter({ zone: ZONE }),
            },
          }),
        );
        expect(resources["Web/Domain"]?.Type).toBe("Neon.CustomDomain");
        expect(resources["Web/Domain"]?.Props.hostname).toBe(HOSTNAME);

        const cname = resources["Web/DomainAlias-CNAME"];
        expect(cname?.Type).toBe("Cloudflare.DNS.Records");
        expect(cname?.Props.zone).toBe(ZONE);
        expect(cname?.Props.type).toBe("CNAME");
        expect(cname?.Props.names).toEqual([HOSTNAME]);
        expect(cname?.Props.proxied).toBeUndefined();
        expect(dnsTypes(resources)).toHaveLength(1);
        expect(
          yield* evaluate(cname?.Props.content, {
            "Web/Domain": { cnameTarget: "fn-abc.functions.neon.tech" },
          }),
        ).toBe("fn-abc.functions.neon.tech");
      }),
    );

    test(
      "a plain hostname declares no DNS resources",
      Effect.gen(function* () {
        const plain = yield* compile(
          Neon.Website.Vite("Web", { domain: HOSTNAME }),
        );
        expect(plain["Web/Domain"]?.Props.hostname).toBe(HOSTNAME);
        expect(dnsTypes(plain)).toEqual([]);

        // `{ name }` without `dns` is the same composition as the string.
        const named = yield* compile(
          Neon.Website.Vite("Web", { domain: { name: HOSTNAME } }),
        );
        expect(typesOf(named)).toEqual(typesOf(plain));
        expect(named["Web/Domain"]?.Props.hostname).toBe(HOSTNAME);
      }),
    );
  },
);
