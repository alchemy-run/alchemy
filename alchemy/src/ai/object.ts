import { generateObject } from "ai";
import type { JsonSchema, Type, type } from "arktype";
import type { Context } from "../context";
import { Resource } from "../resource";
import type { Secret } from "../secret";
import { ark } from "./ark";
import {
  type ModelConfig,
  createClient,
  getModelId,
  getModelOptions,
} from "./client";

/**
 * Properties for creating or updating an AI Object
 */
export interface ObjectProps<T extends Type<any, any>> {
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
export interface Object<T> extends Resource<"ai::Object"> {
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
 * const product = await Object("new-product", {
 *   schema: productSchema,
 *   prompt: "Generate a product description for a new smartphone",
 *   system: "You are a product copywriter specializing in tech products"
 * });
 *
 * console.log(product.content); // Typed as per schema
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
 * const docs = await Object("function-docs", {
 *   schema: docSchema,
 *   prompt: await alchemy`
 *     Generate documentation for this function:
 *     ${alchemy.file("src/utils/format.ts")}
 *   `,
 *   system: "You are a technical documentation writer"
 * });
 */
export const Object = Resource("ai::Object", async function <
  const T extends Type<any, any>,
>(this: Context<Object<any>>, id: string, props: ObjectProps<T>): Promise<
  Object<type.infer<T>>
> {
  if (this.phase === "delete") {
    return this.destroy();
  }

  // Initialize OpenAI compatible provider using shared client
  const provider = createClient(props);

  // Generate structured output using generateObject
  const { object } = await generateObject({
    model: provider(getModelId(props)),
    // Convert ArkType schema to Zod schema for generateObject
    // This is needed because generateObject expects a Zod schema
    schema: ark.schema<type.infer<T>>(props.schema),
    system:
      props.system ||
      "You are an AI assistant tasked with generating structured content.",
    prompt: props.prompt,
    ...getModelOptions(props),
  });

  // Return the resource with typed content
  return this({
    type: props.schema,
    object: object,
    createdAt: Date.now(),
  });
});
