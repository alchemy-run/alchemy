import * as AWS from "@alchemy.run/aws";
import { domainCertificate } from "@alchemy.run/aws/CustomDomain";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { isResolved } from "alchemy/Diff";
import * as DNS from "alchemy/DNS/Adapter";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const events: string[] = [];
let validationReplacements = 0;

interface DelayedDns extends Resource<
  "Test.DelayedDns",
  { names: string[] },
  { names: string[] }
> {}

const DelayedDns = Resource<DelayedDns>("Test.DelayedDns");

const delayedDnsProvider = Provider.succeed(DelayedDns, {
  diff: Effect.fn(function* ({ olds, news }) {
    if (!isResolved(news)) return undefined;
    return JSON.stringify(olds.names) === JSON.stringify(news.names)
      ? undefined
      : ({ action: "update" } as const);
  }),
  reconcile: Effect.fn(function* ({ news }) {
    yield* Effect.sleep("25 millis");
    events.push("dns");
    return { names: news.names };
  }),
  delete: () => Effect.void,
});

const certificateProvider = Provider.succeed(AWS.ACM.Certificate, {
  diff: Effect.fn(function* ({ olds, news }) {
    if (!isResolved(news)) return undefined;
    return olds.domainName === news.domainName ? undefined : ({ action: "update" } as const);
  }),
  reconcile: Effect.fn(function* ({ news }) {
    const domainName = news.domainName;
    return {
      certificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/test",
      domainName,
      subjectAlternativeNames: [],
      status: "PENDING_VALIDATION" as const,
      domainValidationOptions: [
        {
          DomainName: domainName,
          ValidationDomain: domainName,
          ValidationMethod: "DNS" as const,
          ResourceRecord: {
            Name: `_acme.${domainName}.`,
            Type: "CNAME" as const,
            Value: `_value.${domainName}.`,
          },
        },
      ],
      validationMethod: "DNS" as const,
      keyAlgorithm: undefined,
      hostedZoneId: undefined,
      certificateTransparencyLoggingPreference: undefined,
      export: undefined,
      tags: {},
      issuedAt: undefined,
      notAfter: undefined,
    };
  }),
  delete: () => Effect.void,
});

const validationProvider = Provider.succeed(AWS.ACM.CertificateValidation, {
  diff: Effect.fn(function* ({ olds, news }) {
    if (!isResolved(news)) return undefined;
    if (olds.certificateArn !== news.certificateArn) {
      if (olds.certificateArn !== undefined) validationReplacements += 1;
      return { action: "replace" } as const;
    }
    if (JSON.stringify(olds.validationRecordFqdns) !== JSON.stringify(news.validationRecordFqdns)) {
      return { action: "update" } as const;
    }
  }),
  reconcile: Effect.fn(function* ({ news }) {
    expect(events.at(-1)).toBe("dns");
    events.push("validation");
    return {
      certificateArn: news.certificateArn,
      status: "ISSUED",
      issuedAt: undefined,
      notAfter: undefined,
    };
  }),
  delete: () => Effect.void,
});

const dnsAdapter = {
  alias: () => Effect.die("alias is not part of this test adapter"),
  aliasSet: () => Effect.die("aliasSet is not part of this test adapter"),
  records: (
    _id: string,
    { records }: DNS.DnsZone & { records: Input<DNS.DnsRecord[]>; retain?: boolean },
  ) =>
    DelayedDns("ValidationRecords", {
      names: Output.isOutput(records)
        ? Output.map(records, (entries: DNS.DnsRecord[]) => entries.map((entry) => entry.name))
        : [],
    }),
} satisfies DNS.DnsAdapter<Provider.Provider<DelayedDns>>;

const providers = Layer.mergeAll(
  DNS.adapterLayer("Test.DNS", dnsAdapter),
  delayedDnsProvider,
  certificateProvider,
  validationProvider,
);

const { test } = Test.make({ providers });

const program = (domainName: string) =>
  Effect.gen(function* () {
    return yield* domainCertificate("Domain", { domainName }, { type: "Test.DNS" });
  });

test.provider(
  "orders production domainCertificate DNS validation and revalidation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      yield* stack.deploy(program("one.example.com"));
      expect(events).toEqual(["dns", "validation"]);
      expect(validationReplacements).toBe(0);

      events.length = 0;
      yield* stack.deploy(program("two.example.com"));
      expect(events).toEqual(["dns", "validation"]);
      expect(validationReplacements).toBe(0);

      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
