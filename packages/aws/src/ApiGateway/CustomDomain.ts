import type { DnsConfig } from "alchemy/DNS/Adapter";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { domainCertificate, resolveDomainDns } from "../CustomDomain.ts";
import { AWSEnvironment } from "../Environment.ts";
import { BasePathMapping } from "./BasePathMapping.ts";
import { DomainName } from "./DomainName.ts";
import type { RestApi } from "./RestApi.ts";
import type { ApiGatewayStage } from "./Stage.ts";

/**
 * A regional custom hostname attached to an existing REST API stage.
 *
 * This composite deliberately does not create an API or a stage. It composes
 * the native API Gateway v1 `DomainName` and `BasePathMapping` resources,
 * plus ACM and the shared DNS adapter when those are requested.
 */
export interface CustomDomainProps {
  /** Existing REST API to expose. The stage must belong to this API. */
  api: RestApi;
  /** Existing stage belonging to {@link api} to expose through the hostname. */
  stage: ApiGatewayStage;
  /** Hostname to serve, for example `api.example.com`. */
  name: string;
  /** Route 53 hosted zone to use when `dns` is omitted. */
  hostedZoneId?: string;
  /** DNS host for ACM validation and the API Gateway target record. */
  dns?: false | DnsConfig;
  /** Existing validated regional ACM certificate ARN. */
  cert?: Input<string>;
  /** Optional path segment; omit or use an empty string for the root. */
  basePath?: string;
  /** User-defined tags for an ACM certificate and API Gateway domain. */
  tags?: Record<string, string>;
}

/**
 * The resources and endpoint produced by {@link CustomDomain}.
 */
export interface CustomDomain {
  /** Native API Gateway regional custom domain. */
  domain: Effect.Success<ReturnType<typeof DomainName>>;
  /** Native API Gateway base-path mapping. */
  mapping: Effect.Success<ReturnType<typeof BasePathMapping>>;
  /** Regional API Gateway hostname used by DNS providers. */
  target: Input<string>;
  /** HTTPS URL for the mapped stage. */
  url: Input<string>;
  /** Certificate ARN used by the regional domain. */
  certificateArn: Input<string>;
}

/**
 * Attach a custom hostname directly to an existing REST API and stage.
 *
 * ### Regional REST API custom domains
 * **Example:** Cloudflare DNS with an ACM certificate managed by Alchemy
 * ```typescript
 * const customDomain = yield* ApiGateway.CustomDomain("ApiDomain", {
 *   api,
 *   stage,
 *   name: "api.example.com",
 *   dns: Cloudflare.DNS.Adapter(),
 *   basePath: "v1",
 * });
 * ```
 *
 * **Example:** Existing regional certificate and manually managed DNS
 * ```typescript
 * const customDomain = yield* ApiGateway.CustomDomain("ApiDomain", {
 *   api,
 *   stage,
 *   name: "api.example.com",
 *   cert: existingCertificateArn,
 *   dns: false,
 * });
 * ```
 *
 * This helper creates a regional API Gateway domain. The REST API, its stage,
 * and any non-regional domain variants remain explicit resources and are not
 * created by this helper.
 *
 * @resource
 */
export const CustomDomain = Effect.fn("AWS.ApiGateway.CustomDomain")(function* (
  id: string,
  props: CustomDomainProps,
) {
  if (props.dns === false && props.cert === undefined) {
    return yield* Effect.die(
      "ApiGateway.CustomDomain with `dns: false` requires an existing `cert`.",
    );
  }

  const { region } = yield* AWSEnvironment.current;
  const basePath = props.basePath?.replace(/^\/+|\/+$/g, "") || undefined;
  const certificate =
    props.cert === undefined
      ? yield* domainCertificate(
          `${id}Certificate`,
          {
            domainName: props.name,
            ...(props.hostedZoneId === undefined ? {} : { hostedZoneId: props.hostedZoneId }),
            region,
            tags: props.tags,
          },
          props.dns,
        )
      : { certificateArn: props.cert };

  const domain = yield* DomainName(`${id}Domain`, {
    domainName: props.name,
    regionalCertificateArn: certificate.certificateArn,
    endpointConfiguration: { types: ["REGIONAL"] },
    securityPolicy: "TLS_1_2",
    tags: props.tags,
  });

  const mapping = yield* BasePathMapping(`${id}Mapping`, {
    domainName: domain.domainName,
    restApiId: props.api.restApiId,
    stage: props.stage.stageName,
    basePath,
  });

  if (props.dns !== false) {
    const dns = yield* resolveDomainDns(props.dns, props.hostedZoneId);
    yield* dns.alias(`${id}Record`, {
      name: props.name,
      target: {
        hostname: Output.map(domain.regionalDomainName, (target) => target!),
        route53Alias: {
          hostedZoneId: Output.map(domain.regionalHostedZoneId, (zoneId) => zoneId!),
        },
      },
    });
  }

  return {
    domain,
    mapping,
    target: Output.map(domain.regionalDomainName, (target) => target!),
    url: Output.map(
      Output.asOutput(basePath),
      (basePath) => `https://${props.name}${basePath ? `/${basePath.replace(/^\/+/, "")}` : ""}`,
    ),
    certificateArn: certificate.certificateArn,
  };
});
