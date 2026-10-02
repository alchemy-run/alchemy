import * as Layer from "effect/Layer";
import { Api, ApiProvider } from "./Api.ts";
import { ApiDiagnostic, ApiDiagnosticProvider } from "./ApiDiagnostic.ts";
import { ApiOperation, ApiOperationProvider } from "./ApiOperation.ts";
import {
  ApiOperationPolicy,
  ApiOperationPolicyProvider,
} from "./ApiOperationPolicy.ts";
import {
  ApiOperationTagLink,
  ApiOperationTagLinkProvider,
} from "./ApiOperationTagLink.ts";
import { ApiPolicy, ApiPolicyProvider } from "./ApiPolicy.ts";
import { ApiRelease, ApiReleaseProvider } from "./ApiRelease.ts";
import { ApiSchema, ApiSchemaProvider } from "./ApiSchema.ts";
import {
  ApiTagDescription,
  ApiTagDescriptionProvider,
} from "./ApiTagDescription.ts";
import { ApiTagLink, ApiTagLinkProvider } from "./ApiTagLink.ts";
import { ApiVersionSet, ApiVersionSetProvider } from "./ApiVersionSet.ts";
import { ApiWiki, ApiWikiProvider } from "./ApiWiki.ts";
import {
  Authorization,
  AuthorizationResourceProvider,
} from "./Authorization.ts";
import {
  AuthorizationAccessPolicy,
  AuthorizationAccessPolicyProvider,
} from "./AuthorizationAccessPolicy.ts";
import {
  AuthorizationProvider,
  AuthorizationProviderProvider,
} from "./AuthorizationProvider.ts";
import {
  AuthorizationServer,
  AuthorizationServerProvider,
} from "./AuthorizationServer.ts";
import { Backend, BackendProvider } from "./Backend.ts";
import { Cache, CacheProvider } from "./Cache.ts";
import { Certificate, CertificateProvider } from "./Certificate.ts";
import { Diagnostic, DiagnosticProvider } from "./Diagnostic.ts";
import { Documentation, DocumentationProvider } from "./Documentation.ts";
import { EmailTemplate, EmailTemplateProvider } from "./EmailTemplate.ts";
import { Gateway, GatewayProvider } from "./Gateway.ts";
import { GatewayApi, GatewayApiProvider } from "./GatewayApi.ts";
import {
  GatewayCertificateAuthority,
  GatewayCertificateAuthorityProvider,
} from "./GatewayCertificateAuthority.ts";
import {
  GatewayHostnameConfiguration,
  GatewayHostnameConfigurationProvider,
} from "./GatewayHostnameConfiguration.ts";
import { GlobalSchema, GlobalSchemaProvider } from "./GlobalSchema.ts";
import {
  GraphQLApiResolver,
  GraphQLApiResolverProvider,
} from "./GraphQLApiResolver.ts";
import {
  GraphQLApiResolverPolicy,
  GraphQLApiResolverPolicyProvider,
} from "./GraphQLApiResolverPolicy.ts";
import { Group, GroupProvider } from "./Group.ts";
import { GroupUser, GroupUserProvider } from "./GroupUser.ts";
import {
  IdentityProvider,
  IdentityProviderProvider,
} from "./IdentityProvider.ts";
import { Logger, LoggerProvider } from "./Logger.ts";
import { NamedValue, NamedValueProvider } from "./NamedValue.ts";
import { Notification, NotificationProvider } from "./Notification.ts";
import {
  NotificationRecipientEmail,
  NotificationRecipientEmailProvider,
} from "./NotificationRecipientEmail.ts";
import {
  NotificationRecipientUser,
  NotificationRecipientUserProvider,
} from "./NotificationRecipientUser.ts";
import {
  OpenIdConnectProvider,
  OpenIdConnectProviderProvider,
} from "./OpenIdConnectProvider.ts";
import { PolicyFragment, PolicyFragmentProvider } from "./PolicyFragment.ts";
import {
  PolicyRestriction,
  PolicyRestrictionProvider,
} from "./PolicyRestriction.ts";
import { Product, ProductProvider } from "./Product.ts";
import { ProductApi, ProductApiProvider } from "./ProductApi.ts";
import { ProductApiLink, ProductApiLinkProvider } from "./ProductApiLink.ts";
import { ProductGroup, ProductGroupProvider } from "./ProductGroup.ts";
import {
  ProductGroupLink,
  ProductGroupLinkProvider,
} from "./ProductGroupLink.ts";
import { ProductPolicy, ProductPolicyProvider } from "./ProductPolicy.ts";
import { ProductTagLink, ProductTagLinkProvider } from "./ProductTagLink.ts";
import { ProductWiki, ProductWikiProvider } from "./ProductWiki.ts";
import { Service, ServiceProvider } from "./Service.ts";
import { ServicePolicy, ServicePolicyProvider } from "./ServicePolicy.ts";
import { Subscription, SubscriptionProvider } from "./Subscription.ts";
import { Tag, TagProvider } from "./Tag.ts";
import { TagApiLink, TagApiLinkProvider } from "./TagApiLink.ts";
import {
  TagOperationLink,
  TagOperationLinkProvider,
} from "./TagOperationLink.ts";
import { TagProductLink, TagProductLinkProvider } from "./TagProductLink.ts";
import { User, UserProvider } from "./User.ts";
import { Workspace, WorkspaceProvider } from "./Workspace.ts";

export const resources = [
  Api,
  ApiDiagnostic,
  ApiOperation,
  ApiOperationPolicy,
  ApiOperationTagLink,
  ApiPolicy,
  ApiRelease,
  ApiSchema,
  ApiTagDescription,
  ApiTagLink,
  ApiVersionSet,
  ApiWiki,
  Authorization,
  AuthorizationAccessPolicy,
  AuthorizationProvider,
  AuthorizationServer,
  Backend,
  Cache,
  Certificate,
  Diagnostic,
  Documentation,
  EmailTemplate,
  Gateway,
  GatewayApi,
  GatewayCertificateAuthority,
  GatewayHostnameConfiguration,
  GlobalSchema,
  GraphQLApiResolver,
  GraphQLApiResolverPolicy,
  Group,
  GroupUser,
  IdentityProvider,
  Logger,
  NamedValue,
  Notification,
  NotificationRecipientEmail,
  NotificationRecipientUser,
  OpenIdConnectProvider,
  PolicyFragment,
  PolicyRestriction,
  Product,
  ProductApi,
  ProductApiLink,
  ProductGroup,
  ProductGroupLink,
  ProductPolicy,
  ProductTagLink,
  ProductWiki,
  Service,
  ServicePolicy,
  Subscription,
  Tag,
  TagApiLink,
  TagOperationLink,
  TagProductLink,
  User,
  Workspace,
];
export const layers = () =>
  Layer.mergeAll(
    Layer.mergeAll(
      ApiProvider(),
      ApiDiagnosticProvider(),
      ApiOperationProvider(),
      ApiOperationPolicyProvider(),
      ApiOperationTagLinkProvider(),
      ApiPolicyProvider(),
      ApiReleaseProvider(),
      ApiSchemaProvider(),
      ApiTagDescriptionProvider(),
      ApiTagLinkProvider(),
      ApiVersionSetProvider(),
      ApiWikiProvider(),
      AuthorizationResourceProvider(),
      AuthorizationAccessPolicyProvider(),
      AuthorizationProviderProvider(),
      AuthorizationServerProvider(),
      BackendProvider(),
      CacheProvider(),
      CertificateProvider(),
      DiagnosticProvider(),
      DocumentationProvider(),
      EmailTemplateProvider(),
      GatewayProvider(),
      GatewayApiProvider(),
      GatewayCertificateAuthorityProvider(),
      GatewayHostnameConfigurationProvider(),
      GlobalSchemaProvider(),
      GraphQLApiResolverProvider(),
      GraphQLApiResolverPolicyProvider(),
      GroupProvider(),
      GroupUserProvider(),
      IdentityProviderProvider(),
      LoggerProvider(),
      NamedValueProvider(),
      NotificationProvider(),
      NotificationRecipientEmailProvider(),
      NotificationRecipientUserProvider(),
      OpenIdConnectProviderProvider(),
      PolicyFragmentProvider(),
      PolicyRestrictionProvider(),
    ),
    Layer.mergeAll(
      ProductProvider(),
      ProductApiProvider(),
      ProductApiLinkProvider(),
      ProductGroupProvider(),
      ProductGroupLinkProvider(),
      ProductPolicyProvider(),
      ProductTagLinkProvider(),
      ProductWikiProvider(),
      ServiceProvider(),
      ServicePolicyProvider(),
      SubscriptionProvider(),
      TagProvider(),
      TagApiLinkProvider(),
      TagOperationLinkProvider(),
      TagProductLinkProvider(),
      UserProvider(),
      WorkspaceProvider(),
    ),
  );
