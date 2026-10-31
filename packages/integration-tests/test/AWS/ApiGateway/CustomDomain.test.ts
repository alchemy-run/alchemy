import * as AWS from "@alchemy.run/aws";
import {
  Certificate,
  CertificateValidation,
  type CertificateProps,
} from "@alchemy.run/aws/ACM";
import { Record as Route53Record, type RecordProps as Route53RecordProps } from "@alchemy.run/aws/Route53/Record";
import * as Cloudflare from "@alchemy.run/cloudflare";
import {
  RecordList as CloudflareRecordList,
  type RecordListProps as CloudflareRecordListProps,
} from "@alchemy.run/cloudflare/DNS/RecordList";
import { Records as CloudflareRecords, type RecordsProps } from "@alchemy.run/cloudflare/DNS/Records";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Provider from "alchemy/Provider";
import * as Output from "alchemy/Output";
import { isResolved } from "alchemy/Diff";
import { inMemoryState } from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const calls = {
  certificates: [] as CertificateProps[],
  domains: [] as AWS.ApiGateway.DomainNameProps[],
  mappings: [] as AWS.ApiGateway.BasePathMappingProps[],
  cloudflareRecords: [] as RecordsProps[],
  cloudflareValidation: [] as CloudflareRecordListProps[],
  route53Records: [] as Route53RecordProps[],
};

const fakeProviders = () =>
  Layer.mergeAll(
    Provider.succeed(AWS.ApiGateway.RestApi, {
      reconcile: Effect.fn(function* ({ news }) {
        return {
          restApiId: "api-123",
          rootResourceId: "root-123",
          name: news.name ?? "api",
          description: news.description,
          version: news.version,
          binaryMediaTypes: news.binaryMediaTypes,
          minimumCompressionSize: news.minimumCompressionSize,
          apiKeySource: news.apiKeySource,
          endpointConfiguration: news.endpointConfiguration,
          policy: news.policy,
          disableExecuteApiEndpoint: news.disableExecuteApiEndpoint,
          securityPolicy: news.securityPolicy,
          endpointAccessMode: news.endpointAccessMode,
          tags: {},
        };
      }),
      delete: Effect.fn(function* () {}),
    }),
    Provider.succeed(AWS.ApiGateway.DeploymentResource, {
      reconcile: Effect.fn(function* ({ news }) {
        return {
          deploymentId: "deployment-123",
          restApiId: "api-123",
          description: news.description,
        };
      }),
      delete: Effect.fn(function* () {}),
    }),
    Provider.succeed(AWS.ApiGateway.StageResource, {
      reconcile: Effect.fn(function* ({ news }) {
        return {
          restApiId: "api-123",
          stageName: news.stageName,
          deploymentId: "deployment-123",
          description: news.description,
          cacheClusterEnabled: news.cacheClusterEnabled,
          cacheClusterSize: news.cacheClusterSize,
          variables: news.variables,
          documentationVersion: news.documentationVersion,
          canarySettings: news.canarySettings,
          tracingEnabled: news.tracingEnabled,
          methodSettings: undefined,
          accessLogSettings: news.accessLogSettings,
          webAclArn: news.webAclArn,
          tags: {},
        };
      }),
      delete: Effect.fn(function* () {}),
    }),
    Provider.succeed(Certificate, {
      reconcile: Effect.fn(function* ({ news }) {
        calls.certificates.push(news);
        return {
          certificateArn: "arn:aws:acm:us-west-2:123456789012:certificate/managed",
          domainName: news.domainName,
          subjectAlternativeNames: news.subjectAlternativeNames ?? [],
          status: undefined,
          domainValidationOptions: [
            {
              DomainName: "api.example.com",
              ValidationMethod: "DNS",
              ResourceRecord: {
                Name: "_acme-challenge.api.example.com",
                Type: "CNAME",
                Value: "_validation.acm.example.com",
              },
            },
          ],
          validationMethod: news.validationMethod,
          keyAlgorithm: news.keyAlgorithm,
          hostedZoneId: news.hostedZoneId,
          certificateTransparencyLoggingPreference:
            news.certificateTransparencyLoggingPreference,
          export: news.export,
          tags: news.tags ?? {},
          issuedAt: undefined,
          notAfter: undefined,
        };
      }),
      delete: Effect.fn(function* () {}),
    }),
    Provider.succeed(CertificateValidation, {
      reconcile: Effect.fn(function* ({ news }) {
        return {
          certificateArn: news.certificateArn,
          status: "ISSUED",
          issuedAt: undefined,
          notAfter: undefined,
        };
      }),
      delete: Effect.fn(function* () {}),
    }),
    Provider.succeed(AWS.ApiGateway.DomainName, {
      reconcile: Effect.fn(function* ({ news }) {
        calls.domains.push(news);
        return {
          domainName: news.domainName,
          regionalDomainName: `d-${news.domainName}.execute-api.us-west-2.amazonaws.com`,
          regionalHostedZoneId: "Z2FDTNDATAQYW2",
          distributionDomainName: undefined,
          distributionHostedZoneId: undefined,
          domainNameArn: `arn:aws:apigateway:us-west-2::/domainnames/${news.domainName}`,
          tags: news.tags ?? {},
          configuration: undefined,
        };
      }),
      delete: Effect.fn(function* () {}),
    }),
    Provider.succeed(AWS.ApiGateway.BasePathMapping, {
      diff: Effect.fn(function* ({ news, olds }) {
        if (!isResolved(news)) return;
        if (news.basePath !== olds.basePath) return { action: "replace" } as const;
      }),
      reconcile: Effect.fn(function* ({ news }) {
        if (!isResolved(news)) return yield* Effect.die("mapping props unresolved");
        calls.mappings.push(news);
        return {
          domainName: news.domainName,
          domainNameId: news.domainNameId,
          basePath: news.basePath ?? "(none)",
          restApiId: "api-123",
          stage: news.stage,
        };
      }),
      delete: Effect.fn(function* () {}),
    }),
    Provider.succeed(CloudflareRecords, {
      reconcile: Effect.fn(function* ({ news }) {
        calls.cloudflareRecords.push(news);
        return {
          zoneId: "cf-zone",
          type: news.type,
          content: news.content,
          proxied: news.proxied ?? false,
          ttl: news.ttl ?? 1,
          names: news.names ?? [],
        };
      }),
      delete: Effect.fn(function* () {}),
    }),
    Provider.succeed(CloudflareRecordList, {
      reconcile: Effect.fn(function* ({ news }) {
        calls.cloudflareValidation.push(news);
        return { records: [] };
      }),
      delete: Effect.fn(function* () {}),
    }),
    Provider.succeed(Route53Record, {
      reconcile: Effect.fn(function* ({ news }) {
        if (!isResolved(news)) return yield* Effect.die("record props unresolved");
        calls.route53Records.push(news);
        return {
          hostedZoneId: "Z1234567890",
          name: news.name,
          type: news.type,
          ttl: undefined,
          records: undefined,
          aliasTarget: {
            hostedZoneId: "Z2FDTNDATAQYW2",
            dnsName: "d-route53.example.com.execute-api.us-west-2.amazonaws.com",
          },
          setIdentifier: undefined,
          weight: undefined,
          region: undefined,
          failover: undefined,
          geoLocation: undefined,
          geoProximityLocation: undefined,
          multiValueAnswer: undefined,
          cidrRoutingConfig: undefined,
          healthCheckId: undefined,
        };
      }),
      delete: Effect.fn(function* () {}),
    }),
    Layer.succeed(
      AWS.AWSEnvironment,
      Effect.succeed({
        accountId: "123456789012",
        region: "us-west-2",
        credentials: Effect.die("fake credentials are not used by these providers"),
      }),
    ),
    Cloudflare.DNS.AdapterLive,
    AWS.Route53.AdapterLive,
  );

const { test } = Test.make({ providers: fakeProviders(), state: inMemoryState() });

const stackProgram = (basePath = "/v1/") => Effect.gen(function* () {
  const api = yield* AWS.ApiGateway.RestApi("Api", {
    endpointConfiguration: { types: ["REGIONAL"] },
  });
  const deployment = yield* AWS.ApiGateway.Deployment("Deployment", { restApi: api });
  const stage = yield* AWS.ApiGateway.Stage("Stage", {
    restApi: api,
    stageName: "prod",
    deploymentId: deployment.deploymentId,
  });

  const managed = yield* AWS.ApiGateway.CustomDomain("Cloudflare", {
    api,
    stage,
    name: "api.example.com",
    dns: Cloudflare.DNS.Adapter({ zone: "cf-zone" }),
    basePath,
  });
  const manual = yield* AWS.ApiGateway.CustomDomain("Manual", {
    api,
    stage,
    name: "manual.example.com",
    cert: Output.map(
      api.restApiId,
      () => "arn:aws:acm:us-west-2:123456789012:certificate/existing",
    ),
    dns: false,
  });
  const route53 = yield* AWS.ApiGateway.CustomDomain("Route53", {
    api,
    stage,
    name: "route53.example.com",
    cert: "arn:aws:acm:us-west-2:123456789012:certificate/existing",
    hostedZoneId: "Z1234567890",
  });

  return { managed, manual, route53 };
});

test.provider(
  "executes the REST custom-domain graph with fake cloud providers",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      calls.certificates.length = 0;
      calls.domains.length = 0;
      calls.mappings.length = 0;
      calls.cloudflareRecords.length = 0;
      calls.cloudflareValidation.length = 0;
      calls.route53Records.length = 0;

      const output = yield* stack.deploy(stackProgram());

      expect(output.managed.domain.domainName).toBe("api.example.com");
      expect(output.managed.mapping.restApiId).toBe("api-123");
      expect(output.managed.mapping.stage).toBe("prod");
      expect(output.managed.mapping.basePath).toBe("v1");
      expect(output.managed.url).toBe("https://api.example.com/v1");
      expect(calls.certificates).toHaveLength(1);
      expect(calls.cloudflareRecords).toHaveLength(1);
      expect(calls.cloudflareRecords[0]?.content).toBe(
        "d-api.example.com.execute-api.us-west-2.amazonaws.com",
      );
      const managedDomain = calls.domains.find((domain) => domain.domainName === "api.example.com");
      expect(managedDomain?.regionalCertificateArn).toBe(
        "arn:aws:acm:us-west-2:123456789012:certificate/managed",
      );
      expect(managedDomain?.endpointConfiguration).toEqual({ types: ["REGIONAL"] });
      expect(managedDomain?.securityPolicy).toBe("TLS_1_2");
      expect(calls.cloudflareValidation).toHaveLength(1);
      expect(calls.cloudflareValidation[0]?.records).toEqual([
        {
          name: "_acme-challenge.api.example.com",
          type: "CNAME",
          value: "_validation.acm.example.com",
        },
      ]);

      expect(output.manual.certificateArn).toBe(
        "arn:aws:acm:us-west-2:123456789012:certificate/existing",
      );
      expect(output.manual.mapping.basePath).toBe("(none)");
      expect(calls.certificates).toHaveLength(1);
      expect(calls.cloudflareRecords).toHaveLength(1);
      expect(calls.cloudflareValidation).toHaveLength(1);

      expect(calls.route53Records).toHaveLength(1);
      expect(calls.route53Records[0]?.aliasTarget).toEqual({
        hostedZoneId: "Z2FDTNDATAQYW2",
        dnsName: "d-route53.example.com.execute-api.us-west-2.amazonaws.com",
      });

      const updated = yield* stack.deploy(stackProgram("v2/"));
      expect(updated.managed.mapping.basePath).toBe("v2");
      expect(updated.managed.url).toBe("https://api.example.com/v2");
      expect(
        calls.mappings
          .filter((mapping) => mapping.domainName === "api.example.com")
          .map((mapping) => mapping.basePath),
      ).toEqual(["v1", "v2"]);

      yield* stack.destroy();
    }),
  { tags: ["unit", "provider:aws", "provider:cloudflare"], timeout: 120_000 },
);
