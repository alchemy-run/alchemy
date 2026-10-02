import * as Layer from "effect/Layer";
import { Api, ApiProvider } from "./Api.ts";
import { ApiOperation, ApiOperationProvider } from "./ApiOperation.ts";
import { ApiPolicy, ApiPolicyProvider } from "./ApiPolicy.ts";
import { ApiVersionSet, ApiVersionSetProvider } from "./ApiVersionSet.ts";
import {
  AuthorizationProvider,
  AuthorizationProviderProvider,
} from "./AuthorizationProvider.ts";
import { Backend, BackendProvider } from "./Backend.ts";
import { Certificate, CertificateProvider } from "./Certificate.ts";
import { Diagnostic, DiagnosticProvider } from "./Diagnostic.ts";
import { Gateway, GatewayProvider } from "./Gateway.ts";
import { Group, GroupProvider } from "./Group.ts";
import { Logger, LoggerProvider } from "./Logger.ts";
import { NamedValue, NamedValueProvider } from "./NamedValue.ts";
import { Product, ProductProvider } from "./Product.ts";
import { ProductApi, ProductApiProvider } from "./ProductApi.ts";
import { Service, ServiceProvider } from "./Service.ts";
import { ServicePolicy, ServicePolicyProvider } from "./ServicePolicy.ts";
import { Subscription, SubscriptionProvider } from "./Subscription.ts";

export const resources = [
  Api,
  ApiOperation,
  ApiPolicy,
  ApiVersionSet,
  AuthorizationProvider,
  Backend,
  Certificate,
  Diagnostic,
  Gateway,
  Group,
  Logger,
  NamedValue,
  Product,
  ProductApi,
  Service,
  ServicePolicy,
  Subscription,
];
export const layers = () =>
  Layer.mergeAll(
    ApiProvider(),
    ApiOperationProvider(),
    ApiPolicyProvider(),
    ApiVersionSetProvider(),
    AuthorizationProviderProvider(),
    BackendProvider(),
    CertificateProvider(),
    DiagnosticProvider(),
    GatewayProvider(),
    GroupProvider(),
    LoggerProvider(),
    NamedValueProvider(),
    ProductProvider(),
    ProductApiProvider(),
    ServiceProvider(),
    ServicePolicyProvider(),
    SubscriptionProvider(),
  );
