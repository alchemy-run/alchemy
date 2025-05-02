import type { Context } from "../../context";
import { registerDeletionHandler, Resource } from "../../resource";
import { createCloudControlClient } from "./client";

/**
 * Properties for creating or updating a Cloud Control resource
 */
export interface CloudControlResourceProps {
  /**
   * The type name of the resource (e.g. AWS::S3::Bucket)
   */
  typeName: string;

  /**
   * The desired state of the resource
   */
  desiredState: Record<string, any>;

  /**
   * Optional AWS region
   * @default AWS_REGION environment variable
   */
  region?: string;

  /**
   * AWS access key ID (overrides environment variable)
   */
  accessKeyId?: string;

  /**
   * AWS secret access key (overrides environment variable)
   */
  secretAccessKey?: string;

  /**
   * AWS session token for temporary credentials
   */
  sessionToken?: string;
}

/**
 * Output returned after Cloud Control resource creation/update
 */
export interface CloudControlResource
  extends Resource<"aws::CloudControlResource">,
    CloudControlResourceProps {
  /**
   * The identifier of the resource
   */
  id: string;

  /**
   * Time at which the resource was created
   */
  createdAt: number;
}

// Register wildcard deletion handler for AWS::* pattern
registerDeletionHandler(
  "AWS::",
  async function (this: Context<any>, pattern: string) {
    const client = createCloudControlClient();

    // Extract service name from pattern (e.g. "AWS::S3::*" -> "S3")
    const serviceName = pattern.split("::")[1];

    try {
      // List all resources of the service type
      const resources = await client.listResources(`AWS::${serviceName}::*`);

      // Delete each resource
      for (const resource of resources.resources) {
        try {
          await client.deleteResource(
            `AWS::${serviceName}::*`,
            resource.identifier
          );
        } catch (error) {
          console.error(
            `Error deleting resource ${resource.identifier}:`,
            error
          );
        }
      }
    } catch (error) {
      console.error(
        `Error listing resources for service ${serviceName}:`,
        error
      );
    }
  }
);

/**
 * AWS Cloud Control Resource
 *
 * Creates and manages AWS resources using the Cloud Control API.
 *
 * @example
 * // Create an S3 bucket
 * const bucket = await CloudControlResource("my-bucket", {
 *   typeName: "AWS::S3::Bucket",
 *   desiredState: {
 *     BucketName: "my-unique-bucket-name",
 *     VersioningConfiguration: {
 *       Status: "Enabled"
 *     }
 *   }
 * });
 *
 * @example
 * // Create a DynamoDB table
 * const table = await CloudControlResource("users-table", {
 *   typeName: "AWS::DynamoDB::Table",
 *   desiredState: {
 *     TableName: "users",
 *     AttributeDefinitions: [
 *       {
 *         AttributeName: "id",
 *         AttributeType: "S"
 *       }
 *     ],
 *     KeySchema: [
 *       {
 *         AttributeName: "id",
 *         KeyType: "HASH"
 *       }
 *     ],
 *     ProvisionedThroughput: {
 *       ReadCapacityUnits: 5,
 *       WriteCapacityUnits: 5
 *     }
 *   }
 * });
 */
export const CloudControlResource = Resource(
  "aws::CloudControlResource",
  async function (
    this: Context<CloudControlResource>,
    id: string,
    props: CloudControlResourceProps
  ): Promise<CloudControlResource> {
    const client = createCloudControlClient({
      region: props.region,
      accessKeyId: props.accessKeyId,
      secretAccessKey: props.secretAccessKey,
      sessionToken: props.sessionToken,
    });

    if (this.phase === "delete") {
      if (this.output?.id) {
        try {
          await client.deleteResource(props.typeName, this.output.id);
        } catch (error) {
          // Log but don't throw on cleanup errors
          console.error(`Error deleting resource ${id}:`, error);
        }
      }
      return this.destroy();
    }

    let response;
    if (this.phase === "update" && this.output?.id) {
      // Update existing resource
      response = await client.updateResource(
        props.typeName,
        this.output.id,
        props.desiredState
      );
    } else {
      // Create new resource
      response = await client.createResource(
        props.typeName,
        props.desiredState
      );
    }

    if (response.status === "FAILED") {
      throw new Error(
        `Failed to ${this.phase} resource ${id}: ${response.message}`
      );
    }

    return this({
      ...props,
      id: response.identifier!,
      createdAt: Date.now(),
    });
  }
);
