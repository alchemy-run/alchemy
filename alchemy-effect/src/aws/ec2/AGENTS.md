# ec2

VPC networking: 15 resources (VPC, Subnet, IGW, NAT, Security Groups, Route Tables, ACLs, Endpoints)

## RESOURCES

**Core Network**: VPC, Subnet, Elastic IP
**Gateways**: Internet Gateway, NAT Gateway, Egress-Only IGW, VPC Endpoint  
**Security**: Security Group, Security Group Rule, Network ACL, Network ACL Entry, Network ACL Association
**Routing**: Route Table, Route, Route Table Association

## DEPENDENCY ORDER

1. **VPC** - Root dependency
2. **Subnet, Internet Gateway, Security Group, Network ACL, Route Table** - Require VPC
3. **Elastic IP** - Independent (for NAT Gateway)
4. **NAT Gateway** - Requires Subnet + Elastic IP (public) or just Subnet (private)
5. **Route, Security Group Rule** - Require Route Table/Security Group + optional gateway refs
6. **Associations** - Require both parent and target (Route Table + Subnet, Network ACL + Subnet)

## PROVIDER PATTERNS

**VPC Dependency**: Most resources replace on `vpcId` change (Subnet, Security Group, Network ACL, Route Table)

**Waiters**: Async operations require polling:
- `waitForSubnetAvailable`: 2s fixed, max 60s (subnet.provider.ts:289)
- `waitForNatGatewayAvailable`: 5s fixed, max 5m (nat-gateway.provider.ts:251)
- `waitForNatGatewayDeleted`: 5s fixed, max 5m (nat-gateway.provider.ts:304)
- `waitForAssociationState`: 1s fixed, max 30s (route-table-association.provider.ts:148)

**Security Group Lifecycle**: Delete requires revoking rules first (security-group.provider.ts:277-312)
- Current rules fetched via `describeSecurityGroupRules`
- Revoke ingress/egress by `SecurityGroupRuleIds`
- Then delete group with retry on `DependencyViolation`

**Route Table Associations**: Use `ReplaceRouteTableAssociation` for updates (route-table-association.provider.ts:80-112)
- Returns new `associationId` on route table change
- Subnet/gateway change requires full replace

**Route Updates**: Use `ReplaceRoute` for target changes (route.provider.ts:104-152)
- Destination changes require replacement
- Target (gateway/NAT/etc) changes use in-place replace

**IGW Attachment**: Separate attach/detach after create (internet-gateway.provider.ts:51-64)
- Retry on `InvalidVpcID.NotFound`
- Detach before delete with `DependencyViolation` retry

**Retry Patterns**:
- `InvalidVpcID.NotFound`, `InvalidRouteTableID.NotFound`, `InvalidSubnetID.NotFound`: Exponential 100ms base
- `DependencyViolation`: Exponential 1s base, 1.5 factor, 10-15 recurs
- State polling: Fixed intervals (1-5s) with recurs limits
