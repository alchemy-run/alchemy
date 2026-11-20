import * as apprunner from "@distilled.cloud/aws/apprunner";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import { makeAppRunnerHttpBinding } from "./BindingHttp.ts";
import type { Service } from "./Service.ts";

export interface DescribeCustomDomainsRequest extends Omit<
  apprunner.DescribeCustomDomainsRequest,
  "ServiceArn"
> {}

/**
 * Describe the custom domains associated with an App Runner
 * {@link Service} from a Lambda (or other AWS runtime) — poll a domain's
 * certificate validation status (`PENDING_VALIDATION` -> `SUCCESS`) after
 * {@link AssociateCustomDomain}, and read the `DNSTarget` customers point
 * their DNS at.
 *
 * Provide `AppRunner.DescribeCustomDomainsHttp` on the hosting function's
 * Effect to implement the binding.
 *
 * ### Custom Domains
 * **Example:** Check a domain's validation status
 * ```typescript
 * const describeCustomDomains = yield* AppRunner.DescribeCustomDomains(service);
 * const { CustomDomains, DNSTarget } = yield* describeCustomDomains();
 * const domain = CustomDomains.find((d) => d.DomainName === "app.customer.com");
 * // domain?.Status -> "pending_certificate_dns_validation" | "active" | ...
 * ```
 *
 * @binding
 */
export interface DescribeCustomDomains extends Binding.Service<
  DescribeCustomDomains,
  "AWS.AppRunner.DescribeCustomDomains",
  (
    service: Service,
  ) => Effect.Effect<
    (
      request?: DescribeCustomDomainsRequest,
    ) => Effect.Effect<
      apprunner.DescribeCustomDomainsResponse,
      apprunner.DescribeCustomDomainsError
    >
  >
> {}
export const DescribeCustomDomains = Binding.Service<DescribeCustomDomains>(
  "AWS.AppRunner.DescribeCustomDomains",
);

/**
 * HTTP implementation of the {@link DescribeCustomDomains} binding. Calls
 * `apprunner:DescribeCustomDomains` with the Lambda's IAM role, scoped to
 * the bound service.
 */
export const DescribeCustomDomainsHttp = makeAppRunnerHttpBinding(DescribeCustomDomains, {
  operation: apprunner.describeCustomDomains,
  spec: (service: Service) => ({
    identifiers: { ServiceArn: service.serviceArn },
    iam: () => ({
      actions: ["apprunner:DescribeCustomDomains"],
      resources: [service.serviceArn],
    }),
  }),
});
