import type { Context } from "../context.ts";
import { DockerApi } from "../docker/api.ts";
import { Image, type ImageProps } from "../docker/image.ts";
import { Resource } from "../resource.ts";
import {
  type CloudflareApi,
  type CloudflareApiOptions,
  createCloudflareApi,
} from "./api.ts";

export interface ContainerProps extends ImageProps {
  className: string;
  maxInstances?: number;
  scriptName?: string;
}

export type Container<T = any> = {
  type: "container";
  id: string;
  name?: string;
  className: string;
  image: Image;
  maxInstances?: number;
  scriptName?: string;
  sqlite?: true;

  /**
   * @internal
   */
  __phantom?: T;
};

export async function Container<T>(
  id: string,
  props: ContainerProps,
): Promise<Container<T>> {
  return {
    type: "container",
    id,
    name: props.name ?? id,
    className: props.className,
    image: await Image(id, props),
    maxInstances: props.maxInstances,
    scriptName: props.scriptName,
    sqlite: true,
  };
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

/**
 * Deploy and manage container applications on Cloudflare's global network.
 *
 * ContainerApplication creates a managed container deployment that runs your Docker images
 * with automatic scaling, scheduling, and integration with Cloudflare's services.
 *
 * @example
 * // Deploy a simple web application container
 * const webApp = await ContainerApplication("my-web-app", {
 *   name: "my-web-app",
 *   image: await Image("web-app", {
 *     name: "web-app",
 *     build: {
 *       context: "./docker/web-app"
 *     }
 *   }),
 *   instances: 1,
 *   maxInstances: 3
 * });
 *
 * @example
 * // Deploy a container with GPU support for AI workloads
 * const aiApp = await ContainerApplication("ai-inference", {
 *   name: "ai-inference",
 *   image: await Image("ai-model", {
 *     name: "ai-model",
 *     build: {
 *       context: "./docker/ai"
 *     }
 *   }),
 *   schedulingPolicy: "gpu",
 *   instances: 2,
 *   maxInstances: 5
 * });
 *
 * @example
 * // Deploy a container integrated with Durable Objects
 * const doApp = await ContainerApplication("stateful-app", {
 *   name: "stateful-app",
 *   image: await Image("do-app", {
 *     name: "do-app",
 *     build: {
 *       context: "./container"
 *     }
 *   }),
 *   durableObjects: {
 *     namespaceId: myDurableObjectNamespace.id
 *   },
 *   instances: 1,
 *   maxInstances: 10
 * });
 *
 * @example
 * // Create a Container binding for use in a Worker
 * const worker = await Worker("my-worker", {
 *   name: "my-worker",
 *   entrypoint: "./src/worker.ts",
 *   bindings: {
 *     MY_CONTAINER: new Container("my-container", {
 *       className: "MyContainerClass",
 *       image: await Image("container-do", {
 *         name: "container-do",
 *         context: "./docker/durable-object"
 *       }),
 *       maxInstances: 100,
 *       name: "my-container-do"
 *     })
 *   }
 * });
 */
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
