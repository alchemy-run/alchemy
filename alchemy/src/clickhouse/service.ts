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
  keyId?: string | Secret<string>;
  secret?: string | Secret<string>;
  organization: string | Organization;
  name?: string;
  provider: ApiService["provider"];
  region: ApiService["region"];
  ipAccessList?: ApiService["ipAccessList"];
  //todo(pr): sane size/replica defaults?
  minReplicaMemoryGb: ApiService["minReplicaMemoryGb"];
  maxReplicaMemoryGb: ApiService["maxReplicaMemoryGb"];
  numReplicas: ApiService["numReplicas"];
  idleScaling?: ApiService["idleScaling"];
  idleTimeoutMinutes?: ApiService["idleTimeoutMinutes"];
  isReadonly?: ApiService["isReadonly"];
  dataWarehouseId?: ApiService["dataWarehouseId"];
  backupId?: string;
  encryptionKey?: ApiService["encryptionKey"];
  encryptionAssumedRoleIdentifier?: ApiService["encryptionAssumedRoleIdentifier"];
  releaseChannel?: ApiService["releaseChannel"];
  //todo(pr): support linking to BYOC infrastructure directly
  byocId?: ApiService["byocId"];
  hasTransparentDataEncryption?: ApiService["hasTransparentDataEncryption"];
  //todo(pr): can this be any of the protocol types?
  endpoints?: Array<{
    protocol: "mysql";
    enabled: boolean;
  }>;
  profile?: ApiService["profile"];
  complianceType?: ApiService["complianceType"];
  stateTarget?: "start" | "stop";
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

    const name =
      props.name ?? this.output?.name ?? this.scope.createPhysicalName(id);

    const organizationId =
      typeof props.organization === "string"
        ? props.organization
        : props.organization.id;

    if (this.phase === "delete") {
      //todo(pr): `Only instance in one of the following states: 'provisioning','starting','awaking','idle','stopped','degraded','failed' can be terminated`
      //todo(pr): this means we need to request it stops, wait, THEN delete.
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
            idleTimeoutMinutes: props.idleTimeoutMinutes,
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
      ipAccessList: props.ipAccessList ?? [
        {
          description: "Anywhere",
          source: "0.0.0.0/0",
        },
      ],
      minReplicaMemoryGb: props.minReplicaMemoryGb,
      maxReplicaMemoryGb: props.maxReplicaMemoryGb,
      numReplicas: props.numReplicas,
      idleScaling: idleScaling,
      idleTimeoutMinutes: props.idleTimeoutMinutes,
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
