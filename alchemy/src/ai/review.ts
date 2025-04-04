import { generateText, type CoreMessage } from "ai";
import type { Context } from "../context";
import { Resource } from "../resource";
import type { Secret } from "../secret";
import { createModel, withRateLimitRetry, type ModelConfig } from "./client";

/**
 * Properties for creating or updating a Review
 */
export interface ReviewProps {
  /**
   * Content to be reviewed
   * Use alchemy template literals to include file context:
   * @example
   * content: await alchemy`
   *   Review this code:
   *   ${alchemy.file("src/api.ts")}
   * `
   *
   * Required unless messages are provided
   */
  content?: string;

  /**
   * Prompt for the review
   * This should include specific instructions for the review
   * @example
   * prompt: "Review this code for security vulnerabilities, performance issues, and best practices."
   *
   * Required unless messages are provided
   */
  prompt?: string;

  /**
   * Message history for the conversation
   * If provided, this will be used instead of the prompt and content
   */
  messages?: CoreMessage[];

  /**
   * System prompt for the model
   * This is used to provide instructions to the model about how to format the response
   * The default system prompt instructs the model to act as a reviewer
   */
  system?: string;

  /**
   * AI API key to use for generating content
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
}

/**
 * Output returned after Review creation/update
 */
export interface Review extends ReviewProps, Resource<"ai::Review"> {
  /**
   * Content of the review
   */
  content: string;

  /**
   * Updated message history with the review response appended
   */
  messages: CoreMessage[];

  /**
   * Time at which the review was created
   */
  createdAt: number;

  /**
   * Time at which the review was last updated
   */
  updatedAt: number;
}

/**
 * Default system prompt for review generation
 */
const DEFAULT_REVIEW_SYSTEM_PROMPT = `You are an expert code reviewer and technical writer. Your task is to provide a thorough review of the provided content. Your review should include:

1. A high-level summary of the content
2. Detailed feedback on the content's quality, accuracy, and completeness
3. Specific suggestions for improvement
4. Alternative approaches or solutions where applicable
5. Best practices that should be followed
6. Potential issues or concerns that should be addressed

Provide your review in a clear, well-structured format.`;

/**
 * Creates or updates a Review resource
 *
 * @example
 * // Create a review of a code file
 * const codeReview = await Review("api-review", {
 *   content: await alchemy`
 *     Review this API implementation:
 *     ${alchemy.file("src/api.ts")}
 *   `,
 *   prompt: "Review this API implementation for security vulnerabilities, performance issues, and best practices. Suggest improvements and alternative approaches."
 * });
 *
 * @example
 * // Create a review of a document
 * const docReview = await Review("tutorial-review", {
 *   content: await alchemy`
 *     Review this tutorial:
 *     ${alchemy.file("docs/tutorials/getting-started.md")}
 *   `,
 *   prompt: "Review this tutorial for clarity, accuracy, and completeness. Suggest improvements to make it more user-friendly."
 * });
 *
 * @example
 * // Create a review with message history
 * const reviewWithHistory = await Review("code-review-iteration-2", {
 *   content: "Updated code implementation",
 *   prompt: "Review this updated implementation",
 *   messages: [
 *     { role: "user", content: "Can you review my code?" },
 *     { role: "assistant", content: "I'll review your code. Please share it." },
 *     { role: "user", content: "Here's my implementation: [code]" },
 *     { role: "assistant", content: "Here's my review of your code: [previous review]" }
 *   ]
 * });
 */
export const Review = Resource(
  "ai::Review",
  async function (
    this: Context<Review>,
    id: string,
    props: ReviewProps
  ): Promise<Review> {
    if (this.phase === "delete") {
      return this.destroy();
    }

    // Use provided system prompt or default
    const system = props.system || DEFAULT_REVIEW_SYSTEM_PROMPT;

    // Create messages array if not provided
    const messages =
      props.messages ||
      (props.content && props.prompt
        ? [
            {
              role: "user",
              content: `${props.content}\n\n${props.prompt}`,
            },
          ]
        : []);

    if (messages.length === 0) {
      throw new Error(
        "Either messages or both content and prompt must be provided"
      );
    }

    // Generate review content with rate limit retry
    const { text } = await withRateLimitRetry(async () => {
      return generateText({
        model: createModel(props),
        messages,
        system,
        maxTokens: props.maxTokens || 8192,
        providerOptions: props.model?.options,
        ...(props.temperature === undefined
          ? {}
          : { temperature: props.temperature }),
      });
    });

    // Create updated message history with the AI's response
    const updatedMessages = [
      ...messages,
      {
        role: "assistant" as const,
        content: text,
      },
    ];

    // Return the review with the direct text from the LLM and updated messages
    return this({
      ...props,
      content: text,
      messages: updatedMessages,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
);
