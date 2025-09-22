import type { Context } from "../context.ts";
import { Resource } from "../resource.ts";
import { secret, type Secret } from "../secret.ts";
import { diff } from "../util/diff.ts";
import {
  createClickhouseApi,
  type Service as ApiService,
  type Organization,
} from "./api.ts";

export interface ServiceProps {
  /**
   * The key ID for the Clickhouse API
   */
  keyId?: string | Secret<string>;

  /**
   * The secret for the Clickhouse API
   */
  secret?: string | Secret<string>;

  /**
   * The id of Clickhouse cloud organization to create the service in.
   */
  organization: string | Organization;

  /**
   * The name of the Clickhouse service to create.
   *
   * @default ${app}-${stage}-${id}
   */
  name?: string;

  /**
   * The underlying cloud provider to create the service on.
   */
  provider: ApiService["provider"];

  /**
   * The region to create the service in.
   */
  region: ApiService["region"];

  /**
   * The IP access list to create the service with.
   *
   * @default [{ description: "Anywhere", source: "0.0.0.0/0" }]
   */
  ipAccessList?: ApiService["ipAccessList"];

  /**
   * The minimum replica memory to create the service with.
   *
   * @default 8
   */
  minReplicaMemoryGb?: ApiService["minReplicaMemoryGb"];

  /**
   * The maximum replica memory to create the service with.
   *
   * @default 356
   */
  maxReplicaMemoryGb?: ApiService["maxReplicaMemoryGb"];

  /**
   * The number of replicas to create the service with.
   *
   * @default 3
   */
  numReplicas?: ApiService["numReplicas"];

  /**
   * Whether to enable idle scaling.
   *
   * @default true
   */
  idleScaling?: ApiService["idleScaling"];

  /**
   * The timeout minutes for idle scaling.
   *
   * @default 15
   */
  idleTimeoutMinutes?: ApiService["idleTimeoutMinutes"];

  /**
   * Whether to make the service readonly.
   *
   * @default false
   */
  isReadonly?: ApiService["isReadonly"];

  /**
   * The release channel to create the service with.
   *
   * @default "default"
   */
  releaseChannel?: ApiService["releaseChannel"];

  /**
   * The desired state of the service.
   *
   * @default "start"
   */
  stateTarget?: "start" | "stop";

  //todo(pr): I need to understand more about what these properties do
  //todo(pr): support linking to BYOC infrastructure directly
  byocId?: ApiService["byocId"];
  hasTransparentDataEncryption?: ApiService["hasTransparentDataEncryption"];
  //todo(michael): can this be any of the protocol types? since their type fails to mention that
  endpoints?: Array<{
    protocol: "mysql";
    enabled: boolean;
  }>;
  profile?: ApiService["profile"];
  complianceType?: ApiService["complianceType"];
  dataWarehouseId?: ApiService["dataWarehouseId"];
  backupId?: string;
  encryptionKey?: ApiService["encryptionKey"];
  encryptionAssumedRoleIdentifier?: ApiService["encryptionAssumedRoleIdentifier"];
}

export interface Service extends Resource<"clickhouse::Service"> {
  organizationId: string;
  name: string;
  clickhouseId: string;
  password: Secret<string>;
  provider: ApiService["provider"];
  region: ApiService["region"];
  ipAccessList: ApiService["ipAccessList"];
  minReplicaMemoryGb: ApiService["minReplicaMemoryGb"];
  maxReplicaMemoryGb: ApiService["maxReplicaMemoryGb"];
  numReplicas: ApiService["numReplicas"];
  idleScaling: ApiService["idleScaling"];
  idleTimeoutMinutes: ApiService["idleTimeoutMinutes"];
  isReadonly: ApiService["isReadonly"];
  dataWarehouseId: ApiService["dataWarehouseId"];
  encryptionKey?: ApiService["encryptionKey"];
  encryptionAssumedRoleIdentifier?: ApiService["encryptionAssumedRoleIdentifier"];
  releaseChannel: ApiService["releaseChannel"];
  byocId?: ApiService["byocId"];
  hasTransparentDataEncryption: ApiService["hasTransparentDataEncryption"];
  profile: ApiService["profile"];
  complianceType?: ApiService["complianceType"];
  backupId?: string;
  //todo(pr): do we want to split this out into separate properties so we dont have to use find to access?
  endpoints: ApiService["endpoints"];
  stateTarget: "start" | "stop";
  state: ApiService["state"];
}

/**
 * Create, manage and delete Clickhouse services
 *
 * @example
 * // Create a basic Clickhouse service on aws
 * const organization = await getOrganizationByName("Alchemy's Organization");
 * const service = await Service("clickhouse", {
 *   organization,
 *   provider: "aws",
 *   region: "us-east-1",
 * });
 *
 * @example
 * // Create a basic Clickhouse service on aws with custom scaling rules
 * const service = await Service("clickhouse", {
 *   organization,
 *   provider: "aws",
 *   region: "us-east-1",
 *   minReplicaMemoryGb: 8,
 *   maxReplicaMemoryGb: 356,
 *   numReplicas: 3,
 * });
 */
export const Service = Resource(
  "clickhouse::Service",
  async function (
    this: Context<Service>,
    id: string,
    props: ServiceProps,
  ): Promise<Service> {
    const api = createClickhouseApi({
      keyId: props.keyId,
      secret: props.secret,
    });

    const idleScaling = props.idleScaling ?? true;
    const isReadonly = props.isReadonly ?? false;
    const releaseChannel = props.releaseChannel ?? "default";
    const endpoints = props.endpoints ?? [{ protocol: "mysql", enabled: true }];
    const stateTarget = props.stateTarget ?? "start";
    const ipAccessList = props.ipAccessList ?? [
      {
        description: "Anywhere",
        source: "0.0.0.0/0",
      },
    ];
    const minReplicaMemoryGb = props.minReplicaMemoryGb ?? 8;
    const maxReplicaMemoryGb = props.maxReplicaMemoryGb ?? 356;
    const numReplicas = props.numReplicas ?? 3;
    const idleTimeoutMinutes = props.idleTimeoutMinutes ?? 15;

    const name =
      props.name ?? this.output?.name ?? this.scope.createPhysicalName(id);

    const organizationId =
      typeof props.organization === "string"
        ? props.organization
        : props.organization.id;

    if (this.phase === "delete") {
      await api.v1
        .organizations(organizationId)
        .services(this.output.clickhouseId)
        .state.patch({
          command: "stop",
        });

      await waitForServiceState(
        api,
        organizationId,
        this.output.clickhouseId,
        (state) => state === "stopped",
        10 * 60,
      );

      await api.v1
        .organizations(organizationId)
        .services(this.output.clickhouseId)
        .delete();

      return this.destroy();
    }
    if (this.phase === "update") {
      //todo(pr): check endpoint differences?
      const resourceDiff = diff(
        {
          ...props,
          idleScaling,
          isReadonly,
          releaseChannel,
          endpoints,
          name,
        },
        { ...this.output, endpoints, organization: props.organization },
      );

      const updates: Partial<Service> = {};

      if (
        resourceDiff.some(
          (prop) =>
            prop !== "name" &&
            prop !== "ipAccessList" &&
            prop !== "releaseChannel" &&
            prop !== "minReplicaMemoryGb" &&
            prop !== "maxReplicaMemoryGb" &&
            prop !== "numReplicas" &&
            prop !== "idleScaling" &&
            prop !== "idleTimeoutMinutes" &&
            prop !== "stateTarget",
        )
      ) {
        return this.replace();
      }

      if (
        //todo(pr): check encryption key swap?
        resourceDiff.some(
          (prop) =>
            prop === "name" ||
            prop === "ipAccessList" ||
            prop === "releaseChannel",
        )
      ) {
        const response = await api.v1
          .organizations(organizationId)
          .services(this.output.clickhouseId)
          .patch({
            name,
            ipAccessList: props.ipAccessList,
            releaseChannel,
          });

        updates.name = response.name;
        updates.ipAccessList = response.ipAccessList;
        updates.releaseChannel = response.releaseChannel;
      }

      if (stateTarget !== this.output.stateTarget) {
        const response = await api.v1
          .organizations(organizationId)
          .services(this.output.clickhouseId)
          .state.patch({
            command: stateTarget,
          });

        updates.state = response.state;
        updates.stateTarget = stateTarget;
      }

      if (
        resourceDiff.some(
          (prop) =>
            prop === "minReplicaMemoryGb" ||
            prop === "maxReplicaMemoryGb" ||
            prop === "numReplicas" ||
            prop === "idleScaling" ||
            prop === "idleTimeoutMinutes",
        )
      ) {
        const response = await api.v1
          .organizations(organizationId)
          .services(this.output.clickhouseId)
          .replicaScaling.patch({
            minReplicaMemoryGb: props.minReplicaMemoryGb,
            maxReplicaMemoryGb: props.maxReplicaMemoryGb,
            numReplicas: props.numReplicas,
            idleScaling: props.idleScaling,
            idleTimeoutMinutes: idleTimeoutMinutes,
          });

        updates.minReplicaMemoryGb = response.minReplicaMemoryGb;
        updates.maxReplicaMemoryGb = response.maxReplicaMemoryGb;
        updates.numReplicas = response.numReplicas;
        updates.idleScaling = response.idleScaling;
        updates.idleTimeoutMinutes = response.idleTimeoutMinutes;
      }

      return this({
        ...this.output,
        ...updates,
      });
    }

    const service = await api.v1.organizations(organizationId).services.post({
      name,
      provider: props.provider,
      region: props.region,
      ipAccessList: ipAccessList,
      minReplicaMemoryGb: minReplicaMemoryGb,
      maxReplicaMemoryGb: maxReplicaMemoryGb,
      numReplicas: numReplicas,
      idleScaling: idleScaling,
      idleTimeoutMinutes: idleTimeoutMinutes,
      isReadonly: isReadonly,
      dataWarehouseId: props.dataWarehouseId,
      backupId: props.backupId,
      encryptionKey: props.encryptionKey,
      encryptionAssumedRoleIdentifier: props.encryptionAssumedRoleIdentifier,
      privatePreviewTermsChecked: true,
      releaseChannel: releaseChannel,
      byocId: props.byocId,
      hasTransparentDataEncryption: props.hasTransparentDataEncryption ?? false,
      endpoints: endpoints,
      profile: props.profile,
      complianceType: props.complianceType,
    });

    return this({
      organizationId: organizationId,
      name: service.service.name,
      clickhouseId: service.service.id,
      password: secret(service.password),
      provider: service.service.provider,
      region: service.service.region,
      ipAccessList: service.service.ipAccessList,
      minReplicaMemoryGb: service.service.minReplicaMemoryGb,
      maxReplicaMemoryGb: service.service.maxReplicaMemoryGb,
      numReplicas: service.service.numReplicas,
      idleScaling: service.service.idleScaling,
      idleTimeoutMinutes: service.service.idleTimeoutMinutes,
      isReadonly: service.service.isReadonly,
      dataWarehouseId: service.service.dataWarehouseId,
      backupId: props.backupId,
      encryptionKey: service.service.encryptionKey,
      encryptionAssumedRoleIdentifier:
        service.service.encryptionAssumedRoleIdentifier,
      releaseChannel: service.service.releaseChannel,
      byocId: service.service.byocId,
      hasTransparentDataEncryption:
        service.service.hasTransparentDataEncryption,
      endpoints: service.service.endpoints,
      profile: service.service.profile,
      complianceType: service.service.complianceType,
      stateTarget,
      state: service.service.state,
    });
  },
);

//todo(pr): are we okay with this? it feels extremely stupid but its what the clickhouse tf provider does
async function waitForServiceState(
  api: any,
  organizationId: string,
  serviceId: string,
  stateChecker: (state: string) => boolean,
  maxWaitSeconds: number,
) {
  const checkState = async (): Promise<void> => {
    const service = await api.v1
      .organizations(organizationId)
      .services(serviceId)
      .get();

    if (stateChecker(service.state)) {
      return;
    }

    throw new Error(`Service ${serviceId} is in state ${service.state}`);
  };

  if (maxWaitSeconds < 5) {
    maxWaitSeconds = 5;
  }

  const maxRetries = Math.floor(maxWaitSeconds / 5);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await checkState();
      return;
    } catch (error) {
      if (attempt === maxRetries - 1) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}
