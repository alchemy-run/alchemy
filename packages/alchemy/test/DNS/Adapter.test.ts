/**
 * The DNS adapter contract (`alchemy/DNS`) and its three built-in hosts.
 *
 * Plan-level only: each case compiles a stack program (resource
 * registration — no plan, no apply, no cloud calls) and asserts what an
 * adapter method DECLARES: resource types, logical ids, and props (Output
 * references are resolved against `<fqn.attr>` placeholders).
 */
import * as AWS from "@/AWS";
import * as Cloudflare from "@/Cloudflare";
import * as DNS from "@/DNS";
import * as Hetzner from "@/Hetzner";
import * as Output from "@/Output";
import type { ResourceLike } from "@/Resource";
import * as Stack from "@/Stack";
import { Stage } from "@/Stage";
import { inMemoryState, InMemoryService, State } from "@/State";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

const adapters = Layer.mergeAll(
  Cloudflare.DNS.AdapterLive,
  AWS.Route53.AdapterLive,
  Hetzner.DNS.AdapterLive,
);

const { test } = Test.make({ providers: adapters });

interface Compiled {
  resources: Record<string, ResourceLike>;
}

/**
 * Compile a stack program with `providers` (default: every built-in DNS
 * adapter) and return the resources it declared, keyed by FQN.
 */
const compile = (
  build: Effect.Effect<unknown, any, any>,
  providers: Layer.Layer<any, never, any> = adapters,
): Effect.Effect<Compiled> =>
  Effect.scoped(
    (build as Effect.Effect<unknown>).pipe(
      Stack.make({
        name: "dns-adapter",
        providers,
        state: inMemoryState(),
      } as any) as any,
      Effect.map((compiled: any) => ({
        resources: compiled.resources as Record<string, ResourceLike>,
      })),
    ),
  ).pipe(Effect.provideService(Stage, "test")) as Effect.Effect<Compiled>;

/**
 * Resolve Output references in `value`: every declared resource's
 * attributes read as `<fqn.attr>` unless overridden in `upstream`.
 */
const resolve = (
  compiled: Compiled,
  value: unknown,
  upstream: Record<string, unknown> = {},
) =>
  Output.evaluate(value, {
    ...Object.fromEntries(
      Object.keys(compiled.resources).map((fqn) => [
        fqn,
        new Proxy(
          {},
          {
            get: (_, attr) =>
              typeof attr === "string" ? `<${fqn}.${attr}>` : undefined,
          },
        ),
      ]),
    ),
    ...upstream,
  }).pipe(
    Effect.provideService(State, InMemoryService()),
  ) as Effect.Effect<any>;

/** `fqn → type` of every declared resource. */
const typesOf = (compiled: Compiled) =>
  Object.fromEntries(
    Object.entries(compiled.resources).map(([fqn, r]) => [fqn, r.Type]),
  );

/** Resolved props of one declared resource. */
const propsOf = (compiled: Compiled, fqn: string) => {
  const resource = compiled.resources[fqn];
  expect(resource).toBeDefined();
  return resolve(compiled, resource!.Props);
};

/** The defect (or error) an effect exits with. */
const failureOf = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.exit(effect).pipe(
    Effect.map((exit) =>
      Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined,
    ),
  );

/** An upstream resource whose attributes the adapters point records at. */
const target = AWS.S3.Bucket("Target", {});

/** The attributes of {@link target} the adapters point records at. */
type TargetAttrs = { bucketName: any; bucketArn: any };

const hostnameTarget = (bucket: TargetAttrs) => ({
  hostname: bucket.bucketName,
});
const route53AliasTarget = (bucket: TargetAttrs) => ({
  hostname: bucket.bucketName,
  route53Alias: { hostedZoneId: bucket.bucketArn },
});

const tags = ["unit", "provider:dns", "local"];

describe("DNS.resolve", { tags }, () => {
  test(
    "dies with DnsAdapterNotRegistered for an unregistered type",
    Effect.gen(function* () {
      const failure = yield* failureOf(DNS.resolve({ type: "Nope.DNS" }));
      expect(failure).toBeInstanceOf(DNS.DnsAdapterNotRegistered);
      expect((failure as DNS.DnsAdapterNotRegistered).type).toBe("Nope.DNS");
      expect((failure as DNS.DnsAdapterNotRegistered).message).toContain(
        "Nope.providers()",
      );
    }),
  );

  test(
    "dies when the DNS host's providers() layer is missing from the stack",
    Effect.gen(function* () {
      const failure = yield* failureOf(
        compile(DNS.resolve(Cloudflare.DNS.Adapter()), AWS.Route53.AdapterLive),
      );
      expect(failure).toBeInstanceOf(DNS.DnsAdapterNotRegistered);
      expect((failure as DNS.DnsAdapterNotRegistered).type).toBe(
        "Cloudflare.DNS",
      );
    }),
  );

  test(
    "resolves each built-in adapter by type",
    Effect.gen(function* () {
      const resolved = yield* Effect.all([
        DNS.resolve(Cloudflare.DNS.Adapter()),
        DNS.resolve(AWS.Route53.Adapter()),
        DNS.resolve(Hetzner.DNS.Adapter()),
      ]).pipe(Effect.provide(adapters));
      expect(resolved).toHaveLength(3);
      for (const adapter of resolved) {
        expect(typeof adapter.alias).toBe("function");
        expect(typeof adapter.aliasSet).toBe("function");
        expect(typeof adapter.records).toBe("function");
      }
    }),
  );
});

describe("DNS config constructors", { tags }, () => {
  test(
    "are plain data",
    Effect.sync(() => {
      expect(Cloudflare.DNS.Adapter()).toEqual({ type: "Cloudflare.DNS" });
      expect(
        Cloudflare.DNS.Adapter({ zone: "example.com", proxied: true }),
      ).toEqual({
        type: "Cloudflare.DNS",
        zone: "example.com",
        options: { proxied: true },
      });
      expect(Cloudflare.DNS.Adapter({ zone: { zoneId: "abc123" } })).toEqual({
        type: "Cloudflare.DNS",
        zone: "abc123",
      });
      expect(AWS.Route53.Adapter()).toEqual({ type: "AWS.Route53" });
      expect(AWS.Route53.Adapter({ hostedZoneId: "Z1" })).toEqual({
        type: "AWS.Route53",
        zone: "Z1",
      });
      expect(Hetzner.DNS.Adapter()).toEqual({ type: "Hetzner.DNS" });
      expect(Hetzner.DNS.Adapter({ zone: "example.com" })).toEqual({
        type: "Hetzner.DNS",
        zone: "example.com",
      });
      // Round-trips through JSON (state, the dev sidecar).
      const config = Cloudflare.DNS.Adapter({ zone: "example.com" });
      expect(JSON.parse(JSON.stringify(config))).toEqual(config);
    }),
  );

  test(
    "a Hetzner.Zone reference becomes its zone id",
    Effect.gen(function* () {
      const compiled = yield* compile(
        Effect.gen(function* () {
          const zone = yield* Hetzner.Zone("Zone", { name: "example.com" });
          const dns = yield* DNS.resolve(Hetzner.DNS.Adapter({ zone }));
          yield* dns.records("Records", {
            records: [{ name: "a.example.com", type: "TXT", value: "v" }],
          });
        }),
      );
      const props = yield* resolve(
        compiled,
        compiled.resources["Records"]!.Props,
        { Zone: { zoneId: 42 } },
      );
      expect(props.zone).toBe("42");
    }),
  );
});

describe("Cloudflare.DNS adapter", { tags }, () => {
  test(
    "alias to a hostname declares a Cloudflare.DNS.Records CNAME `{id}-CNAME`",
    Effect.gen(function* () {
      const compiled = yield* compile(
        Effect.gen(function* () {
          const bucket = yield* target;
          const dns = yield* DNS.resolve(
            Cloudflare.DNS.Adapter({ zone: "example.com", proxied: true }),
          );
          // `route53Alias` and `ipv6` are Route 53 concerns: still one CNAME.
          yield* dns.alias("Alias", {
            name: "www.example.com",
            ipv6: true,
            target: route53AliasTarget(bucket),
          });
          yield* DNS.resolve(Cloudflare.DNS.Adapter()).pipe(
            Effect.flatMap((plain) =>
              plain.alias("Plain", {
                name: "app.example.com",
                target: hostnameTarget(bucket),
              }),
            ),
          );
        }),
      );
      expect(typesOf(compiled)).toEqual({
        Target: "AWS.S3.Bucket",
        "Alias-CNAME": "Cloudflare.DNS.Records",
        "Plain-CNAME": "Cloudflare.DNS.Records",
      });
      expect(yield* propsOf(compiled, "Alias-CNAME")).toEqual({
        zone: "example.com",
        proxied: true,
        type: "CNAME",
        content: "<Target.bucketName>",
        names: ["www.example.com"],
      });
      expect(yield* propsOf(compiled, "Plain-CNAME")).toEqual({
        type: "CNAME",
        content: "<Target.bucketName>",
        names: ["app.example.com"],
      });
      expect(compiled.resources["Alias-CNAME"]!.RemovalPolicy).toBe("destroy");
    }),
  );

  test(
    "alias to addresses declares a Cloudflare.DNS.RecordList `{id}-Addresses`",
    Effect.gen(function* () {
      const compiled = yield* compile(
        Effect.gen(function* () {
          const bucket = yield* target;
          const dns = yield* DNS.resolve(
            Cloudflare.DNS.Adapter({ zone: "example.com" }),
          );
          yield* dns.alias("Literal", {
            name: "a.example.com",
            target: { ipv4: ["192.0.2.1", "192.0.2.2"], ipv6: ["2001:db8::1"] },
          });
          // Address values may be Outputs (e.g. a server's IPs).
          yield* dns.alias("FromOutput", {
            name: "b.example.com",
            target: {
              ipv4: bucket.bucketName.pipe(Output.map((ip: string) => [ip])),
            },
          });
        }),
      );
      expect(typesOf(compiled)).toEqual({
        Target: "AWS.S3.Bucket",
        "Literal-Addresses": "Cloudflare.DNS.RecordList",
        "FromOutput-Addresses": "Cloudflare.DNS.RecordList",
      });
      expect(yield* propsOf(compiled, "Literal-Addresses")).toEqual({
        zone: "example.com",
        records: [
          { name: "a.example.com", type: "A", value: "192.0.2.1" },
          { name: "a.example.com", type: "A", value: "192.0.2.2" },
          { name: "a.example.com", type: "AAAA", value: "2001:db8::1" },
        ],
      });
      expect(
        yield* resolve(
          compiled,
          compiled.resources["FromOutput-Addresses"]!.Props,
          { Target: { bucketName: "198.51.100.7" } },
        ),
      ).toEqual({
        zone: "example.com",
        records: [{ name: "b.example.com", type: "A", value: "198.51.100.7" }],
      });
    }),
  );

  test(
    "aliasSet declares a bindable Cloudflare.DNS.Records `{id}-CNAME`",
    Effect.gen(function* () {
      const compiled = yield* compile(
        Effect.gen(function* () {
          const bucket = yield* target;
          const dns = yield* DNS.resolve(Cloudflare.DNS.Adapter());
          yield* dns.aliasSet("Empty", { target: route53AliasTarget(bucket) });
          yield* dns.aliasSet("Named", {
            names: ["x.example.com"],
            target: hostnameTarget(bucket),
          });
        }),
      );
      expect(typesOf(compiled)).toEqual({
        Target: "AWS.S3.Bucket",
        "Empty-CNAME": "Cloudflare.DNS.Records",
        "Named-CNAME": "Cloudflare.DNS.Records",
      });
      expect(yield* propsOf(compiled, "Empty-CNAME")).toEqual({
        type: "CNAME",
        content: "<Target.bucketName>",
      });
      expect(yield* propsOf(compiled, "Named-CNAME")).toEqual({
        type: "CNAME",
        content: "<Target.bucketName>",
        names: ["x.example.com"],
      });
    }),
  );

  test(
    "records declares a Cloudflare.DNS.RecordList `{id}`, retained on request",
    Effect.gen(function* () {
      const records: DNS.DnsRecord[] = [
        { name: "_v.example.com", type: "TXT", value: "token" },
        { name: "_acme.example.com", type: "CNAME", value: "x.acm.aws." },
      ];
      const compiled = yield* compile(
        Effect.gen(function* () {
          const dns = yield* DNS.resolve(
            Cloudflare.DNS.Adapter({ zone: "example.com", proxied: true }),
          );
          yield* dns.records("Kept", { records, retain: true });
          yield* dns.records("Dropped", { records });
        }),
      );
      expect(typesOf(compiled)).toEqual({
        Kept: "Cloudflare.DNS.RecordList",
        Dropped: "Cloudflare.DNS.RecordList",
      });
      // Records are always DNS-only: no `proxied`.
      expect(yield* propsOf(compiled, "Kept")).toEqual({
        zone: "example.com",
        records,
      });
      expect(compiled.resources["Kept"]!.RemovalPolicy).toBe("retain");
      expect(compiled.resources["Dropped"]!.RemovalPolicy).toBe("destroy");
    }),
  );
});

describe("AWS.Route53 adapter", { tags }, () => {
  test(
    "alias with route53Alias declares A (+ AAAA) alias records",
    Effect.gen(function* () {
      const compiled = yield* compile(
        Effect.gen(function* () {
          const bucket = yield* target;
          const dns = yield* DNS.resolve(
            AWS.Route53.Adapter({ hostedZoneId: "Z1" }),
          );
          yield* dns.alias("Single", {
            name: "www.example.com",
            target: route53AliasTarget(bucket),
          });
          yield* dns.alias("Dual", {
            name: "api.example.com",
            ipv6: true,
            target: {
              hostname: bucket.bucketName,
              route53Alias: {
                hostedZoneId: bucket.bucketArn,
                evaluateTargetHealth: false,
              },
            },
          });
        }),
      );
      expect(typesOf(compiled)).toEqual({
        Target: "AWS.S3.Bucket",
        Single: "AWS.Route53.Record",
        "Dual-A": "AWS.Route53.Record",
        "Dual-AAAA": "AWS.Route53.Record",
      });
      expect(yield* propsOf(compiled, "Single")).toEqual({
        hostedZoneId: "Z1",
        name: "www.example.com",
        type: "A",
        aliasTarget: {
          hostedZoneId: "<Target.bucketArn>",
          dnsName: "<Target.bucketName>",
        },
      });
      for (const type of ["A", "AAAA"]) {
        expect(yield* propsOf(compiled, `Dual-${type}`)).toEqual({
          hostedZoneId: "Z1",
          name: "api.example.com",
          type,
          aliasTarget: {
            hostedZoneId: "<Target.bucketArn>",
            dnsName: "<Target.bucketName>",
            evaluateTargetHealth: false,
          },
        });
      }
    }),
  );

  test(
    "alias to a non-AWS hostname declares a CNAME record `{id}`",
    Effect.gen(function* () {
      const compiled = yield* compile(
        Effect.gen(function* () {
          const bucket = yield* target;
          const dns = yield* DNS.resolve(AWS.Route53.Adapter());
          yield* dns.alias("Cname", {
            name: "www.example.com",
            ipv6: true,
            target: hostnameTarget(bucket),
          });
        }),
      );
      expect(typesOf(compiled)).toEqual({
        Target: "AWS.S3.Bucket",
        Cname: "AWS.Route53.Record",
      });
      const props = yield* propsOf(compiled, "Cname");
      expect(props).toEqual({
        hostedZoneId: undefined,
        name: "www.example.com",
        type: "CNAME",
        ttl: "300 seconds",
        records: ["<Target.bucketName>"],
      });
      // The key is present (undefined) — the exact props AWS composites
      // declared before adapters existed.
      expect("hostedZoneId" in compiled.resources["Cname"]!.Props).toBe(true);
    }),
  );

  test(
    "alias to addresses declares an AWS.Route53.RecordList `{id}-Addresses`",
    Effect.gen(function* () {
      const compiled = yield* compile(
        Effect.gen(function* () {
          const dns = yield* DNS.resolve(
            AWS.Route53.Adapter({ hostedZoneId: "Z1" }),
          );
          yield* dns.alias("Server", {
            name: "a.example.com",
            target: { ipv4: ["192.0.2.1"], ipv6: ["2001:db8::1"] },
          });
        }),
      );
      expect(typesOf(compiled)).toEqual({
        "Server-Addresses": "AWS.Route53.RecordList",
      });
      expect(yield* propsOf(compiled, "Server-Addresses")).toEqual({
        hostedZoneId: "Z1",
        records: [
          { name: "a.example.com", type: "A", value: "192.0.2.1" },
          { name: "a.example.com", type: "AAAA", value: "2001:db8::1" },
        ],
      });
    }),
  );

  test(
    "aliasSet declares an AWS.Route53.Records `{id}` (alias or CNAME)",
    Effect.gen(function* () {
      const compiled = yield* compile(
        Effect.gen(function* () {
          const bucket = yield* target;
          const dns = yield* DNS.resolve(AWS.Route53.Adapter());
          yield* dns.aliasSet("AliasSet", {
            target: route53AliasTarget(bucket),
          });
          yield* dns.aliasSet("CnameSet", {
            names: ["x.example.com"],
            target: hostnameTarget(bucket),
          });
        }),
      );
      expect(typesOf(compiled)).toEqual({
        Target: "AWS.S3.Bucket",
        AliasSet: "AWS.Route53.Records",
        CnameSet: "AWS.Route53.Records",
      });
      expect(yield* propsOf(compiled, "AliasSet")).toEqual({
        hostedZoneId: undefined,
        type: "A",
        aliasTarget: {
          hostedZoneId: "<Target.bucketArn>",
          dnsName: "<Target.bucketName>",
        },
      });
      expect(yield* propsOf(compiled, "CnameSet")).toEqual({
        hostedZoneId: undefined,
        names: ["x.example.com"],
        type: "CNAME",
        ttl: "300 seconds",
        records: ["<Target.bucketName>"],
      });
    }),
  );

  test(
    "records declares an AWS.Route53.RecordList `{id}`, retained on request",
    Effect.gen(function* () {
      const records: DNS.DnsRecord[] = [
        { name: "_v.example.com", type: "TXT", value: "token", ttl: 60 },
      ];
      const compiled = yield* compile(
        Effect.gen(function* () {
          const dns = yield* DNS.resolve(
            AWS.Route53.Adapter({ hostedZoneId: "Z1" }),
          );
          yield* dns.records("Validation", { records, retain: true });
        }),
      );
      expect(typesOf(compiled)).toEqual({
        Validation: "AWS.Route53.RecordList",
      });
      expect(yield* propsOf(compiled, "Validation")).toEqual({
        hostedZoneId: "Z1",
        records,
      });
      expect(compiled.resources["Validation"]!.RemovalPolicy).toBe("retain");
    }),
  );
});

describe("Hetzner.DNS adapter", { tags }, () => {
  test(
    "alias to a hostname declares a Hetzner.DNS.RecordList CNAME `{id}-CNAME`",
    Effect.gen(function* () {
      const compiled = yield* compile(
        Effect.gen(function* () {
          const bucket = yield* target;
          const dns = yield* DNS.resolve(
            Hetzner.DNS.Adapter({ zone: "example.com" }),
          );
          yield* dns.alias("Alias", {
            name: "www.example.com",
            ipv6: true,
            target: route53AliasTarget(bucket),
          });
        }),
      );
      expect(typesOf(compiled)).toEqual({
        Target: "AWS.S3.Bucket",
        "Alias-CNAME": "Hetzner.DNS.RecordList",
      });
      expect(yield* propsOf(compiled, "Alias-CNAME")).toEqual({
        zone: "example.com",
        names: ["www.example.com"],
        target: "<Target.bucketName>",
      });
    }),
  );

  test(
    "alias to addresses declares a Hetzner.DNS.RecordList `{id}-Addresses` (apex allowed)",
    Effect.gen(function* () {
      const compiled = yield* compile(
        Effect.gen(function* () {
          const dns = yield* DNS.resolve(
            Hetzner.DNS.Adapter({ zone: "example.com" }),
          );
          yield* dns.alias("Apex", {
            name: "example.com",
            target: { ipv4: ["192.0.2.1"] },
          });
        }),
      );
      expect(typesOf(compiled)).toEqual({
        "Apex-Addresses": "Hetzner.DNS.RecordList",
      });
      expect(yield* propsOf(compiled, "Apex-Addresses")).toEqual({
        zone: "example.com",
        records: [{ name: "example.com", type: "A", value: "192.0.2.1" }],
      });
    }),
  );

  test(
    "aliasSet and records declare Hetzner.DNS.RecordLists",
    Effect.gen(function* () {
      const records: DNS.DnsRecord[] = [
        { name: "_v.example.com", type: "TXT", value: "token" },
      ];
      const compiled = yield* compile(
        Effect.gen(function* () {
          const bucket = yield* target;
          const dns = yield* DNS.resolve(Hetzner.DNS.Adapter());
          yield* dns.aliasSet("Set", { target: hostnameTarget(bucket) });
          yield* dns.records("Verify", { records, retain: true });
        }),
      );
      expect(typesOf(compiled)).toEqual({
        Target: "AWS.S3.Bucket",
        "Set-CNAME": "Hetzner.DNS.RecordList",
        Verify: "Hetzner.DNS.RecordList",
      });
      expect(yield* propsOf(compiled, "Set-CNAME")).toEqual({
        target: "<Target.bucketName>",
      });
      expect(yield* propsOf(compiled, "Verify")).toEqual({ records });
      expect(compiled.resources["Verify"]!.RemovalPolicy).toBe("retain");
    }),
  );

  test(
    "a CNAME at a pinned zone's apex dies with DnsAdapterError",
    Effect.gen(function* () {
      const alias = yield* failureOf(
        compile(
          Effect.gen(function* () {
            const bucket = yield* target;
            const dns = yield* DNS.resolve(
              Hetzner.DNS.Adapter({ zone: "example.com" }),
            );
            yield* dns.alias("Apex", {
              name: "Example.com.",
              target: hostnameTarget(bucket),
            });
          }),
        ),
      );
      expect(alias).toBeInstanceOf(DNS.DnsAdapterError);
      expect((alias as DNS.DnsAdapterError).message).toContain("zone apex");

      const aliasSet = yield* failureOf(
        compile(
          Effect.gen(function* () {
            const bucket = yield* target;
            const dns = yield* DNS.resolve(
              Hetzner.DNS.Adapter({ zone: "example.com" }),
            );
            yield* dns.aliasSet("Set", {
              names: ["www.example.com", "example.com"],
              target: hostnameTarget(bucket),
            });
          }),
        ),
      );
      expect(aliasSet).toBeInstanceOf(DNS.DnsAdapterError);
    }),
  );
});
