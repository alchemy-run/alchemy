<!-- Docs for the generated AWS.Route53Resolver bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## GetResolverEndpoint

Runtime binding for `route53resolver:GetResolverEndpoint` — read the bound
{@link ResolverEndpoint}'s live state (status, IP address count, host VPC,
protocols); the endpoint ID is injected automatically.

Provide `Route53Resolver.GetResolverEndpointHttp` on the hosting Lambda
Function to satisfy the requirement.
### Reading Endpoint State
**Example:** Read the Endpoint Status
```typescript
// init — grants route53resolver:GetResolverEndpoint on the endpoint
const getEndpoint = yield* AWS.Route53Resolver.GetResolverEndpoint(endpoint);

// runtime
const { ResolverEndpoint } = yield* getEndpoint();
console.log(ResolverEndpoint?.Status, ResolverEndpoint?.IpAddressCount);
```

@binding

## GetResolverRule

Runtime binding for `route53resolver:GetResolverRule` — read the bound
{@link ResolverRule}'s live state (domain name, target IPs, endpoint,
status); the rule ID is injected automatically.

Provide `Route53Resolver.GetResolverRuleHttp` on the hosting Lambda
Function to satisfy the requirement.
### Reading Rule State
**Example:** Read the Rule's Target IPs
```typescript
// init — grants route53resolver:GetResolverRule on the rule
const getRule = yield* AWS.Route53Resolver.GetResolverRule(rule);

// runtime
const { ResolverRule } = yield* getRule();
const targets = (ResolverRule?.TargetIps ?? []).map((t) => t.Ip);
```

@binding

## ListResolverEndpointIpAddresses

Runtime binding for `route53resolver:ListResolverEndpointIpAddresses` —
discover the IP addresses the bound {@link ResolverEndpoint}'s network
interfaces answer/forward on (one per subnet); the endpoint ID is injected
automatically.

The canonical runtime use: DNS bootstrap automation that reads an INBOUND
endpoint's IPs to configure on-premises conditional forwarders (or a VPN /
DHCP option set) without hard-coding addresses.

Provide `Route53Resolver.ListResolverEndpointIpAddressesHttp` on the
hosting Lambda Function to satisfy the requirement.
### Discovering Endpoint IPs
**Example:** List the Endpoint's IP Addresses
```typescript
// init — grants route53resolver:ListResolverEndpointIpAddresses on the endpoint
const listIps = yield* AWS.Route53Resolver.ListResolverEndpointIpAddresses(endpoint);

// runtime
const { IpAddresses } = yield* listIps();
const ips = (IpAddresses ?? []).map((ip) => ip.Ip);
```

@binding

## UpdateResolverRule

Runtime binding for `route53resolver:UpdateResolverRule` — update the
bound {@link ResolverRule}'s mutable configuration (name, target IPs,
outbound endpoint); the rule ID is injected automatically.

The canonical runtime use: DNS failover automation — a Lambda health-checks
the on-premises resolvers a FORWARD rule targets and swaps `TargetIps` to
the healthy set when one goes dark.

Provide `Route53Resolver.UpdateResolverRuleHttp` on the hosting Lambda
Function to satisfy the requirement.
### Updating Rules at Runtime
**Example:** Fail Over the Rule's Target IPs
```typescript
// init — grants route53resolver:UpdateResolverRule on the rule
const updateRule = yield* AWS.Route53Resolver.UpdateResolverRule(rule);

// runtime
yield* updateRule({
  Config: { TargetIps: [{ Ip: "192.168.2.10", Port: 53 }] },
});
```

@binding
