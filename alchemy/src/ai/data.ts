import { generateObject } from "ai";
import type { JsonSchema, Type, type } from "arktype";
import type { Context } from "../context";
import { Resource } from "../resource";
import type { Secret } from "../secret";
import { ark } from "./ark";
import { type ModelConfig, createModel } from "./client";

/**
 * Properties for creating or updating an AI Object
 */
export interface DataProps<T extends Type<any, any>> {
  /**
   * The ArkType schema to validate and structure the generated content
   */
  schema: T | JsonSchema;

  /**
   * Prompt for generating the content
   * Use alchemy template literals to include file context:
   * @example
   * prompt: await alchemy`
   *   Generate a description for:
   *   ${alchemy.file("src/data.ts")}
   * `
   */
  prompt: string;

  /**
   * System prompt to guide the AI's behavior
   * @example
   * system: "You are a technical writer tasked with describing code"
   */
  system?: string;

  /**
   * Temperature for controlling randomness in generation.
   * Higher values (e.g., 0.8) make output more random,
   * lower values (e.g., 0.2) make it more deterministic.
   * @default 0.7
   */
  temperature?: number;

  /**
   * Base URL for the OpenAI API
   * @default 'https://api.openai.com/v1'
   */
  baseURL?: string;

  /**
   * OpenAI API key to use for generating content
   * If not provided, will use OPENAI_API_KEY environment variable
   */
  apiKey?: Secret;

  /**
   * Model configuration
   */
  model?: ModelConfig;
}

/**
 * A resource that uses AI to generate structured content based on a schema
 */
export interface Data<T> extends Resource<"ai::Object"> {
  type: JsonSchema;

  /**
   * The generated content, typed according to the provided schema
   */
  object: T;

  /**
   * Time at which the content was generated
   */
  createdAt: number;
}

/**
 * Resource for generating structured content using the Vercel AI SDK.
 * Supports powerful context handling through the alchemy template literal tag.
 *
 * @example
 * // Generate a product description with specific fields
 * const productSchema = type({
 *   name: "string",
 *   description: "string",
 *   features: "string[]",
 *   price: "number"
 * });
 *
 * const product = await Data("new-product", {
 *   schema: productSchema,
 *   prompt: "Generate a product description for a new smartphone",
 *   system: "You are a product copywriter specializing in tech products",
 *   model: {
 *     id: "gpt-4o",
 *     provider: "openai",
 *     options: {
 *       temperature: 0.7
 *     }
 *   }
 * });
 *
 * console.log(product.object); // Typed as per schema
 *
 * @example
 * // Generate code documentation with context
 * const docSchema = type({
 *   summary: "string",
 *   parameters: {
 *     name: "string",
 *     type: "string",
 *     description: "string"
 *   }[],
 *   returns: "string"
 * });
 *
 * const docs = await Data("function-docs", {
 *   schema: docSchema,
 *   prompt: await alchemy`
 *     Generate documentation for this function:
 *     ${alchemy.file("src/utils/format.ts")}
 *   `,
 *   system: "You are a technical documentation writer",
 *   temperature: 0.2
 * });
 *
 * @example
 * // Using specific model configuration with advanced options
 * const analysisSchema = type({
 *   insights: "string[]",
 *   recommendations: "string[]",
 *   risk: "'low'|'medium'|'high'"
 * });
 *
 * const analysis = await Data("code-analysis", {
 *   schema: analysisSchema,
 *   prompt: await alchemy`
 *     Analyze this code for security issues:
 *     ${alchemy.file("src/auth/login.ts")}
 *   `,
 *   system: "You are a security expert specializing in code analysis",
 *   model: {
 *     id: "o3-mini",
 *     provider: "openai",
 *     options: {
 *       reasoningEffort: "high"
 *     }
 *   },
 *   temperature: 0.1
 * });
 */
export const Data = Resource("ai::Object", async function <
  const T extends Type<any, any>,
>(this: Context<Data<any>>, id: string, props: DataProps<T>): Promise<
  Data<type.infer<T>>
> {
  if (this.phase === "delete") {
    return this.destroy();
  }

  // Generate structured output using generateObject
  const { object } = await generateObject({
    model: createModel(props),
    // Convert ArkType schema to Zod schema for generateObject
    // This is needed because generateObject expects a Zod schema
    schema: ark.schema<type.infer<T>>(props.schema),
    providerOptions: props.model?.options,
    system:
      props.system ||
      "You are an AI assistant tasked with generating structured content.",
    prompt: props.prompt,
    ...(props.temperature === undefined
      ? {}
      : // some models error if you provide it (rather than ignoring it)
        { temperature: props.temperature }),
  });

  // Return the resource with typed content
  return this({
    type: props.schema,
    object: object,
    createdAt: Date.now(),
  });
});
