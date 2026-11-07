import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:apigee", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-api": GCP.Apigee.Api.lookup({ apiId: name }).name,
        "missing-apim-service-extension": GCP.Apigee.ApimServiceExtension.lookup({
          apimServiceExtensionId: name,
        }).name,
        "missing-apiproduct": GCP.Apigee.Apiproduct.lookup({ apiproductId: name }).name,
        "missing-apis-keyvaluemap": GCP.Apigee.ApisKeyvaluemap.lookup({ mapId: name, api: name })
          .name,
        "missing-appgroup": GCP.Apigee.Appgroup.lookup({ appgroupId: name }).name,
        "missing-appgroups-app": GCP.Apigee.AppgroupsApp.lookup({ appId: name, appgroup: name })
          .name,
        "missing-datacollector": GCP.Apigee.Datacollector.lookup({ dataCollectorId: name }).name,
        "missing-developer": GCP.Apigee.Developer.lookup({ email: name }).name,
        "missing-developers-app": GCP.Apigee.DevelopersApp.lookup({
          appName: name,
          developer: name,
        }).name,
        "missing-dns-zone": GCP.Apigee.DnsZone.lookup({ dnsZoneId: name }).name,
        "missing-endpoint-attachment": GCP.Apigee.EndpointAttachment.lookup({
          endpointAttachmentId: name,
        }).name,
        "missing-envgroup": GCP.Apigee.Envgroup.lookup({ envgroupId: name }).name,
        "missing-environment": GCP.Apigee.Environment.lookup({ environmentId: name }).name,
        "missing-environments-archive-deployment": GCP.Apigee.EnvironmentsArchiveDeployment.lookup({
          archiveDeploymentId: name,
          environment: name,
        }).name,
        "missing-environments-keystore": GCP.Apigee.EnvironmentsKeystore.lookup({
          keystoreId: name,
          environment: name,
        }).name,
        "missing-environments-keystores-alias": GCP.Apigee.EnvironmentsKeystoresAlias.lookup({
          aliasId: name,
          environment: name,
          keystore: name,
        }).name,
        "missing-environments-keyvaluemap": GCP.Apigee.EnvironmentsKeyvaluemap.lookup({
          keyvaluemapId: name,
          environment: name,
        }).name,
        "missing-environments-reference": GCP.Apigee.EnvironmentsReference.lookup({
          referenceId: name,
          environment: name,
        }).name,
        "missing-environments-resourcefile": GCP.Apigee.EnvironmentsResourcefile.lookup({
          fileId: name,
          environment: name,
        }).parent,
        "missing-environments-security-action": GCP.Apigee.EnvironmentsSecurityAction.lookup({
          securityActionId: name,
          environment: name,
        }).name,
        "missing-environments-targetserver": GCP.Apigee.EnvironmentsTargetserver.lookup({
          targetserverId: name,
          environment: name,
        }).name,
        "missing-instance": GCP.Apigee.Instance.lookup({ instanceId: name }).name,
        "missing-instances-nat-address": GCP.Apigee.InstancesNatAddress.lookup({
          natAddressId: name,
          instance: name,
        }).name,
        "missing-keyvaluemap": GCP.Apigee.Keyvaluemap.lookup({ mapId: name }).name,
        "missing-organization": GCP.Apigee.Organization.lookup({}).name,
        "missing-report": GCP.Apigee.Report.lookup({ reportId: name }).name,
        "missing-security-feedback": GCP.Apigee.SecurityFeedback.lookup({
          securityFeedbackId: name,
        }).name,
        "missing-security-monitoring-condition": GCP.Apigee.SecurityMonitoringCondition.lookup({
          securityMonitoringConditionId: name,
        }).name,
        "missing-security-profile": GCP.Apigee.SecurityProfile.lookup({ securityProfileId: name })
          .name,
        "missing-security-profiles-v2": GCP.Apigee.SecurityProfilesV2.lookup({
          securityProfileV2Id: name,
        }).name,
        "missing-sharedflow": GCP.Apigee.Sharedflow.lookup({ sharedflowId: name }).name,
        "missing-sites-apidoc": GCP.Apigee.SitesApidoc.lookup({
          siteId: name,
          apiProductName: name,
        }).name,
        "missing-space": GCP.Apigee.Space.lookup({ spaceId: name }).name,
      });
    }),
  { tags, timeout: 555000 },
);
