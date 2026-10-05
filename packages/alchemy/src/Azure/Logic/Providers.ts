import * as Layer from "effect/Layer";
import {
  IntegrationAccount,
  IntegrationAccountProvider,
} from "./IntegrationAccount.ts";
import {
  IntegrationAccountAgreement,
  IntegrationAccountAgreementProvider,
} from "./IntegrationAccountAgreement.ts";
import {
  IntegrationAccountAssembly,
  IntegrationAccountAssemblyProvider,
} from "./IntegrationAccountAssembly.ts";
import {
  IntegrationAccountBatchConfiguration,
  IntegrationAccountBatchConfigurationProvider,
} from "./IntegrationAccountBatchConfiguration.ts";
import {
  IntegrationAccountCertificate,
  IntegrationAccountCertificateProvider,
} from "./IntegrationAccountCertificate.ts";
import {
  IntegrationAccountMap,
  IntegrationAccountMapProvider,
} from "./IntegrationAccountMap.ts";
import {
  IntegrationAccountPartner,
  IntegrationAccountPartnerProvider,
} from "./IntegrationAccountPartner.ts";
import {
  IntegrationAccountSchema,
  IntegrationAccountSchemaProvider,
} from "./IntegrationAccountSchema.ts";
import { Workflow, WorkflowProvider } from "./Workflow.ts";

export const resources = [
  IntegrationAccount,
  IntegrationAccountAgreement,
  IntegrationAccountAssembly,
  IntegrationAccountBatchConfiguration,
  IntegrationAccountCertificate,
  IntegrationAccountMap,
  IntegrationAccountPartner,
  IntegrationAccountSchema,
  Workflow,
];
export const layers = () =>
  Layer.mergeAll(
    IntegrationAccountProvider(),
    IntegrationAccountAgreementProvider(),
    IntegrationAccountAssemblyProvider(),
    IntegrationAccountBatchConfigurationProvider(),
    IntegrationAccountCertificateProvider(),
    IntegrationAccountMapProvider(),
    IntegrationAccountPartnerProvider(),
    IntegrationAccountSchemaProvider(),
    WorkflowProvider(),
  );
