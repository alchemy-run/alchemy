/**
 * `domain.dns` on Railway website composites. Compiles real compositions
 * (registration only — no plan, no apply, no cloud calls) and asserts on
 * the resources the engine collects.
 */
import * as Cloudflare from "@/Cloudflare";
import * as Output from "@/Output";
import * as Railway from "@/Railway";
import * as Stack from "@/Stack";
import { Stage } from "@/Stage";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const providers = Layer.mergeAll(Railway.providers(), Cloudflare.providers());

const { test } = Test.make({ providers });

const ZONE = "alchemy-test-2.us";
const HOSTNAME = `railway-site.${ZONE}`;

interface CompiledResource {
  Type: string;
  Props: any;
}

const compile = (build: Effect.Effect<any, any, any>) =>
  Effect.scoped(
    (build as Effect.Effect<any, any, never>).pipe(
      Stack.make({
        name: "railway-website-dns",
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
  "Railway.Website domain.dns (composition)",
  {
    tags: [
      "unit",
      "provider:railway",
      "provider:railway:website",
      "provider:cloudflare",
      "provider:cloudflare:dns",
      "local",
    ],
  },
  () => {
    test(
      "Cloudflare DNS publishes the records Railway requires",
      Effect.gen(function* () {
        const resources = yield* compile(
          Railway.Website.Vite("Web", {
            domain: {
              name: HOSTNAME,
              dns: Cloudflare.DNS.Adapter({ zone: ZONE }),
            },
          }),
        );
        expect(resources["Web/Domain"]?.Type).toBe("Railway.CustomDomain");
        expect(resources["Web/Domain"]?.Props.domain).toBe(HOSTNAME);

        const records = resources["Web/DomainRecords"];
        expect(records?.Type).toBe("Cloudflare.DNS.RecordList");
        expect(records?.Props.zone).toBe(ZONE);
        expect(dnsTypes(resources)).toHaveLength(1);

        const dnsRecords = [
          { name: HOSTNAME, type: "CNAME", value: "abc123.up.railway.app" },
          {
            name: `_railway-verify.${HOSTNAME}`,
            type: "TXT",
            value: "railway-verify=0123456789",
          },
        ];
        expect(
          yield* evaluate(records?.Props.records, {
            "Web/Domain": { domain: HOSTNAME, dnsRecords },
          }),
        ).toEqual(dnsRecords);
      }),
    );

    test(
      "a plain hostname declares no DNS resources",
      Effect.gen(function* () {
        const plain = yield* compile(
          Railway.Website.Vite("Web", { domain: HOSTNAME }),
        );
        expect(plain["Web/Domain"]?.Props.domain).toBe(HOSTNAME);
        expect(dnsTypes(plain)).toEqual([]);

        // `{ name }` without `dns` is the same composition as the string.
        const named = yield* compile(
          Railway.Website.Vite("Web", { domain: { name: HOSTNAME } }),
        );
        expect(typesOf(named)).toEqual(typesOf(plain));
        expect(named["Web/Domain"]?.Props.domain).toBe(HOSTNAME);
        expect(named["Web/Domain"]?.Props.targetPort).toBe(
          plain["Web/Domain"]?.Props.targetPort,
        );
      }),
    );
  },
);
