import type { Context } from "../context.js";
import { Resource } from "../resource.js";
import { DockerApi } from "./api.js";

/**
 * Interface for volume label
 */
export interface VolumeLabel {
  /**
   * Label name
   */
  name: string;

  /**
   * Label value
   */
  value: string;
}

/**
 * Properties for creating a Docker volume
 */
export interface DockerVolumeProps {
  /**
   * Volume name
   */
  name: string;

  /**
   * Volume driver to use
   * @default "local"
   */
  driver?: string;

  /**
   * Driver-specific options
   */
  driverOpts?: Record<string, string>;

  /**
   * Custom metadata labels for the volume
   */
  labels?: VolumeLabel[] | Record<string, string>;
}

/**
 * Docker Volume resource
 */
export interface DockerVolume
  extends Resource<"docker::Volume">,
    DockerVolumeProps {
  /**
   * Volume ID (same as name for Docker volumes)
   */
  id: string;

  /**
   * Volume mountpoint path on the host
   */
  mountpoint?: string;

  /**
   * Time when the volume was created
   */
  createdAt: number;
}

/**
 * Create and manage a Docker Volume
 *
 * @see https://docs.docker.com/engine/reference/commandline/volume/
 *
 * @example
 * // Create a simple Docker volume
 * const dataVolume = await DockerVolume("data-volume", {
 *   name: "data-volume"
 * });
 *
 * @example
 * // Create a Docker volume with custom driver and options
 * const dbVolume = await DockerVolume("db-data", {
 *   name: "db-data",
 *   driver: "local",
 *   driverOpts: {
 *     "type": "nfs",
 *     "o": "addr=10.0.0.1,rw",
 *     "device": ":/path/to/dir"
 *   },
 *   labels: [
 *     { name: "com.example.usage", value: "database-storage" },
 *     { name: "com.example.backup", value: "weekly" }
 *   ]
 * });
 */
export const DockerVolume = Resource(
  "docker::Volume",
  async function (
    this: Context<DockerVolume>,
    id: string,
    props: DockerVolumeProps,
  ): Promise<DockerVolume> {
    // Initialize Docker API client
    const api = new DockerApi();

    // Check if Docker daemon is running
    const isRunning = await api.isRunning();
    if (!isRunning) {
      console.warn(
        "⚠️ Docker daemon is not running. Creating a mock volume resource.",
      );
      // Return a mock volume resource
      return this({
        ...props,
        id: `mock-${props.name}-${Date.now()}`,
        createdAt: Date.now(),
      });
    }

    // Process labels to ensure consistent format
    const processedLabels: Record<string, string> = {};
    if (props.labels) {
      if (Array.isArray(props.labels)) {
        // Convert array of label objects to Record
        for (const label of props.labels) {
          processedLabels[label.name] = label.value;
        }
      } else {
        // Use Record directly
        Object.assign(processedLabels, props.labels);
      }
    }

    // Handle delete phase
    if (this.phase === "delete") {
      try {
        if (this.output?.name) {
          // Remove volume
          await api.removeVolume(this.output.name);
        }
      } catch (error) {
        console.error("Error deleting volume:", error);
      }

      // Return destroyed state
      return this.destroy();
    } else {
      try {
        // Set default driver if not provided
        props.driver = props.driver || "local";
        const driverOpts = props.driverOpts || {};

        // Create the volume
        const volumeName = await api.createVolume(
          props.name,
          props.driver,
          driverOpts,
          processedLabels,
        );

        // Get volume details to retrieve mountpoint
        let mountpoint: string | undefined;
        try {
          const volumeInfo = await api.inspectVolume(volumeName);
          const volumeData = JSON.parse(volumeInfo);
          if (Array.isArray(volumeData) && volumeData.length > 0) {
            mountpoint = volumeData[0].Mountpoint;
          }
        } catch (error) {
          console.warn("Could not get volume mountpoint:", error);
        }

        // Return the resource using this() to construct output
        return this({
          ...props,
          id: volumeName,
          mountpoint,
          createdAt: Date.now(),
          labels: Array.isArray(props.labels) ? props.labels : undefined,
          driverOpts: props.driverOpts,
        });
      } catch (error) {
        console.error("Error creating volume:", error);
        throw error;
      }
    }
  },
);
