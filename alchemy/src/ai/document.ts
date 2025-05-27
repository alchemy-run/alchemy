import { generateText, type CoreMessage } from "ai";
import type { Context } from "../context.js";
import { StaticTextFile } from "../fs/static-text-file.js";
import { Resource } from "../resource.js";
import type { Secret } from "../secret.js";
import { createModel, withRateLimitRetry, type ModelConfig } from "./client.js";

/**
 * Properties for creating or updating a Document
 */
export interface DocumentProps {
  /**
   * Title of the document
   *
   * @default id
   */
  title?: string;

  /**
   * Optional path to the markdown document
   * If provided, document will be written to this path
   */
  path?: string;

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
  prompt?: string;

  /**
   * Message history for conversation-based generation
   * If provided, this will be used instead of the prompt
   * @example
   * messages: [
   *   { role: "user", content: "Generate API documentation for this file" },
   *   { role: "assistant", content: "I'll create detailed API docs. What file should I document?" },
   *   { role: "user", content: "Please document src/api.ts" }
   * ]
   */
  messages?: CoreMessage[];

  /**
   * System prompt for the model
   * This is used to provide instructions to the model about how to format the response
   * The default system prompt instructs the model to return a single markdown document inside ```md fences
   * @default "You are a technical documentation writer. Create a single markdown document based on the user's requirements. Your response MUST include only a single markdown document inside ```md fences. Do not include any other text, explanations, or multiple code blocks."
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

  /**
   * Maximum number of tokens to generate.
   * Higher values allow for longer documents but may increase cost and generation time.
   * @default 10000
   */
  maxTokens?: number;

  /**
   * Freeze the document after creation (do not re-generate on updates)
   * @default false
   */
  freeze?: boolean;
}

/**
 * A markdown document that can be created, updated, and deleted
 */
export interface Document extends DocumentProps, Resource<"docs::Document"> {
  /**
   * The title of the document
   */
  title: string;

  /**
   * Content of the document
   */
  content: string;

  /**
   * Updated message history with the document response appended
   */
  messages: CoreMessage[];

  /**
   * Time at which the document was created
   */
  createdAt: number;

  /**
   * Time at which the document was last updated
   */
  updatedAt: number;

  /**
   * File resource if path was provided
   */
  file?: StaticTextFile;
}

/**
 * Default system prompt for markdown document generation
 */
const DEFAULT_MD_SYSTEM_PROMPT =
  "You are a technical documentation writer. Create a single markdown document based on the user's requirements. Your response MUST include only a single markdown document inside ```md fences. Do not include any other text, explanations, or multiple code blocks.";

/**
 * Resource for managing AI-generated markdown documents using the Vercel AI SDK.
 * Supports powerful context handling through the alchemy template literal tag.
 *
 * @example
 * // Create an in-memory document (no file created)
 * const apiDocs = await Document("api-docs", {
 *   title: "API Documentation",
 *   prompt: await alchemy`
 *     Generate API documentation based on these source files:
 *     ${alchemy.file("src/api.ts")}
 *     ${alchemy.file("src/types.ts")}
 *   `,
 *   model: {
 *     id: "gpt-4o",
 *     provider: "openai"
 *   }
 * });
 *
 * @example
 * // Create a document and write it to disk
 * const apiDocs = await Document("api-docs", {
 *   title: "API Documentation",
 *   path: "./docs/api.md",
 *   prompt: await alchemy`
 *     Generate API documentation based on these source files:
 *     ${alchemy.file("src/api.ts")}
 *     ${alchemy.file("src/types.ts")}
 *   `,
 *   model: {
 *     id: "gpt-4o",
 *     provider: "openai"
 *   }
 * });
 *
 * @example
 * // Use message history for iterative document generation
 * const apiDocs = await Document("api-docs", {
 *   title: "API Documentation",
 *   path: "./docs/api.md",
 *   messages: [
 *     { role: "user", content: "Create API documentation for these files" },
 *     { role: "assistant", content: "I'll help you create API documentation. Please provide the files." },
 *     { role: "user", content: "Here are the files: [file contents]" }
 *   ],
 *   system: "You are a technical documentation writer. Generate clear and concise API documentation.",
 *   model: {
 *     id: "gpt-4o",
 *     provider: "openai"
 *   }
 * });
 *
 * @example
 * // Use alchemy template literals with file collections and temperature control
 * const modelDocs = await Document("models", {
 *   title: "Data Models",
 *   path: "./docs/models.md",
 *   prompt: await alchemy`
 *     Write documentation for these data models:
 *     ${alchemy.files("src/models/user.ts", "src/models/post.ts")}
 *   `,
 *   temperature: 0.2 // Lower temperature for more deterministic output
 * });
 *
 * @example
 * // Advanced model configuration with custom provider options and custom system prompt
 * const techDocs = await Document("tech-specs", {
 *   title: "Technical Specifications",
 *   path: "./docs/tech-specs.md",
 *   prompt: await alchemy`
 *     Create detailed technical specifications based on these requirements:
 *     ${alchemy.file("requirements/system.md")}
 *   `,
 *   system: "You are an expert technical writer specializing in system specifications. Create a single markdown document inside ```md fences with no additional text.",
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
export const Document = Resource(
  "docs::Document",
  async function (
    this: Context<Document>,
    id: string,
    props: DocumentProps,
  ): Promise<Document> {
    // Validate that either prompt or messages are provided
    if (!props.prompt && !props.messages) {
      throw new Error("Either prompt or messages must be provided");
    }

    // Handle deletion phase
    if (this.phase === "delete") {
      return this.destroy();
    }

    if (this.phase === "update" && props.freeze) {
      if (props.path) {
        const filePath = props.path;
        const fileId = `${id}-file`;

        await StaticTextFile(fileId, filePath, this.output!.content);
      }
      return this(this.output);
    }

    // Use provided system prompt or default
    const system = props.system || DEFAULT_MD_SYSTEM_PROMPT;

    // Generate initial content with rate limit retry
    const { text } = await withRateLimitRetry(async () => {
      return generateText({
        model: createModel(props),
        ...(props.messages
          ? { messages: props.messages }
          : { prompt: props.prompt! }),
        system,
        maxTokens: props.maxTokens || 8192,
        providerOptions: props.model?.options,
        ...(props.temperature === undefined
          ? {}
          : // some models error if you provide it (rather than ignoring it)
            { temperature: props.temperature }),
      });
    });

    // Extract and validate markdown content
    let { content, error } = extractMarkdownContent(text);

    // Re-prompt if there are validation errors
    if (error) {
      const errorSystem = `${system}\n\nERROR: ${error}\n\nPlease try again and ensure your response contains exactly one markdown document inside \`\`\`md fences.`;

      const { text: retryText } = await withRateLimitRetry(async () => {
        return generateText({
          model: createModel(props),
          ...(props.messages
            ? { messages: props.messages }
            : { prompt: props.prompt! }),
          system: errorSystem,
          providerOptions: props.model?.options,
          ...(props.temperature === undefined
            ? {}
            : { temperature: props.temperature }),
        });
      });

      const retryResult = extractMarkdownContent(retryText);

      if (retryResult.error) {
        throw new Error(
          `Failed to generate valid markdown content: ${retryResult.error}\n${retryText}`,
        );
      }

      content = retryResult.content;
    }

    // Create result object
    const result: Partial<Document> = {
      ...props,
      content,
      messages: [
        ...(props.messages || [{ role: "user", content: props.prompt! }]),
        { role: "assistant", content },
      ],
      createdAt: this.output?.createdAt || Date.now(),
      updatedAt: Date.now(),
      title: props.title || id,
    };

    // Write file if path is provided
    if (props.path) {
      const filePath = props.path;
      const fileId = `${id}-file`;

      result.file = await StaticTextFile(fileId, filePath, content);
    }

    // Return the resource
    return this(result as Document);
  },
);

/**
 * Extracts markdown content from between ```md fences
 * Validates that exactly one markdown code block exists
 *
 * @param text The text to extract markdown content from
 * @returns The extracted markdown content or error message
 */
export function extractMarkdownContent(text: string): {
  content: string;
  error?: string;
} {
  const lines = text.split("\n");
  const startIdx = lines.findIndex((line) => line.trim() === "```md");

  if (startIdx === -1) {
    return {
      content: "",
      error:
        "No markdown code block found in the response. Please include your markdown content within ```md fences.",
    };
  }

  const rest = lines.slice(startIdx + 1);
  const endRelativeIdx = rest
    .map((line) => line.trim() === "```")
    .lastIndexOf(true);

  if (endRelativeIdx === -1) {
    return {
      content: "",
      error: "Markdown block was not closed properly.",
    };
  }

  const endIdx = startIdx + 1 + endRelativeIdx;

  const content = lines
    .slice(startIdx + 1, endIdx)
    .join("\n")
    .trim();

  return { content };
}
