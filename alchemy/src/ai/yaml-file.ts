import { generateObject, generateText } from "ai";
import type { JsonSchema, Type, type } from "arktype";
import fs from "node:fs/promises";
import path from "node:path";
import type { Context } from "../context";
import { Resource } from "../resource";
import type { Secret } from "../secret";
import { ignore } from "../util/ignore";
import { ark } from "./ark";
import { type ModelConfig, createModel } from "./client";

/**
 * Properties for creating or updating a YAMLFile
 */
export interface YAMLFileProps<
  T extends Type<any, any> | undefined = undefined,
> {
  /**
   * Path to the YAML file
   */
  path: string;

  /**
   * Optional ArkType schema to validate and structure the generated YAML
   * When provided, the resource will use generateObject with schema validation
   * When not provided, it will extract YAML from between ```yaml fences
   */
  schema?: T;

  /**
   * Base URL for the OpenAI API
   * @default 'https://api.openai.com/v1'
   */
  baseURL?: string;

  /**
   * Prompt for generating content
   * Use alchemy template literals to include file context:
   * @example
   * prompt: await alchemy`
   *   Generate a YAML configuration for:
   *   ${alchemy.file("src/serverless.js")}
   * `
   */
  prompt: string;

  /**
   * System prompt for the model
   * This is used to provide instructions to the model about how to format the response
   * @default Depends on whether schema is provided
   */
  system?: string;

  /**
   * OpenAI API key to use for generating content
   * If not provided, will use OPENAI_API_KEY environment variable
   */
  apiKey?: Secret;

  /**
   * Model configuration
   */
  model?: ModelConfig;

  /**
   * Temperature for controlling randomness in generation.
   * Higher values (e.g., 0.8) make output more random,
   * lower values (e.g., 0.2) make it more deterministic.
   * @default 0.7
   */
  temperature?: number;
}

/**
 * A YAML file that can be created, updated, and deleted
 */
export interface YAMLFile<T = any>
  extends Omit<YAMLFileProps, "schema">,
    Resource<"ai::YAMLFile"> {
  /**
   * Content of the YAML file as a string
   */
  content: string;

  /**
   * Parsed YAML object
   */
  yaml: T;

  /**
   * Schema used to validate the YAML (if provided)
   */
  schema?: JsonSchema;

  /**
   * Time at which the file was created
   */
  createdAt: number;

  /**
   * Time at which the file was last updated
   */
  updatedAt: number;
}

/**
 * Default system prompt for YAML file generation without schema
 */
const DEFAULT_YAML_SYSTEM_PROMPT =
  "You are a YAML generator. Create valid YAML based on the user's requirements. Your response MUST include only YAML inside ```yaml fences. Do not include any other text, explanations, or multiple code blocks. Use standard YAML syntax with proper indentation. Use quotes around strings that contain special characters when necessary.";

/**
 * Resource for generating YAML files using AI models.
 * Can operate in two modes:
 * 1. With schema: Uses generateObject with type validation, then converts to YAML
 * 2. Without schema: Extracts YAML from between ```yaml fences
 *
 * @example
 * // Generate a serverless configuration file
 * const serverlessConfig = await YAMLFile("serverless-config", {
 *   path: "./serverless.yml",
 *   prompt: await alchemy`
 *     Generate a serverless.yml configuration for an AWS Lambda API with:
 *     - A service name "user-api"
 *     - Node.js 16.x runtime
 *     - Three functions: createUser, getUser, and listUsers
 *     - API Gateway endpoints for each function
 *     - DynamoDB table for users
 *     - IAM permissions for DynamoDB access
 *   `,
 *   model: {
 *     id: "gpt-4o",
 *     provider: "openai"
 *   }
 * });
 *
 * @example
 * // Generate YAML with schema validation
 * import { type } from "arktype";
 *
 * const k8sConfigSchema = type({
 *   apiVersion: "string",
 *   kind: "string",
 *   metadata: {
 *     name: "string",
 *     namespace: "string?",
 *     labels: "Record<string, string>?"
 *   },
 *   spec: {
 *     replicas: "number",
 *     selector: {
 *       matchLabels: "Record<string, string>"
 *     },
 *     template: {
 *       metadata: {
 *         labels: "Record<string, string>"
 *       },
 *       spec: {
 *         containers: [{
 *           name: "string",
 *           image: "string",
 *           ports: [{
 *             containerPort: "number"
 *           }]
 *         }]
 *       }
 *     }
 *   }
 * });
 *
 * const deployment = await YAMLFile("k8s-deployment", {
 *   path: "./kubernetes/deployment.yaml",
 *   schema: k8sConfigSchema,
 *   prompt: "Generate a Kubernetes deployment for a web application named 'frontend' with 3 replicas using the nginx:latest image and exposing port 80",
 *   temperature: 0.2
 * });
 *
 * @example
 * // Generate GitHub Actions workflow with custom system prompt
 * const workflow = await YAMLFile("github-workflow", {
 *   path: "./.github/workflows/ci.yml",
 *   prompt: await alchemy`
 *     Create a GitHub Actions workflow for a Node.js project that:
 *     - Runs on push to main and pull requests
 *     - Sets up Node.js 18
 *     - Installs dependencies with npm
 *     - Runs linting and tests
 *     - Builds the project
 *     - Deploys to GitHub Pages on success (main branch only)
 *   `,
 *   system: "You are a DevOps expert specializing in GitHub Actions workflows. Create a single YAML file inside ```yaml fences with no additional text. Follow GitHub Actions best practices and use proper YAML syntax.",
 *   model: {
 *     id: "claude-3-opus-20240229",
 *     provider: "anthropic"
 *   }
 * });
 */
export const YAMLFile = Resource("ai::YAMLFile", async function <
  const T extends Type<any, any> | undefined = undefined,
>(this: Context<YAMLFile<T extends Type<any, any> ? type.infer<T> : any>>, id: string, props: YAMLFileProps<T>): Promise<
  YAMLFile<T extends Type<any, any> ? type.infer<T> : any>
> {
  // Ensure directory exists
  await fs.mkdir(path.dirname(props.path), { recursive: true });

  if (this.phase === "delete") {
    try {
      await fs.unlink(props.path);
    } catch (error: any) {
      // Ignore if file doesn't exist
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    return this.destroy();
  }

  // Dynamic import js-yaml to avoid dependency issues
  // This allows the code to work even if js-yaml is not installed
  let yaml: typeof import("yaml");
  try {
    yaml = await import("yaml");
  } catch (err) {
    throw new Error(
      "The 'yaml' package is required for the YAMLFile resource. Please install it with: bun add yaml",
    );
  }

  let yamlContent: string;
  let yamlObject: any;

  // Check if schema is provided
  if (props.schema) {
    // Use schema-based generation
    const { object } = await generateObject({
      model: createModel(props),
      schema: ark.schema<type.infer<typeof props.schema>>(props.schema),
      providerOptions: props.model?.options,
      system:
        props.system ||
        "Generate a valid object based on the provided requirements.",
      prompt: props.prompt,
      ...(props.temperature === undefined
        ? {}
        : { temperature: props.temperature }),
    });

    yamlObject = object;

    // Convert object to YAML
    try {
      yamlContent = yaml.stringify(yamlObject, {
        indent: 2,
      });
    } catch (error) {
      throw new Error(
        `Failed to convert object to YAML: ${(error as Error).message}`,
      );
    }
  } else {
    // Use fence-based extraction
    // Use provided system prompt or default
    const system = props.system || DEFAULT_YAML_SYSTEM_PROMPT;

    // Generate initial content
    const { text } = await generateText({
      model: createModel(props),
      prompt: props.prompt,
      system,
      providerOptions: props.model?.options,
      ...(props.temperature === undefined
        ? {}
        : { temperature: props.temperature }),
    });

    // Extract and validate YAML content
    let { content, error } = await extractYAMLContent(text);

    // Re-prompt if there are validation errors
    if (error) {
      const errorSystem = `${system}\n\nERROR: ${error}\n\nPlease try again and ensure your response contains exactly one YAML block inside \`\`\`yaml fences.`;

      const { text: retryText } = await generateText({
        model: createModel(props),
        prompt: props.prompt,
        system: errorSystem,
        providerOptions: props.model?.options,
        ...(props.temperature === undefined
          ? {}
          : { temperature: props.temperature }),
      });

      const retryResult = await extractYAMLContent(retryText);

      if (retryResult.error) {
        throw new Error(`Failed to generate valid YAML: ${retryResult.error}`);
      }

      content = retryResult.content;
    }

    yamlContent = content;

    // Parse YAML to validate and get object representation
    try {
      yamlObject = yaml.parse(yamlContent);
    } catch (error) {
      throw new Error(`Failed to parse YAML: ${(error as Error).message}`);
    }
  }

  if (this.phase === "update" && props.path !== this.props.path) {
    await ignore("ENOENT", () => fs.unlink(this.props.path));
  }

  // Write content to file
  await fs.writeFile(props.path, yamlContent);

  // Get file stats for timestamps
  const stats = await fs.stat(props.path);

  // Return the resource
  return this({
    ...props,
    schema: props.schema,
    content: yamlContent,
    yaml: yamlObject,
    createdAt: stats.birthtimeMs,
    updatedAt: stats.mtimeMs,
  });
});

/**
 * Extracts YAML content from between ```yaml fences
 * Validates that exactly one YAML code block exists
 *
 * @param text The text to extract YAML from
 * @returns The extracted YAML or error message
 */
async function extractYAMLContent(
  text: string,
): Promise<{ content: string; error?: string }> {
  // Check for yaml or yml fence blocks
  const yamlCodeRegex = /```(yaml|yml)\s*([\s\S]*?)```/g;
  const matches = Array.from(text.matchAll(yamlCodeRegex));

  if (matches.length === 0) {
    return {
      content: "",
      error:
        "No YAML code block found in the response. Please include your YAML within ```yaml fences.",
    };
  }

  if (matches.length > 1) {
    return {
      content: "",
      error:
        "Multiple YAML code blocks found in the response. Please provide exactly one YAML block within ```yaml fences.",
    };
  }

  const content = matches[0][2].trim();

  // We don't validate YAML parsing here because js-yaml might not be available
  // Validation will happen at usage time if needed
  return { content };
}
