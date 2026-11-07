export { AccessKey, AccessKeyProvider } from "./AccessKey.ts";
export { AccountAlias, AccountAliasProvider } from "./AccountAlias.ts";
// Runtime bindings (audit/insight surface). The shared `BindingHttp.ts`
// scaffolding is intentionally NOT exported.
export { GenerateCredentialReport } from "./GenerateCredentialReport.ts";
export { GenerateCredentialReportHttp } from "./GenerateCredentialReport.ts";
export { GenerateServiceLastAccessedDetails } from "./GenerateServiceLastAccessedDetails.ts";
export { GenerateServiceLastAccessedDetailsHttp } from "./GenerateServiceLastAccessedDetails.ts";
export { GetAccessKeyLastUsed } from "./GetAccessKeyLastUsed.ts";
export { GetAccessKeyLastUsedHttp } from "./GetAccessKeyLastUsed.ts";
export { GetAccountAuthorizationDetails } from "./GetAccountAuthorizationDetails.ts";
export { GetAccountAuthorizationDetailsHttp } from "./GetAccountAuthorizationDetails.ts";
export { GetAccountSummary } from "./GetAccountSummary.ts";
export { GetAccountSummaryHttp } from "./GetAccountSummary.ts";
export { GetContextKeysForCustomPolicy } from "./GetContextKeysForCustomPolicy.ts";
export { GetContextKeysForCustomPolicyHttp } from "./GetContextKeysForCustomPolicy.ts";
export { GetContextKeysForPrincipalPolicy } from "./GetContextKeysForPrincipalPolicy.ts";
export { GetContextKeysForPrincipalPolicyHttp } from "./GetContextKeysForPrincipalPolicy.ts";
export { GetCredentialReport } from "./GetCredentialReport.ts";
export { GetCredentialReportHttp } from "./GetCredentialReport.ts";
export { GetServiceLastAccessedDetails } from "./GetServiceLastAccessedDetails.ts";
export { GetServiceLastAccessedDetailsHttp } from "./GetServiceLastAccessedDetails.ts";
export { GetServiceLastAccessedDetailsWithEntities } from "./GetServiceLastAccessedDetailsWithEntities.ts";
export { GetServiceLastAccessedDetailsWithEntitiesHttp } from "./GetServiceLastAccessedDetailsWithEntities.ts";
export { ListPoliciesGrantingServiceAccess } from "./ListPoliciesGrantingServiceAccess.ts";
export { ListPoliciesGrantingServiceAccessHttp } from "./ListPoliciesGrantingServiceAccess.ts";
export { SimulateCustomPolicy } from "./SimulateCustomPolicy.ts";
export { SimulateCustomPolicyHttp } from "./SimulateCustomPolicy.ts";
export { SimulatePrincipalPolicy } from "./SimulatePrincipalPolicy.ts";
export { SimulatePrincipalPolicyHttp } from "./SimulatePrincipalPolicy.ts";
export { AccountPasswordPolicy, AccountPasswordPolicyProvider } from "./AccountPasswordPolicy.ts";
export { Group, GroupProvider } from "./Group.ts";
export { GroupMembership, GroupMembershipProvider } from "./GroupMembership.ts";
export { InstanceProfile, InstanceProfileProvider } from "./InstanceProfile.ts";
export { LoginProfile, LoginProfileProvider } from "./LoginProfile.ts";
export { OpenIDConnectProvider, OpenIDConnectProviderProvider } from "./OpenIDConnectProvider.ts";
export {
  normalizePolicyDocument,
  Policy,
  PolicyProvider,
  stringifyPolicyDocument,
  type IamAction,
  type PolicyDocument,
  type PolicyStatement,
  type ServiceControlPolicyDocument,
  type ServiceControlPolicyStatement,
} from "./Policy.ts";
export { Role, RoleProvider } from "./Role.ts";
export { SAMLProvider, SAMLProviderProvider } from "./SAMLProvider.ts";
export { ServerCertificate, ServerCertificateProvider } from "./ServerCertificate.ts";
export {
  ServiceLinkedRole,
  ServiceLinkedRoleDeletionFailed,
  ServiceLinkedRoleProvider,
} from "./ServiceLinkedRole.ts";
export {
  ServiceSpecificCredential,
  ServiceSpecificCredentialProvider,
} from "./ServiceSpecificCredential.ts";
export { SigningCertificate, SigningCertificateProvider } from "./SigningCertificate.ts";
export { SSHPublicKey, SSHPublicKeyProvider } from "./SSHPublicKey.ts";
export { User, UserProvider } from "./User.ts";
export { VirtualMFADevice, VirtualMFADeviceProvider } from "./VirtualMFADevice.ts";
export * from "./generated.ts";
