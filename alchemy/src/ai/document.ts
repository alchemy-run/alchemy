import { generateText } from "ai";
import fs from "node:fs/promises";
import path from "node:path";
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
 * Properties for creating or updating a Document
 */
export interface DocumentProps {
  /**
   * Path to the markdown document
   */
  path: string;

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
   *   Generate docs using:
   *   ${alchemy.file("src/api.ts")}
   * `
   */
  prompt: string;

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
 * A markdown document that can be created, updated, and deleted
 */
export interface Document extends DocumentProps, Resource<"docs::Document"> {
  /**
   * Content of the document
   */
  content: string;

  /**
   * Time at which the document was created
   */
  createdAt: number;

  /**
   * Time at which the document was last updated
   */
  updatedAt: number;
}

/**
 * Resource for managing AI-generated markdown documents using the Vercel AI SDK.
 * Supports powerful context handling through the alchemy template literal tag.
 *
 * @example
 * // Create a document using alchemy template literals for context
 * const apiDocs = await Document("api-docs", {
 *   path: "./docs/api.md",
 *   prompt: await alchemy`
 *     Generate API documentation based on these source files:
 *     ${alchemy.file("src/api.ts")}
 *     ${alchemy.file("src/types.ts")}
 *   `
 *   // The above will automatically append the file contents as code blocks:
 *   //
 *   // Generate API documentation based on these source files:
 *   // [api.ts](src/api.ts)
 *   // [types.ts](src/types.ts)
 *   //
 *   // // src/api.ts
 *   // ```ts
 *   // ... contents of api.ts ...
 *   // ```
 *   //
 *   // // src/types.ts
 *   // ```ts
 *   // ... contents of types.ts ...
 *   // ```
 * });
 *
 * @example
 * // Use alchemy template literals with file collections
 * const modelDocs = await Document("models", {
 *   path: "./docs/models.md",
 *   prompt: await alchemy`
 *     Write documentation for these data models:
 *     ${alchemy.files("src/models/user.ts", "src/models/post.ts")}
 *   `
 *   // This creates a prompt with all files appended as code blocks,
 *   // automatically handling syntax highlighting based on file extensions
 * });
 */
export const Document = Resource(
  "docs::Document",
  async function (
    this: Context<Document>,
    id: string,
    props: DocumentProps,
  ): Promise<Document> {
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

    // Initialize OpenAI compatible provider using shared client
    const provider = createClient(props);

    // Generate content
    const { text } = await generateText({
      model: provider(getModelId(props)),
      prompt: props.prompt,
      ...getModelOptions(props),
    });

    // Write content to file
    await fs.writeFile(props.path, text);

    // Get file stats for timestamps
    const stats = await fs.stat(props.path);

    // Return the resource
    return this({
      ...props,
      content: text,
      createdAt: stats.birthtimeMs,
      updatedAt: stats.mtimeMs,
    });
  },
);
