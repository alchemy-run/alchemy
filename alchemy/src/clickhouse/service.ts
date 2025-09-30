import type { Context } from "../context.ts";
import { Resource } from "../resource.ts";
import { secret, type Secret } from "../secret.ts";
import { diff } from "../util/diff.ts";
import { createClickhouseApi } from "./api.ts";
import type { ClickhouseClient } from "./api/sdk.gen.ts";
import type { Service as ApiService, Organization } from "./api/types.gen.ts";

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

  /**
   * Whether to enable the mysql endpoint.
   *
   * @default true
   */
  enableMysqlEndpoint?: boolean;

  /**
   * Whether to enable the https endpoint. Cannot be disabled
   *
   * @default true
   */
  enableHttpsEndpoint?: true;

  /**
   * Whether to enable the nativesecure endpoint. Cannot be disabled
   *
   * @default true
   */
  enableNativesecureEndpoint?: true;

  /**
   * The compliance type to create the service with.
   */
  complianceType?: ApiService["complianceType"];

  //todo(michael): I need to understand more about what these properties do before documenting
  //todo(michael): support linking to BYOC infrastructure directly
  byocId?: ApiService["byocId"];
  hasTransparentDataEncryption?: ApiService["hasTransparentDataEncryption"];
  profile?: ApiService["profile"];
  dataWarehouseId?: ApiService["dataWarehouseId"];
  backupId?: string;
  encryptionKey?: ApiService["encryptionKey"];
  encryptionAssumedRoleIdentifier?: ApiService["encryptionAssumedRoleIdentifier"];
}

export interface Service {
  organizationId: string;
  name: string;
  clickhouseId: string;
  password: Secret<string>;
  provider: NonNullable<ApiService["provider"]>;
  region: NonNullable<ApiService["region"]>;
  ipAccessList: NonNullable<ApiService["ipAccessList"]>;
  minReplicaMemoryGb: NonNullable<ApiService["minReplicaMemoryGb"]>;
  maxReplicaMemoryGb: NonNullable<ApiService["maxReplicaMemoryGb"]>;
  numReplicas: NonNullable<ApiService["numReplicas"]>;
  idleScaling: NonNullable<ApiService["idleScaling"]>;
  idleTimeoutMinutes: NonNullable<ApiService["idleTimeoutMinutes"]>;
  isReadonly: NonNullable<ApiService["isReadonly"]>;
  dataWarehouseId: NonNullable<ApiService["dataWarehouseId"]>;
  encryptionKey?: ApiService["encryptionKey"];
  encryptionAssumedRoleIdentifier?: ApiService["encryptionAssumedRoleIdentifier"];
  releaseChannel: NonNullable<ApiService["releaseChannel"]>;
  byocId?: ApiService["byocId"];
  hasTransparentDataEncryption?: ApiService["hasTransparentDataEncryption"];
  profile?: ApiService["profile"];
  complianceType?: ApiService["complianceType"];
  backupId?: string;
  enableMysqlEndpoint?: boolean;
  enableHttpsEndpoint?: true;
  enableNativesecureEndpoint?: true;
  mysqlEndpoint?: {
    protocol: "mysql";
    host: string;
    port: number;
    username: string;
  };
  httpsEndpoint?: {
    protocol: "https";
    host: string;
    port: number;
  };
  nativesecureEndpoint?: {
    protocol: "nativesecure";
    host: string;
    port: number;
  };
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
    const endpoints: Array<{ protocol: "mysql"; enabled: boolean }> = [];
    const enableMysqlEndpoint = props.enableMysqlEndpoint ?? true;
    if (enableMysqlEndpoint) {
      endpoints.push({ protocol: "mysql", enabled: true });
    }
    //todo(michael): comment these in when disabling is supported
    // const enableHttpsEndpoint = props.enableHttpsEndpoint ?? true;
    // if (enableHttpsEndpoint) {
    // 	endpoints.push({ protocol: "https", enabled: true });
    // }
    // const enableNativesecureEndpoint = props.enableNativesecureEndpoint ?? true;
    // if (enableNativesecureEndpoint) {
    // 	endpoints.push({ protocol: "nativesecure", enabled: true });
    // }
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
        : props.organization.id!;

    if (this.phase === "delete") {
      await api.updateServiceState({
        path: {
          organizationId: organizationId,
          serviceId: this.output.clickhouseId,
        },
        body: {
          command: "stop",
        },
      });

      await waitForServiceState(
        api,
        organizationId,
        this.output.clickhouseId,
        (state) => state === "stopped",
        10 * 60,
      );

      // await api.v1
      //   .organizations(organizationId)
      //   .services(this.output.clickhouseId)
      //   .delete();

      await api.deleteService({
        path: {
          organizationId: organizationId,
          serviceId: this.output.clickhouseId,
        },
      });

      return this.destroy();
    }
    if (this.phase === "update") {
      const resourceDiff = diff(
        {
          ...props,
          idleScaling,
          isReadonly,
          releaseChannel,
          name,
        },
        {
          ...this.output,
          organization: props.organization,
        },
      );

      const updates: Partial<Service> = {};
      console.log(resourceDiff);

      if (
        resourceDiff.some(
          (prop) =>
            prop !== "name" &&
            prop !== "ipAccessList" &&
            prop !== "releaseChannel" &&
            prop !== "enableMysqlEndpoint" &&
            prop !== "enableHttpsEndpoint" &&
            prop !== "enableNativesecureEndpoint" &&
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
        //todo(michael): check encryption key swap?
        resourceDiff.some(
          (prop) =>
            prop === "name" ||
            prop === "ipAccessList" ||
            prop === "releaseChannel",
        ) ||
        enableMysqlEndpoint !== this.output.enableMysqlEndpoint
      ) {
        const ipAccessListToRemove = this.output.ipAccessList.filter(
          (ipAccessList) => !props.ipAccessList?.includes(ipAccessList),
        );
        const ipAccessListToAdd = props.ipAccessList?.filter(
          (ipAccessList) => !this.output.ipAccessList.includes(ipAccessList),
        );
        const response = (
          await api.updateServiceBasicDetails({
            path: {
              organizationId: organizationId,
              serviceId: this.output.clickhouseId,
            },
            body: {
              name,
              ipAccessList: {
                remove: ipAccessListToRemove,
                add: ipAccessListToAdd,
              },
              releaseChannel,
              endpoints,
            },
          })
        ).data.result!;

        updates.name = response.name!;
        updates.ipAccessList = response.ipAccessList!;
        updates.releaseChannel = response.releaseChannel!;
        updates.mysqlEndpoint = response!.endpoints!.find(
          (endpoint) => endpoint.protocol === "mysql",
        ) as any;
        updates.httpsEndpoint = response!.endpoints!.find(
          (endpoint) => endpoint.protocol === "https",
        ) as any;
        updates.nativesecureEndpoint = response!.endpoints!.find(
          (endpoint) => endpoint.protocol === "nativesecure",
        ) as any;
      }

      if (stateTarget !== this.output.stateTarget) {
        const response = await api.updateServiceState({
          path: {
            organizationId: organizationId,
            serviceId: this.output.clickhouseId,
          },
          body: {
            command: stateTarget,
          },
        });

        updates.state = response.data.result!.state!;
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
        const response = (
          await api.updateServiceAutoScalingSettings2({
            path: {
              organizationId: organizationId,
              serviceId: this.output.clickhouseId,
            },
            body: {
              minReplicaMemoryGb: props.minReplicaMemoryGb,
              maxReplicaMemoryGb: props.maxReplicaMemoryGb,
              numReplicas: props.numReplicas,
              idleScaling: props.idleScaling,
              idleTimeoutMinutes: idleTimeoutMinutes,
            },
          })
        ).data.result!;

        updates.minReplicaMemoryGb = response.minReplicaMemoryGb!;
        updates.maxReplicaMemoryGb = response.maxReplicaMemoryGb!;
        updates.numReplicas = response.numReplicas!;
        updates.idleScaling = response.idleScaling!;
        updates.idleTimeoutMinutes = response.idleTimeoutMinutes!;
      }

      return {
        ...this.output,
        ...updates,
      };
    }

    const response = (
      await api.createNewService({
        path: {
          organizationId: organizationId,
        },
        body: {
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
          encryptionAssumedRoleIdentifier:
            props.encryptionAssumedRoleIdentifier,
          privatePreviewTermsChecked: true,
          releaseChannel: releaseChannel,
          byocId: props.byocId,
          hasTransparentDataEncryption:
            props.hasTransparentDataEncryption ?? false,
          endpoints: endpoints,
          profile: props.profile,
          complianceType: props.complianceType,
        },
      })
    ).data.result!;
    const password = response.password!;
    const service = response.service!;

    return {
      organizationId: organizationId,
      name: service.name!,
      clickhouseId: service.id!,
      password: secret(password!),
      provider: service.provider!,
      region: service.region!,
      ipAccessList: service.ipAccessList!,
      minReplicaMemoryGb: service.minReplicaMemoryGb!,
      maxReplicaMemoryGb: service.maxReplicaMemoryGb!,
      numReplicas: service.numReplicas!,
      idleScaling: service.idleScaling!,
      idleTimeoutMinutes: service.idleTimeoutMinutes!,
      isReadonly: service.isReadonly!,
      dataWarehouseId: service.dataWarehouseId!,
      backupId: props.backupId,
      encryptionKey: service.encryptionKey,
      encryptionAssumedRoleIdentifier: service.encryptionAssumedRoleIdentifier,
      releaseChannel: service.releaseChannel!,
      byocId: service.byocId,
      hasTransparentDataEncryption: service.hasTransparentDataEncryption,
      profile: service.profile,
      complianceType: service.complianceType,
      stateTarget,
      state: service.state,
      mysqlEndpoint: service.endpoints!.find(
        (endpoint) => endpoint.protocol === "mysql",
      ) as any,
      httpsEndpoint: service.endpoints!.find(
        (endpoint) => endpoint.protocol === "https",
      ) as any,
      nativesecureEndpoint: service.endpoints!.find(
        (endpoint) => endpoint.protocol === "nativesecure",
      ) as any,
    };
  },
);

async function waitForServiceState(
  api: ClickhouseClient,
  organizationId: string,
  serviceId: string,
  stateChecker: (state: string) => boolean,
  maxWaitSeconds: number,
) {
  const checkState = async (): Promise<void> => {
    const service = await api.getServiceDetails({
      path: {
        organizationId: organizationId,
        serviceId: serviceId,
      },
    });
    const serviceState = service.data.result!.state!;

    if (stateChecker(serviceState)) {
      return;
    }

    throw new Error(`Service ${serviceId} is in state ${serviceState}`);
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
