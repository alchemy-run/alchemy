import {
  Architecture,
  CreateFunctionCommand,
  DeleteFunctionCommand,
  GetFunctionCommand,
  GetFunctionConfigurationCommand,
  LambdaClient,
  ResourceNotFoundException,
  Runtime,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
} from "@aws-sdk/client-lambda";
import fs from "node:fs";
import path from "node:path";
import type { Context } from "../context";
import { Resource } from "../resource";
import { ignore } from "../util/ignore";

async function resolveRegion(client: LambdaClient): Promise<string> {
  const region = client.config.region;
  if (typeof region === "string") return region;
  if (typeof region === "function") return region();
  throw new Error("Could not resolve AWS region");
}

export interface FunctionProps {
  functionName: string;
  zipPath: string;
  roleArn: string;
  handler?: string;
  runtime?: Runtime;
  architecture?: Architecture;
  description?: string;
  timeout?: number;
  memorySize?: number;
  environment?: Record<string, string>;
  tags?: Record<string, string>;
  url?: {
    authType?: "AWS_IAM" | "NONE";
    cors?: {
      allowCredentials?: boolean;
      allowHeaders?: string[];
      allowMethods?: string[];
      allowOrigins?: string[];
      exposeHeaders?: string[];
      maxAge?: number;
    };
  };
}

export interface Function extends Resource<"lambda::Function">, FunctionProps {
  arn: string;
  lastModified: string;
  version: string;
  qualifiedArn: string; // ARN with version
  invokeArn: string; // ARN for API Gateway
  sourceCodeHash: string;
  sourceCodeSize: number;
  ephemeralStorageSize?: number;
  architectures: string[];
  masterArn?: string; // Only for Lambda@Edge
  revisionId: string;
  state?: string;
  stateReason?: string;
  stateReasonCode?: string;
  lastUpdateStatus?: string;
  lastUpdateStatusReason?: string;
  lastUpdateStatusReasonCode?: string;
  packageType: string;
  signingProfileVersionArn?: string;
  signingJobArn?: string;
}

export const Function = Resource(
  "lambda::Function",
  async function (this: Context<Function>, id: string, props: FunctionProps) {
    const client = new LambdaClient({});
    const region = await resolveRegion(client);

    const code = await zipCode(props.zipPath);

    if (this.phase === "delete") {
      await ignore(ResourceNotFoundException.name, () =>
        client.send(
          new DeleteFunctionCommand({
            FunctionName: props.functionName,
          }),
        ),
      );

      return this.destroy();
    } else {
      try {
        // Check if function exists
        await client.send(
          new GetFunctionCommand({
            FunctionName: props.functionName,
          }),
        );

        if (this.phase === "update") {
          // Wait for function to stabilize
          await waitForFunctionStabilization(client, props.functionName);

          // Update function code
          await client.send(
            new UpdateFunctionCodeCommand({
              FunctionName: props.functionName,
              ZipFile: code,
            }),
          );

          // Wait for code update to stabilize
          await waitForFunctionStabilization(client, props.functionName);

          // Update function configuration
          await client.send(
            new UpdateFunctionConfigurationCommand({
              FunctionName: props.functionName,
              Handler: props.handler,
              Runtime: props.runtime,
              Role: props.roleArn,
              Description: props.description,
              Timeout: props.timeout,
              MemorySize: props.memorySize,
              Environment: props.environment
                ? { Variables: props.environment }
                : undefined,
            }),
          );

          // Wait for configuration update to stabilize
          await waitForFunctionStabilization(client, props.functionName);
        }
      } catch (error: any) {
        if (error.name === "ResourceNotFoundException") {
          // Create function if it doesn't exist
          const startTime = Date.now();
          let delay = 100; // Start with 100ms delay

          while (true) {
            try {
              await client.send(
                new CreateFunctionCommand({
                  FunctionName: props.functionName,
                  Code: { ZipFile: code },
                  Handler: props.handler || "index.handler",
                  Runtime: props.runtime || Runtime.nodejs20x,
                  Role: props.roleArn,
                  Description: props.description,
                  Timeout: props.timeout || 3,
                  MemorySize: props.memorySize || 128,
                  Environment: props.environment
                    ? { Variables: props.environment }
                    : undefined,
                  Architectures: props.architecture
                    ? [props.architecture]
                    : [Architecture.x86_64],
                  Tags: props.tags,
                }),
              );
              break; // Success - exit retry loop
            } catch (createError: any) {
              if (
                createError.name !== "InvalidParameterValueException" ||
                !createError.message?.includes("cannot be assumed by Lambda")
              ) {
                throw createError; // Different error - rethrow
              }

              if (Date.now() - startTime > 10000) {
                throw new Error(
                  "Timeout waiting for IAM role to be assumable by Lambda after 10s",
                );
              }

              await new Promise((resolve) => setTimeout(resolve, delay));
              delay = Math.min(delay * 2, 1000); // Exponential backoff capped at 1s
            }
          }

          // Wait for function to be active
          let isCreating = true;
          while (isCreating) {
            const config = await client.send(
              new GetFunctionConfigurationCommand({
                FunctionName: props.functionName,
              }),
            );
            isCreating = config.State === "Pending";
            if (isCreating) {
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
          }
        } else {
          throw error;
        }
      }

      // Get complete function details
      const [func, config] = await Promise.all([
        client.send(
          new GetFunctionCommand({
            FunctionName: props.functionName,
          }),
        ),
        client.send(
          new GetFunctionConfigurationCommand({
            FunctionName: props.functionName,
          }),
        ),
      ]);

      return this({
        ...props,
        arn: config.FunctionArn!,
        lastModified: config.LastModified!,
        version: config.Version!,
        qualifiedArn: `${config.FunctionArn}:${config.Version}`,
        invokeArn: `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${config.FunctionArn}/invocations`,
        sourceCodeHash: config.CodeSha256!,
        sourceCodeSize: config.CodeSize!,
        ephemeralStorageSize: config.EphemeralStorage?.Size,
        architectures: config.Architectures || [],
        masterArn: config.MasterArn,
        revisionId: config.RevisionId!,
        state: config.State,
        stateReason: config.StateReason,
        stateReasonCode: config.StateReasonCode,
        lastUpdateStatus: config.LastUpdateStatus,
        lastUpdateStatusReason: config.LastUpdateStatusReason,
        lastUpdateStatusReasonCode: config.LastUpdateStatusReasonCode,
        packageType: config.PackageType!,
        signingProfileVersionArn: config.SigningProfileVersionArn,
        signingJobArn: config.SigningJobArn,
      });
    }
  },
);

// Helper to wait for function to stabilize
async function waitForFunctionStabilization(
  client: LambdaClient,
  functionName: string,
) {
  while (true) {
    const config = await client.send(
      new GetFunctionConfigurationCommand({
        FunctionName: functionName,
      }),
    );

    // Check if function is in a stable state
    if (config.State === "Active" && config.LastUpdateStatus === "Successful") {
      break;
    }

    // If there's a failure, throw an error
    if (config.State === "Failed" || config.LastUpdateStatus === "Failed") {
      throw new Error(
        `Function failed to stabilize: ${config.StateReason || config.LastUpdateStatusReason}`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

// Helper to zip the code
async function zipCode(filePath: string): Promise<Buffer> {
  const fileContent = await fs.promises.readFile(filePath);
  const fileName = path.basename(filePath);

  // Create a zip buffer in memory
  const zip = new (await import("jszip")).default();
  zip.file(fileName, fileContent);
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    platform: "UNIX",
  });
}
