import { generateObject } from "ai";
import { z } from "zod";
import { alchemy } from "../alchemy";
import type { Context } from "../context";
import { Resource } from "../resource";
import type { Secret } from "../secret";
import {
  type ModelConfig,
  createClient,
  getModelId,
  getModelOptions,
} from "./client";

/**
 * Properties for creating or updating a Group
 */
export interface GroupProps<Categories extends [string, ...string[]]> {
  /**
   * Prompt for identifying groups
   * Use alchemy template literals to include file context:
   * @example
   * prompt: await alchemy`
   *   Identify distinct groups in:
   *   ${alchemy.file("src/data.ts")}
   * `
   */
  prompt: string;

  /**
   * Array of categories to give each group.
   */
  categories: Categories;

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
 * A resource that uses AI to identify distinct groups from a prompt
 */
export interface Groups<Categories extends [string, ...string[]]>
  extends Resource<"docs::Group"> {
  /**
   * Array of identified group names
   */
  groups: {
    title: string;
    filename: string;
    category: Categories[number];
  }[];

  /**
   * Time at which the groups were identified
   */
  createdAt: number;
}

/**
 * Resource for identifying distinct groups using the Vercel AI SDK.
 * Supports powerful context handling through the alchemy template literal tag.
 *
 * @example
 * // Identify groups in a data file
 * const dataGroups = await Group("data-groups", {
 *   categories: ["User", "Post"],
 *   prompt: await alchemy`
 *     Identify distinct groups in this data:
 *     ${alchemy.file("src/data.ts")}
 *     Classify as either "User" or "Post"
 *   `
 * });
 *
 * console.log(dataGroups.groups); // ["group1", "group2", ...]
 *
 * @example
 * // Identify groups across multiple files
 * const modelGroups = await Group("model-groups", {
 *   categories: ["User", "Post"],
 *   prompt: await alchemy`
 *     Identify distinct groups in these models:
 *     ${alchemy.files("src/models/user.ts", "src/models/post.ts")}
 *     Classify as either "User" or "Post"
 *   `
 * });
 */
export const Groups = Resource("docs::Group", async function <
  const Categories extends [string, ...string[]],
>(this: Context<Groups<Categories>>, id: string, props: GroupProps<Categories>): Promise<
  Groups<Categories>
> {
  if (this.phase === "delete") {
    return this.destroy();
  }

  // Initialize OpenAI compatible provider using shared client
  const provider = createClient(props);

  // Generate structured output using generateObject
  const {
    object: { groups },
  } = await generateObject({
    model: provider(getModelId(props)),
    schema: z.object({
      groups: z
        .array(
          z.object({
            title: z
              .string()
              .describe(
                'A friendly title for the document, e.g. "Static Site"',
              ),
            filename: z
              .string()
              .describe("name of the file, e.g. static-site.md"),
            category: z
              .enum(props.categories)
              .describe("The category of the group"),
          }),
        )
        .describe("Array of distinct group names identified from the input"),
    }),
    system: await alchemy`
        You are a technical writer tasked with identifying the distinct documents that need to be written for a document group (folder) in a documentation site.

        You will be provided with a list of documents and instructions on how to classify them.

        Each document has a title, file name, and category.
      `,
    prompt: props.prompt,
    ...getModelOptions(props),
  });

  // Return the resource
  return this({
    groups: groups as Groups<Categories>["groups"],
    createdAt: Date.now(),
  });
});
