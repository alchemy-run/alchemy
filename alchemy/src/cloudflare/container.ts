import type { Context } from "../context.ts";
import { DockerApi } from "../docker/api.ts";
import type { Image } from "../docker/image.ts";
import { Resource } from "../resource.ts";
import {
  type CloudflareApi,
  type CloudflareApiOptions,
  createCloudflareApi,
} from "./api.ts";
// must import this or else alchemy.test won't exist
// import "../../src/test/vitest.ts";

// const test = alchemy.test(import.meta, {
//   prefix: BRANCH_PREFIX,
// });

export class Container {
  public readonly type = "container" as const;
  public readonly className: string;
  public readonly image: Image;
  public readonly maxInstances: number | undefined;
  public readonly name: string | undefined;
  public readonly scriptName: string | undefined;
  public readonly sqlite: boolean | undefined;
  constructor(
    public readonly id: string,
    options: {
      className: string;
      image: Image;
      maxInstances?: number;
      name?: string;
      scriptName?: string;
    },
  ) {
    this.className = options.className;
    this.image = options.image;
    this.maxInstances = options.maxInstances;
    this.name = options.name;
    this.scriptName = options.scriptName;
    this.sqlite = true;
  }
}

export interface ContainerApplicationProps extends CloudflareApiOptions {
  name: string;
  schedulingPolicy?: SchedulingPolicy;
  instances?: number;
  maxInstances?: number;
  image: Image;
  registryId?: string;
  durableObjects?: {
    namespaceId: string;
  };
}

export type SchedulingPolicy =
  | "moon"
  | "gpu"
  | "regional"
  | "fill_metals"
  | "default";

export interface ContainerApplication
  extends Resource<"cloudflare::ContainerApplication"> {
  id: string;
  name: string;
}

export const ContainerApplication = Resource(
  "cloudflare::ContainerApplication",
  async function (
    this: Context<ContainerApplication, ContainerApplicationProps>,
    _id: string,
    props: ContainerApplicationProps,
  ): Promise<ContainerApplication> {
    const api = await createCloudflareApi(props);
    if (this.phase === "delete") {
      if (this.output?.id) {
        // Delete the container application
        await deleteContainerApplication(api, this.output.id);
      }
      return this.destroy();
    } else {
      const { targetImage } = await pushContainerRefToRegistry(api, {
        image: props.image,
        registryId: "registry.cloudflare.com",
      });
      const application = await createContainerApplication(api, {
        name: props.name,
        scheduling_policy: props.schedulingPolicy ?? "default",
        instances: props.instances ?? 1,
        max_instances: props.maxInstances ?? 1,
        durable_objects: props.durableObjects
          ? {
              namespace_id: props.durableObjects.namespaceId,
            }
          : undefined,
        constraints: {
          tier: 1,
        },
        configuration: {
          image: targetImage,
          // TODO(sam): what?
          instance_type: "dev",
          observability: {
            logs: {
              enabled: true,
            },
          },
        },
      });

      return this({
        id: application.id,
        name: application.name,
      });
    }
  },
);

export interface ContainerApplicationData {
  name: string;
  scheduling_policy: string;
  instances: number;
  max_instances: number;
  constraints: {
    tier: number;
    [key: string]: any;
  };
  configuration: {
    image: string;
    location: string;
    vcpu: number;
    memory_mib: number;
    disk: any;
    network: any;
    command: string[];
    entrypoint: string[];
    runtime: string;
    deployment_type: string;
    observability: any;
    memory: string;
    [key: string]: any;
  };
  durable_objects: {
    namespace_id: string;
    [key: string]: any;
  };
  id: string;
  account_id: string;
  created_at: string;
  version: number;
  durable_object_namespace_id: string;
  health: {
    instances: any;
    [key: string]: any;
  };
  [key: string]: any;
}

export async function listContainerApplications(
  api: CloudflareApi,
): Promise<ContainerApplicationData[]> {
  const deployments = await api.get(
    `/accounts/${api.accountId}/containers/applications`,
  );
  const response = (await deployments.json()) as any as {
    result: ContainerApplicationData[];
    errors: { message: string }[];
  };
  if (deployments.ok) {
    return response.result;
  }
  throw Error(
    `Failed to list container applications: ${response.errors.map((e) => e.message).join(", ")}`,
  );
}

export interface CreateContainerApplicationBody {
  name: string;
  max_instances: number;
  configuration: {
    image: string;
    observability?: any;
    instance_type?: string;
  };
  durable_objects?: {
    namespace_id: string;
  };
  instances?: number;
  scheduling_policy?: string;
  constraints?: { tier: number };
  [key: string]: any;
}

export async function createContainerApplication(
  api: CloudflareApi,
  body: CreateContainerApplicationBody,
) {
  const response = await api.post(
    `/accounts/${api.accountId}/containers/applications`,
    body,
  );
  const result = (await response.json()) as any;
  if (response.ok) {
    return result.result;
  }

  throw Error(
    `Failed to create container application: ${result.errors?.map((e: { message: string }) => e.message).join(", ") ?? "Unknown error"}`,
  );
}

export async function deleteContainerApplication(
  api: CloudflareApi,
  applicationId: string,
) {
  console.log("DELETE");
  const response = await api.delete(
    `/accounts/${api.accountId}/containers/applications/${applicationId}`,
  );
  const result = (await response.json()) as any;
  if (response.ok) {
    return result.result;
  }
  throw Error(
    `Failed to delete container application: ${result.errors?.map((e: { message: string }) => e.message).join(", ") ?? "Unknown error"}`,
  );
}

export type ImageRegistryCredentialsConfiguration = {
  permissions: Array<"pull" | "push">;
  expiration_minutes: number;
};

export async function getContainerCredentials(
  api: CloudflareApi,
  registryId = "registry.cloudflare.com",
) {
  const credentials = await api.post(
    `/accounts/${api.accountId}/containers/registries/${registryId}/credentials`,
    {
      permissions: ["pull", "push"],
      expiration_minutes: 60,
    } satisfies ImageRegistryCredentialsConfiguration,
  );
  const result = (await credentials.json()) as any;
  if (credentials.ok) {
    return result.result;
  }
  throw Error(
    `Failed to get container credentials: ${result.errors.map((e: { message: string }) => e.message).join(", ")}`,
  );
}

export async function pushContainerRefToRegistry(
  api: CloudflareApi,
  props: {
    image: Image;
    registryId?: string;
  },
) {
  const registryId = props.registryId || "registry.cloudflare.com";
  const credentials = await getContainerCredentials(api, registryId);

  // Initialize Docker API
  const dockerApi = new DockerApi();

  // Check if Docker is running
  const isRunning = await dockerApi.isRunning();
  if (!isRunning) {
    throw new Error("Docker daemon is not running");
  }

  try {
    // Docker login to Cloudflare registry using the secure login method
    await dockerApi.login(
      registryId,
      credentials.username || credentials.user,
      credentials.password,
    );

    // Get the source image reference
    const sourceImage =
      typeof props.image === "string" ? props.image : props.image.imageRef;

    // Parse image name and tag
    const imageWithoutRegistry = sourceImage.split("/").pop() || sourceImage;
    const [imageName, imageTag] = imageWithoutRegistry.includes(":")
      ? imageWithoutRegistry.split(":")
      : [imageWithoutRegistry, "latest"];

    // Replace "latest" tag with a timestamp-based tag since Cloudflare doesn't allow "latest"
    const targetTag = imageTag === "latest" ? `build-${Date.now()}` : imageTag;

    // Construct the target image name for Cloudflare registry
    // Format: registry.cloudflare.com/account-id/image-name:tag
    const targetImage = getCloudflareRegistryWithAccountNamespace(
      api.accountId,
      `${imageName}:${targetTag}`,
    );

    // Tag the image for Cloudflare registry if needed
    if (sourceImage !== targetImage) {
      await dockerApi.exec(["tag", sourceImage, targetImage]);
    }

    // Push the image to Cloudflare registry
    await dockerApi.exec(["push", targetImage]);

    // Return the pushed image reference
    return {
      sourceImage,
      targetImage,
      registryId,
    };
  } catch (error) {
    throw new Error(
      `Failed to push image to Cloudflare registry: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    // Logout from the registry for security
    await dockerApi.logout(registryId);
  }
}

// The Cloudflare managed registry is special in that the namespaces for repos should always
// start with the Cloudflare Account tag
// This is a helper to generate the image tag with correct namespace attached to the Cloudflare Registry host
export const getCloudflareRegistryWithAccountNamespace = (
  accountID: string,
  tag: string,
): string => {
  return `${getCloudflareContainerRegistry()}/${accountID}/${tag}`;
};

// default cloudflare managed registry, can be overriden with the env var - CLOUDFLARE_CONTAINER_REGISTRY
export const getCloudflareContainerRegistry = () => {
  // previously defaulted to registry.cloudchamber.cfdata.org
  return process.env.CLOUDFLARE_CONTAINER_REGISTRY ?? "registry.cloudflare.com";
};

/**
 * Given a container image that is a registry link, this function
 * returns true if the link points the Cloudflare container registry
 * (defined as per `getCloudflareContainerRegistry` above)
 */
export function isCloudflareRegistryLink(image: string) {
  const cfRegistry = getCloudflareContainerRegistry();
  return image.includes(cfRegistry);
}

/** Prefixes with the cloudflare-dev namespace. The name should be the container's DO classname, and the tag a build uuid. */
export const getDevContainerImageName = (name: string, tag: string) => {
  return `${MF_DEV_CONTAINER_PREFIX}/${name.toLowerCase()}:${tag}`;
};

export const MF_DEV_CONTAINER_PREFIX = "cloudflare-dev";

export interface ContainerIdentity {
  account_id: string;
  external_account_id: string;
  legacy_identity: string;
  capabilities: string[];
  limits: {
    account_id: string;
    vcpu_per_deployment: number;
    memory_mib_per_deployment: number;
    memory_per_deployment: string;
    disk_per_deployment: string;
    disk_mb_per_deployment: number;
    total_vcpu: number;
    total_memory_mib: number;
    node_group: string;
    ipv4s: number;
    network_modes: string[];
    total_disk_mb: number;
    total_memory: string;
  };
  locations: any[];
  defaults: {
    vcpus: number;
    memory_mib: number;
    memory: string;
    disk_mb: number;
  };
}

export async function getContainerIdentity(api: CloudflareApi) {
  const metrics = await api.get(`/accounts/${api.accountId}/containers/me`);
  const result = (await metrics.json()) as {
    result: ContainerIdentity;
    errors: { message: string }[];
  };
  if (metrics.ok) {
    return result.result;
  }
  throw Error(
    `Failed to get container me: ${result.errors.map((e: { message: string }) => e.message).join(", ")}`,
  );
}

// describe("Container Resources", () => {
//   // Use BRANCH_PREFIX for deterministic, non-colliding resource names
//   const testId = `${BRANCH_PREFIX}-test-container`;

//   test("create and delete a simple container deployment", async (scope) => {
//     let deployment: ContainerDeployment | undefined;
//     try {
//       // Create a simple deployment using a public nginx image
//       deployment = await ContainerDeployment(`${testId}-nginx`, {
//         image: "docker.io/nginx:latest",
//         location: "sfo06",
//         instanceType: "dev",
//       });

//       expect(deployment.id).toBeTruthy();
//       expect(deployment.state?.current).toBeTruthy();
//       expect(deployment.name).toEqual(`${testId}-nginx`);

//       // Verify deployment was created by querying the API directly
//       const api = await createCloudflareApi();
//       const getResponse = await api.get(
//         `/containers/deployments/${deployment.id}/v2`,
//       );
//       expect(getResponse.status).toEqual(200);

//       const responseData: any = await getResponse.json();
//       expect(responseData.result.id).toEqual(deployment.id);
//     } catch (err) {
//       // log the error or else it's silently swallowed by destroy errors
//       console.log(err);
//       throw err;
//     } finally {
//       // Always clean up, even if test assertions fail
//       await destroy(scope);

//       if (deployment?.id) {
//         // Verify deployment was deleted
//         const api = await createCloudflareApi();
//         const getDeletedResponse = await api.get(
//           `/containers/deployments/${deployment.id}/v2`,
//         );
//         expect(getDeletedResponse.status).toEqual(404);
//       }
//     }
//   });

//   test("create deployment with environment variables and ports", async (scope) => {
//     let deployment: ContainerDeployment | undefined;
//     try {
//       // Create a deployment with more configuration
//       deployment = await ContainerDeployment(`${testId}-httpd`, {
//         image: "docker.io/httpd:2.4",
//         location: "sfo06",
//         instanceType: "dev",
//         environmentVariables: [
//           { name: "SERVER_NAME", value: "test.example.com" },
//           { name: "SERVER_ADMIN", value: "admin@example.com" },
//         ],
//         ports: [
//           {
//             name: "http",
//             port: 80,
//           },
//         ],
//       });

//       expect(deployment.id).toBeTruthy();
//       expect(deployment.environmentVariables).toHaveLength(2);
//       expect(deployment.ports).toHaveLength(1);
//       expect(deployment.ports?.[0].name).toEqual("http");
//     } catch (err) {
//       console.log(err);
//       throw err;
//     } finally {
//       await destroy(scope);
//     }
//   });
// });
