import * as domainservices from "@distilled.cloud/azure/domainservices";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  stackAndStage,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface OuContainerProps {
  /**
   * Resource group of the managed domain. Changing it replaces the OU.
   */
  resourceGroup: string;
  /**
   * Name of the parent `Azure.DomainServices.DomainService`. Changing it
   * replaces the OU.
   */
  domainService: string;
  /**
   * Name of the organizational unit: letters, digits, and `-`. If omitted,
   * a unique name is generated from the app, stage, and logical ID.
   * Changing it replaces the OU.
   */
  name?: string;
  /**
   * Name of the service account created in the OU.
   */
  accountName: string;
  /**
   * Service principal name (SPN) of the service account.
   */
  spn: string;
  /**
   * Password of the service account. Write-only: Azure never returns it, so
   * a change is detected against the previous props.
   */
  password: string | Redacted.Redacted<string>;
}

export interface OuContainerAccount {
  /** Name of the service account. */
  accountName: string | undefined;
  /** Service principal name of the account. */
  spn: string | undefined;
}

export interface OuContainer extends Resource<
  "Azure.DomainServices.OuContainer",
  OuContainerProps,
  {
    /** Name of the organizational unit. */
    ouContainerName: string;
    /** ARM resource ID of the OU container. */
    ouContainerId: string;
    /** Resource group of the managed domain. */
    resourceGroup: string;
    /** Name of the parent domain service. */
    domainService: string;
    /** Container ID Azure assigned to the OU. */
    containerId: string | undefined;
    /** Distinguished name of the OU, e.g. `OU=name,DC=contoso,DC=com`. */
    distinguishedName: string | undefined;
    /** DNS name of the managed domain. */
    domainName: string | undefined;
    /** Deployment ID of the managed domain. */
    deploymentId: string | undefined;
    /** Health status of the OU. */
    serviceStatus: string | undefined;
    /** Service accounts in the OU (passwords omitted). */
    accounts: OuContainerAccount[];
  },
  never,
  Providers
> {}

/**
 * A custom organizational unit (OU) inside a Microsoft Entra Domain
 * Services managed domain, with a service account. Custom OUs hold
 * accounts, groups, and computers that are not synchronized from
 * Microsoft Entra ID.
 *
 * OU containers carry no tags; ownership follows the parent managed
 * domain's Alchemy tags.
 *
 * @see https://learn.microsoft.com/entra/identity/domain-services/create-ou
 *
 * ### Creating an Organizational Unit
 * **Example:** OU with a service account
 * ```typescript
 * const ou = yield* Azure.DomainServices.OuContainer("apps", {
 *   resourceGroup: group.resourceGroupName,
 *   domainService: domain.domainServiceName,
 *   accountName: "svc-apps",
 *   spn: "http/apps.aaddscontoso.com",
 *   password: Redacted.make(servicePassword),
 * });
 * ```
 *
 * @resource
 */
export const OuContainer = Resource<OuContainer>(
  "Azure.DomainServices.OuContainer",
);

type Observed = domainservices.GetOuContainerResponse;

const lower = (value: string | undefined) => value?.toLowerCase();

const reveal = (value: string | Redacted.Redacted<string> | undefined) =>
  value === undefined || typeof value === "string"
    ? value
    : Redacted.value(value);

const createOuName = (id: string) =>
  createPhysicalName({ id, maxLength: 64, delimiter: "-" });

const getOuContainer = (
  subscriptionId: string,
  resourceGroupName: string,
  domainServiceName: string,
  ouContainerName: string,
) =>
  orUndefinedIfNotFound(
    domainservices.GetOuContainer({
      subscriptionId,
      resourceGroupName,
      domainServiceName,
      ouContainerName,
    }),
  );

/** The parent managed domain carries this stack/stage's ownership tags. */
const isParentOwned = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  domainServiceName: string,
) {
  const service = yield* orUndefinedIfNotFound(
    domainservices.GetDomainService({
      subscriptionId,
      resourceGroupName,
      domainServiceName,
    }),
  );
  const { stack, stage } = yield* stackAndStage;
  return (
    service?.tags?.["alchemy::stack"] === stack &&
    service?.tags?.["alchemy::stage"] === stage
  );
});

const toAttrs = (
  resourceGroup: string,
  domainService: string,
  name: string,
  observed: Observed,
): OuContainer["Attributes"] => {
  const props = observed.properties ?? {};
  return {
    ouContainerName: name,
    ouContainerId: observed.id ?? "",
    resourceGroup,
    domainService,
    containerId: props.containerId,
    distinguishedName: props.distinguishedName,
    domainName: props.domainName,
    deploymentId: props.deploymentId,
    serviceStatus: props.serviceStatus,
    accounts: (props.accounts ?? []).map((account) => ({
      accountName: account.accountName,
      spn: account.spn,
    })),
  };
};

const BUDGET = { interval: "10 seconds", times: 60 } as const;

export const OuContainerProvider = () =>
  Provider.succeed(OuContainer, {
    stables: [
      "ouContainerName",
      "ouContainerId",
      "resourceGroup",
      "domainService",
      "containerId",
    ],

    // OU containers vanish with their managed domain and carry no tags.
    list: () => Effect.succeed([]),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.domainService) !== lower(output.domainService) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.ouContainerName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const domainService = output?.domainService ?? olds?.domainService;
      if (resourceGroup === undefined || domainService === undefined) {
        return undefined;
      }
      const name =
        output?.ouContainerName ?? olds?.name ?? (yield* createOuName(id));
      const observed = yield* getOuContainer(
        subscriptionId,
        resourceGroup,
        domainService,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, domainService, name, observed);
      return (yield* isParentOwned(
        subscriptionId,
        resourceGroup,
        domainService,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.AAD");
      const { resourceGroup, domainService } = news;
      const name =
        news.name ?? output?.ouContainerName ?? (yield* createOuName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        domainServiceName: domainService,
        ouContainerName: name,
      };
      const label = `OU container ${name}`;
      const get = getOuContainer(
        subscriptionId,
        resourceGroup,
        domainService,
        name,
      );
      const password = reveal(news.password);

      // Observe.
      let observed = yield* get;

      // Ensure.
      const created = observed === undefined;
      if (observed === undefined) {
        yield* domainservices.CreateOuContainer({
          ...where,
          accountName: news.accountName,
          spn: news.spn,
          password,
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (ou) => ou.properties?.provisioningState,
        BUDGET,
      );

      // Sync the service account against observed state. The password is
      // write-only; the previous props are its only baseline.
      const account = observed.properties?.accounts?.find(
        (a) => lower(a.accountName) === lower(news.accountName),
      );
      const passwordChanged =
        !created && (olds === undefined || reveal(olds.password) !== password);
      if (
        account === undefined ||
        account.spn !== news.spn ||
        passwordChanged
      ) {
        yield* domainservices.UpdateOuContainer({
          ...where,
          accountName: news.accountName,
          spn: news.spn,
          password,
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          (ou) => ou.properties?.provisioningState,
          BUDGET,
        );
      }

      return toAttrs(resourceGroup, domainService, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        domainservices.DeleteOuContainer({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          domainServiceName: output.domainService,
          ouContainerName: output.ouContainerName,
        }),
      );
      yield* waitUntilGone(
        `OU container ${output.ouContainerName}`,
        getOuContainer(
          subscriptionId,
          output.resourceGroup,
          output.domainService,
          output.ouContainerName,
        ),
        BUDGET,
      );
    }),

    nuke: { dependsOn: ["Azure.DomainServices.DomainService"] },
  });
