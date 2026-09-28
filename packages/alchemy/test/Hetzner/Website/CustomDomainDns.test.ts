/**
 * `domain.dns` on Hetzner website composites. Compiles real compositions
 * (registration only — no plan, no apply, no cloud calls) and asserts on
 * the resources the engine collects.
 */
import * as Cloudflare from "@/Cloudflare";
import * as Hetzner from "@/Hetzner";
import * as Output from "@/Output";
import * as Stack from "@/Stack";
import { Stage } from "@/Stage";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const providers = Layer.mergeAll(Hetzner.providers(), Cloudflare.providers());

const { test } = Test.make({ providers });

const ZONE = "alchemy-test-2.us";
const HOSTNAME = `hetzner-site.${ZONE}`;

interface CompiledResource {
  Type: string;
  Props: any;
}

const compile = (build: Effect.Effect<any, any, any>) =>
  Effect.scoped(
    (build as Effect.Effect<any, any, never>).pipe(
      Stack.make({
        name: "hetzner-website-dns",
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

const recordTypes = (resources: Record<string, CompiledResource>) =>
  Object.values(typesOf(resources)).filter(
    (type) => type.includes("DNS") || type === "Hetzner.RecordSet",
  );

describe(
  "Hetzner.Website domain.dns (composition)",
  {
    tags: [
      "unit",
      "provider:hetzner",
      "provider:hetzner:website",
      "provider:cloudflare",
      "provider:cloudflare:dns",
      "local",
    ],
  },
  () => {
    test(
      "Cloudflare DNS publishes an A record at the Server without a zone",
      Effect.gen(function* () {
        const resources = yield* compile(
          Hetzner.Website.Vite("Web", {
            domain: {
              name: HOSTNAME,
              dns: Cloudflare.DNS.Adapter({ zone: ZONE }),
            },
          }),
        );
        const addresses = resources["Web/Domain-Addresses"];
        expect(addresses?.Type).toBe("Cloudflare.DNS.RecordList");
        expect(addresses?.Props.zone).toBe(ZONE);
        expect(recordTypes(resources)).toEqual(["Cloudflare.DNS.RecordList"]);
        expect(
          yield* evaluate(addresses?.Props.records, {
            "Web/Server": { ipv4: "203.0.113.10" },
          }),
        ).toEqual([{ name: HOSTNAME, type: "A", value: "203.0.113.10" }]);
      }),
    );

    test(
      "Hetzner DNS adapter publishes a Hetzner record list",
      Effect.gen(function* () {
        const resources = yield* compile(
          Hetzner.Website.Vite("Web", {
            domain: {
              name: HOSTNAME,
              dns: Hetzner.DNS.Adapter({ zone: ZONE }),
            },
          }),
        );
        expect(resources["Web/Domain-Addresses"]?.Type).toBe(
          "Hetzner.DNS.RecordList",
        );
        expect(recordTypes(resources)).toEqual(["Hetzner.DNS.RecordList"]);
      }),
    );

    test(
      "a plain hostname keeps the A RecordSet in `zone`",
      Effect.gen(function* () {
        const plain = yield* compile(
          Effect.gen(function* () {
            const zone = yield* Hetzner.Zone("Zone", { name: ZONE });
            return yield* Hetzner.Website.Vite("Web", {
              domain: HOSTNAME,
              zone,
            });
          }),
        );
        const record = plain["Web/Domain"];
        expect(record?.Type).toBe("Hetzner.RecordSet");
        expect(record?.Props.type).toBe("A");
        expect(recordTypes(plain)).toEqual(["Hetzner.RecordSet"]);

        // `{ name }` without `dns` is the same composition as the string.
        const named = yield* compile(
          Effect.gen(function* () {
            const zone = yield* Hetzner.Zone("Zone", { name: ZONE });
            return yield* Hetzner.Website.Vite("Web", {
              domain: { name: HOSTNAME },
              zone,
            });
          }),
        );
        expect(typesOf(named)).toEqual(typesOf(plain));
        expect(named["Web/Domain"]?.Props.type).toBe("A");
      }),
    );
  },
);
