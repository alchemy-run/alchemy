import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:networksecurity", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-address-group": GCP.NetworkSecurity.AddressGroup.lookup({ addressGroupId: name })
          .name,
        "missing-authorization-policy": GCP.NetworkSecurity.AuthorizationPolicy.lookup({
          authorizationPolicyId: name,
        }).name,
        "missing-authz-policy": GCP.NetworkSecurity.AuthzPolicy.lookup({ authzPolicyId: name })
          .name,
        "missing-backend-authentication-config":
          GCP.NetworkSecurity.BackendAuthenticationConfig.lookup({
            backendAuthenticationConfigId: name,
          }).name,
        "missing-client-tls-policy": GCP.NetworkSecurity.ClientTlsPolicy.lookup({
          clientTlsPolicyId: name,
        }).name,
        "missing-dns-threat-detector": GCP.NetworkSecurity.DnsThreatDetector.lookup({
          dnsThreatDetectorId: name,
        }).name,
        "missing-firewall-endpoint": GCP.NetworkSecurity.FirewallEndpoint.lookup({
          firewallEndpointId: name,
        }).name,
        "missing-firewall-endpoint-association":
          GCP.NetworkSecurity.FirewallEndpointAssociation.lookup({
            firewallEndpointAssociationId: name,
          }).name,
        "missing-gateway-security-policies-rule":
          GCP.NetworkSecurity.GatewaySecurityPoliciesRule.lookup({
            gatewaySecurityPolicyRuleId: name,
            gatewaySecurityPolicy: name,
          }).name,
        "missing-gateway-security-policy": GCP.NetworkSecurity.GatewaySecurityPolicy.lookup({
          gatewaySecurityPolicyId: name,
        }).name,
        "missing-intercept-deployment": GCP.NetworkSecurity.InterceptDeployment.lookup({
          interceptDeploymentId: name,
        }).name,
        "missing-intercept-deployment-group": GCP.NetworkSecurity.InterceptDeploymentGroup.lookup({
          interceptDeploymentGroupId: name,
        }).name,
        "missing-intercept-endpoint-group": GCP.NetworkSecurity.InterceptEndpointGroup.lookup({
          interceptEndpointGroupId: name,
        }).name,
        "missing-intercept-endpoint-group-association":
          GCP.NetworkSecurity.InterceptEndpointGroupAssociation.lookup({
            interceptEndpointGroupAssociationId: name,
          }).name,
        "missing-mirroring-deployment": GCP.NetworkSecurity.MirroringDeployment.lookup({
          mirroringDeploymentId: name,
        }).name,
        "missing-mirroring-deployment-group": GCP.NetworkSecurity.MirroringDeploymentGroup.lookup({
          mirroringDeploymentGroupId: name,
        }).name,
        "missing-mirroring-endpoint-group": GCP.NetworkSecurity.MirroringEndpointGroup.lookup({
          mirroringEndpointGroupId: name,
        }).name,
        "missing-mirroring-endpoint-group-association":
          GCP.NetworkSecurity.MirroringEndpointGroupAssociation.lookup({
            mirroringEndpointGroupAssociationId: name,
          }).name,
        "missing-sac-attachment": GCP.NetworkSecurity.SacAttachment.lookup({
          sacAttachmentId: name,
        }).name,
        "missing-sac-realm": GCP.NetworkSecurity.SacRealm.lookup({ sacRealmId: name }).name,
        "missing-security-profile": GCP.NetworkSecurity.SecurityProfile.lookup({
          securityProfileId: name,
        }).name,
        "missing-security-profile-group": GCP.NetworkSecurity.SecurityProfileGroup.lookup({
          securityProfileGroupId: name,
        }).name,
        "missing-server-tls-policy": GCP.NetworkSecurity.ServerTlsPolicy.lookup({
          serverTlsPolicyId: name,
        }).name,
        "missing-tls-inspection-policy": GCP.NetworkSecurity.TlsInspectionPolicy.lookup({
          tlsInspectionPolicyId: name,
        }).name,
        "missing-url-list": GCP.NetworkSecurity.UrlList.lookup({ urlListId: name }).name,
      });
    }),
  { tags, timeout: 435000 },
);
