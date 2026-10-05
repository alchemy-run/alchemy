import * as app from "@distilled.cloud/azure/app";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createContainerAppsName,
  getEnvironment,
  lower,
  sameLocation,
} from "./common.ts";

export interface ManagedCertificateProps {
  /** Resource group of the environment. Changing it replaces the certificate. */
  resourceGroup: string;
  /** Name of the Container Apps environment. Changing it replaces the certificate. */
  environment: string;
  /**
   * Certificate name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the certificate.
   */
  name?: string;
  /**
   * Location of the certificate; must match the environment's.
   * Changing it replaces the certificate.
   * @default the environment's location
   */
  location?: string;
  /**
   * Hostname to issue the certificate for (e.g. `www.example.com`). The
   * hostname must already be bound to an app in the environment, with its
   * DNS records in place. Changing it replaces the certificate.
   */
  subjectName: string;
  /**
   * How domain ownership is proven: `CNAME` (subdomains), `HTTP`, or `TXT`
   * (apex domains; publish `validationToken` as a TXT record). Changing it
   * replaces the certificate.
   * @default "CNAME"
   */
  domainControlValidation?: "CNAME" | "HTTP" | "TXT";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ManagedCertificate extends Resource<
  "Azure.ContainerApps.ManagedCertificate",
  ManagedCertificateProps,
  {
    /** Name of the certificate. */
    certificateName: string;
    /** ARM resource ID; reference it from a custom domain binding. */
    certificateId: string;
    /** Name of the environment. */
    environment: string;
    /** Resource group of the environment. */
    resourceGroup: string;
    /** Location of the certificate. */
    location: string;
    /** Hostname the certificate is issued for. */
    subjectName: string | undefined;
    /** TXT token for `TXT` domain control validation. */
    validationToken: string | undefined;
    /** Provisioning state (`Succeeded` once issued). */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A free, Microsoft-managed TLS certificate for a custom domain of a
 * Container Apps environment
 * (`Microsoft.App/managedEnvironments/managedCertificates`). Azure issues
 * and renews it once domain ownership is validated.
 *
 * Issuance takes 5-20 minutes and needs the domain's DNS records (the
 * `asuid` TXT record with the environment's verification ID and a CNAME
 * or A record) to be in place; reconcile waits until the certificate is
 * issued.
 *
 * @see https://learn.microsoft.com/azure/container-apps/custom-domains-managed-certificates
 *
 * ### Issuing a Certificate
 * **Example:** Managed certificate for a subdomain
 * ```typescript
 * const cert = yield* Azure.ContainerApps.ManagedCertificate("www", {
 *   resourceGroup: group.resourceGroupName,
 *   environment: env.environmentName,
 *   subjectName: "www.example.com",
 *   domainControlValidation: "CNAME",
 * });
 * // bind with { name: "www.example.com", certificateId: cert.certificateId,
 * //   bindingType: "SniEnabled" } in the app's ingress customDomains
 * ```
 *
 * @resource
 */
export const ManagedCertificate = Resource<ManagedCertificate>(
  "Azure.ContainerApps.ManagedCertificate",
);

const createCertificateName = (id: string) => createContainerAppsName(id, 60);

const getCertificate = (
  subscriptionId: string,
  resourceGroupName: string,
  environmentName: string,
  managedCertificateName: string,
) =>
  orUndefinedIfNotFound(
    app.GetManagedCertificate({
      subscriptionId,
      resourceGroupName,
      environmentName,
      managedCertificateName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  environment: string,
  name: string,
  observed: app.GetManagedCertificateResponse,
): ManagedCertificate["Attributes"] => ({
  certificateName: name,
  certificateId: observed.id ?? "",
  environment,
  resourceGroup,
  location: observed.location,
  subjectName: observed.properties?.subjectName,
  validationToken: observed.properties?.validationToken,
  provisioningState: observed.properties?.provisioningState,
  tags: userTags(observed.tags),
});

export const ManagedCertificateProvider = () =>
  Provider.succeed(ManagedCertificate, {
    stables: [
      "certificateName",
      "certificateId",
      "environment",
      "resourceGroup",
      "location",
    ],

    // Lives inside an environment; nuke removes it with the environment.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        news.environment !== output.environment ||
        (news.name !== undefined && news.name !== output.certificateName) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location)) ||
        lower(news.subjectName) !== lower(output.subjectName) ||
        (olds !== undefined &&
          (news.domainControlValidation ?? "CNAME") !==
            (olds.domainControlValidation ?? "CNAME"))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const environment = output?.environment ?? olds?.environment;
      if (resourceGroup === undefined || environment === undefined) {
        return undefined;
      }
      const name =
        output?.certificateName ??
        olds?.name ??
        (yield* createCertificateName(id));
      const observed = yield* getCertificate(
        subscriptionId,
        resourceGroup,
        environment,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, environment, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.App");
      const { resourceGroup, environment } = news;
      const name =
        news.name ??
        output?.certificateName ??
        (yield* createCertificateName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        environmentName: environment,
        managedCertificateName: name,
      };
      const get = getCertificate(
        subscriptionId,
        resourceGroup,
        environment,
        name,
      );
      // Issuance (domain validation + CA) takes 5-20 minutes.
      const ready = waitForProvisioned(
        `managed certificate ${name}`,
        get,
        (cert) => cert.properties?.provisioningState,
        { interval: "10 seconds", times: 150 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure. A certificate must live in its environment's location.
      if (observed === undefined) {
        const location =
          news.location ??
          output?.location ??
          (yield* getEnvironment(subscriptionId, resourceGroup, environment))
            ?.location ??
          (yield* AzureEnvironment.current).location;
        yield* app.ManagedCertificatesCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: {
            subjectName: news.subjectName,
            domainControlValidation: news.domainControlValidation ?? "CNAME",
          },
        });
      }
      observed = yield* ready;

      // Sync tags; subject and validation method are immutable.
      if (tagsDiffer(observed.tags, tags)) {
        yield* app.UpdateManagedCertificate({ ...where, tags });
        observed = yield* ready;
      }

      return toAttrs(resourceGroup, environment, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        app.DeleteManagedCertificate({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          environmentName: output.environment,
          managedCertificateName: output.certificateName,
        }),
      );
      yield* waitUntilGone(
        `managed certificate ${output.certificateName}`,
        getCertificate(
          subscriptionId,
          output.resourceGroup,
          output.environment,
          output.certificateName,
        ),
      );
    }),
  });
