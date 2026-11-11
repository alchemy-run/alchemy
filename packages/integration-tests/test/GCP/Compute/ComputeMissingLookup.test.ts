import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:compute", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-address": GCP.Compute.Address.lookup({ addressName: name }).addressName,
        "missing-autoscaler": GCP.Compute.Autoscaler.lookup({ autoscalerName: name })
          .autoscalerName,
        "missing-backend-bucket": GCP.Compute.BackendBucket.lookup({ name }).name,
        "missing-backend-service": GCP.Compute.BackendService.lookup({ name }).name,
        "missing-cross-site-network": GCP.Compute.CrossSiteNetwork.lookup({
          crossSiteNetworkName: name,
        }).crossSiteNetworkName,
        "missing-disk": GCP.Compute.Disk.lookup({ diskName: name }).diskName,
        "missing-external-vpn-gateway": GCP.Compute.ExternalVpnGateway.lookup({
          externalVpnGatewayName: name,
        }).externalVpnGatewayName,
        "missing-forwarding-rule": GCP.Compute.ForwardingRule.lookup({ forwardingRuleName: name })
          .forwardingRuleName,
        "missing-future-reservation": GCP.Compute.FutureReservation.lookup({
          futureReservationName: name,
        }).futureReservationName,
        "missing-global-address": GCP.Compute.GlobalAddress.lookup({ addressName: name })
          .addressName,
        "missing-global-forwarding-rule": GCP.Compute.GlobalForwardingRule.lookup({
          forwardingRuleName: name,
        }).forwardingRuleName,
        "missing-global-network-endpoint-group": GCP.Compute.GlobalNetworkEndpointGroup.lookup({
          networkEndpointGroupName: name,
        }).networkEndpointGroupName,
        "missing-global-public-delegated-prefix": GCP.Compute.GlobalPublicDelegatedPrefix.lookup({
          prefixName: name,
        }).prefixName,
        "missing-global-vm-extension-policy": GCP.Compute.GlobalVmExtensionPolicy.lookup({
          policyName: name,
        }).policyName,
        "missing-health-check": GCP.Compute.HealthCheck.lookup({ healthCheckName: name })
          .healthCheckName,
        "missing-http-health-check": GCP.Compute.HttpHealthCheck.lookup({
          httpHealthCheckName: name,
        }).httpHealthCheckName,
        "missing-https-health-check-resource": GCP.Compute.HttpsHealthCheck.lookup({
          httpsHealthCheckName: name,
        }).httpsHealthCheckName,
        "missing-image": GCP.Compute.Image.lookup({ imageName: name }).imageName,
        "missing-instance": GCP.Compute.Instance.lookup({ instanceName: name }).instanceName,
        "missing-instance-group": GCP.Compute.InstanceGroup.lookup({ instanceGroupName: name })
          .instanceGroupName,
        "missing-instance-group-manager": GCP.Compute.InstanceGroupManager.lookup({
          managerName: name,
        }).managerName,
        "missing-instance-group-manager-resize-request":
          GCP.Compute.InstanceGroupManagerResizeRequest.lookup({
            resizeRequestName: name,
            instanceGroupManager: name,
          }).resizeRequestName,
        "missing-instance-template": GCP.Compute.InstanceTemplate.lookup({ templateName: name })
          .templateName,
        "missing-instant-snapshot": GCP.Compute.InstantSnapshot.lookup({
          instantSnapshotName: name,
          sourceDisk: name,
        }).instantSnapshotName,
        "missing-instant-snapshot-group": GCP.Compute.InstantSnapshotGroup.lookup({
          instantSnapshotGroupName: name,
        }).instantSnapshotGroupName,
        "missing-interconnect": GCP.Compute.Interconnect.lookup({ interconnectName: name })
          .interconnectName,
        "missing-interconnect-attachment": GCP.Compute.InterconnectAttachment.lookup({
          interconnectAttachmentName: name,
        }).interconnectAttachmentName,
        "missing-interconnect-attachment-group": GCP.Compute.InterconnectAttachmentGroup.lookup({
          interconnectAttachmentGroupName: name,
        }).interconnectAttachmentGroupName,
        "missing-interconnect-group": GCP.Compute.InterconnectGroup.lookup({
          interconnectGroupName: name,
        }).interconnectGroupName,
        "missing-license": GCP.Compute.License.lookup({ licenseName: name }).licenseName,
        "missing-machine-image": GCP.Compute.MachineImage.lookup({ machineImageName: name })
          .machineImageName,
        "missing-network-attachment": GCP.Compute.NetworkAttachment.lookup({
          networkAttachmentName: name,
        }).networkAttachmentName,
        "missing-network-edge-security-service": GCP.Compute.NetworkEdgeSecurityService.lookup({
          networkEdgeSecurityServiceName: name,
        }).networkEdgeSecurityServiceName,
        "missing-network-endpoint-group": GCP.Compute.NetworkEndpointGroup.lookup({
          networkEndpointGroupName: name,
        }).networkEndpointGroupName,
        "missing-network-firewall-policy": GCP.Compute.NetworkFirewallPolicy.lookup({
          networkFirewallPolicyName: name,
        }).networkFirewallPolicyName,
        "missing-node-group": GCP.Compute.NodeGroup.lookup({ nodeGroupName: name }).nodeGroupName,
        "missing-node-template": GCP.Compute.NodeTemplate.lookup({ nodeTemplateName: name })
          .nodeTemplateName,
        "missing-packet-mirroring": GCP.Compute.PacketMirroring.lookup({
          packetMirroringName: name,
        }).packetMirroringName,
        "missing-public-advertised-prefix": GCP.Compute.PublicAdvertisedPrefix.lookup({
          prefixName: name,
        }).prefixName,
        "missing-public-delegated-prefix": GCP.Compute.PublicDelegatedPrefix.lookup({
          prefixName: name,
        }).prefixName,
        "missing-region-autoscaler": GCP.Compute.RegionAutoscaler.lookup({ autoscalerName: name })
          .autoscalerName,
        "missing-region-backend-bucket": GCP.Compute.RegionBackendBucket.lookup({ name }).name,
        "missing-region-backend-service": GCP.Compute.RegionBackendService.lookup({ name }).name,
        "missing-region-composite-health-check": GCP.Compute.RegionCompositeHealthCheck.lookup({
          healthCheckName: name,
        }).healthCheckName,
        "missing-region-disk": GCP.Compute.RegionDisk.lookup({ diskName: name }).diskName,
        "missing-region-health-aggregation-policy":
          GCP.Compute.RegionHealthAggregationPolicy.lookup({ policyName: name }).policyName,
        "missing-region-health-check": GCP.Compute.RegionHealthCheck.lookup({
          healthCheckName: name,
        }).healthCheckName,
        "missing-region-health-check-service": GCP.Compute.RegionHealthCheckService.lookup({
          serviceName: name,
        }).serviceName,
        "missing-region-health-source": GCP.Compute.RegionHealthSource.lookup({ sourceName: name })
          .sourceName,
        "missing-region-instance-group-manager": GCP.Compute.RegionInstanceGroupManager.lookup({
          managerName: name,
        }).managerName,
        "missing-region-instance-template": GCP.Compute.RegionInstanceTemplate.lookup({
          templateName: name,
        }).templateName,
        "missing-region-instant-snapshot": GCP.Compute.RegionInstantSnapshot.lookup({
          instantSnapshotName: name,
        }).instantSnapshotName,
        "missing-region-instant-snapshot-group": GCP.Compute.RegionInstantSnapshotGroup.lookup({
          instantSnapshotGroupName: name,
        }).instantSnapshotGroupName,
        "missing-region-network-endpoint-group": GCP.Compute.RegionNetworkEndpointGroup.lookup({
          networkEndpointGroupName: name,
        }).networkEndpointGroupName,
        "missing-region-network-firewall-policy": GCP.Compute.RegionNetworkFirewallPolicy.lookup({
          firewallPolicyName: name,
        }).firewallPolicyName,
        "missing-region-notification-endpoint": GCP.Compute.RegionNotificationEndpoint.lookup({
          notificationEndpointName: name,
        }).notificationEndpointName,
        "missing-region-security-policy": GCP.Compute.RegionSecurityPolicy.lookup({
          securityPolicyName: name,
        }).securityPolicyName,
        "missing-region-snapshot": GCP.Compute.RegionSnapshot.lookup({ snapshotName: name })
          .snapshotName,
        "missing-region-ssl-certificate": GCP.Compute.RegionSslCertificate.lookup({
          sslCertificateName: name,
        }).sslCertificateName,
        "missing-region-ssl-policy": GCP.Compute.RegionSslPolicy.lookup({ sslPolicyName: name })
          .sslPolicyName,
        "missing-region-target-http-proxy": GCP.Compute.RegionTargetHttpProxy.lookup({
          targetHttpProxyName: name,
        }).targetHttpProxyName,
        "missing-region-target-https-proxy": GCP.Compute.RegionTargetHttpsProxy.lookup({
          targetHttpsProxyName: name,
        }).targetHttpsProxyName,
        "missing-region-target-tcp-proxy": GCP.Compute.RegionTargetTcpProxy.lookup({
          targetTcpProxyName: name,
        }).targetTcpProxyName,
        "missing-region-url-map": GCP.Compute.RegionUrlMap.lookup({ urlMapName: name }).urlMapName,
        "missing-reservation": GCP.Compute.Reservation.lookup({ reservationName: name })
          .reservationName,
        "missing-resource-policy": GCP.Compute.ResourcePolicy.lookup({ resourcePolicyName: name })
          .resourcePolicyName,
        "missing-rollout-plan": GCP.Compute.RolloutPlan.lookup({ rolloutPlanName: name })
          .rolloutPlanName,
        "missing-route": GCP.Compute.Route.lookup({ routeName: name }).routeName,
        "missing-router": GCP.Compute.Router.lookup({ routerName: name }).routerName,
        "missing-security-policy": GCP.Compute.SecurityPolicy.lookup({ securityPolicyName: name })
          .securityPolicyName,
        "missing-service-attachment": GCP.Compute.ServiceAttachment.lookup({
          serviceAttachmentName: name,
        }).serviceAttachmentName,
        "missing-snapshot": GCP.Compute.Snapshot.lookup({ snapshotName: name }).snapshotName,
        "missing-ssl-certificate": GCP.Compute.SslCertificate.lookup({ sslCertificateName: name })
          .sslCertificateName,
        "missing-ssl-policy": GCP.Compute.SslPolicy.lookup({ sslPolicyName: name }).sslPolicyName,
        "missing-storage-pool": GCP.Compute.StoragePool.lookup({ storagePoolName: name })
          .storagePoolName,
        "missing-target-grpc-proxy": GCP.Compute.TargetGrpcProxy.lookup({
          targetGrpcProxyName: name,
        }).targetGrpcProxyName,
        "missing-target-http-proxy": GCP.Compute.TargetHttpProxy.lookup({
          targetHttpProxyName: name,
        }).targetHttpProxyName,
        "missing-target-https-proxy": GCP.Compute.TargetHttpsProxy.lookup({
          targetHttpsProxyName: name,
        }).targetHttpsProxyName,
        "missing-target-instance": GCP.Compute.TargetInstance.lookup({
          targetInstanceName: name,
          instance: name,
        }).targetInstanceName,
        "missing-target-pool": GCP.Compute.TargetPool.lookup({ targetPoolName: name })
          .targetPoolName,
        "missing-target-ssl-proxy": GCP.Compute.TargetSslProxy.lookup({ targetSslProxyName: name })
          .targetSslProxyName,
        "missing-target-tcp-proxy": GCP.Compute.TargetTcpProxy.lookup({ targetTcpProxyName: name })
          .targetTcpProxyName,
        "missing-target-vpn-gateway": GCP.Compute.TargetVpnGateway.lookup({
          targetVpnGatewayName: name,
        }).targetVpnGatewayName,
        "missing-url-map": GCP.Compute.UrlMap.lookup({ urlMapName: name }).urlMapName,
        "missing-vpn-gateway": GCP.Compute.VpnGateway.lookup({ vpnGatewayName: name })
          .vpnGatewayName,
        "missing-vpn-tunnel": GCP.Compute.VpnTunnel.lookup({ vpnTunnelName: name }).vpnTunnelName,
        "missing-wire-group": GCP.Compute.WireGroup.lookup({
          wireGroupName: name,
          crossSiteNetwork: name,
        }).wireGroupName,
        "missing-zone-vm-extension-policy": GCP.Compute.ZoneVmExtensionPolicy.lookup({
          vmExtensionPolicyName: name,
        }).vmExtensionPolicyName,
      });
    }),
  { tags, timeout: 1380000 },
);
