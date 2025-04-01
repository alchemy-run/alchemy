import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Secret } from "../secret";

/**
 * Model configuration for AI operations
 */
export interface ModelConfig {
  /**
   * Model ID to use
   * @default 'gpt-4o'
   */
  id?: string;

  /**
   * Model provider name
   * @default 'openai'
   */
  provider?: string;

  /**
   * Model-specific options
   */
  options?: Record<string, unknown>;
}

/**
 * Configuration for creating an OpenAI client
 */
export interface ClientConfig {
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
 * Creates an OpenAI-compatible client with the given configuration
 */
export function createClient(config: ClientConfig) {
  // Get API key from props or environment
  const apiKey = config.apiKey?.unencrypted || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OpenAI API key is required");
  }

  // Initialize OpenAI compatible provider
  return createOpenAICompatible({
    name: config.model?.provider || "openai",
    apiKey,
    baseURL: config.baseURL || "https://api.openai.com/v1",
  });
}

/**
 * Gets the model ID from the configuration or returns the default
 */
export function getModelId(config: ClientConfig): string {
  return config.model?.id || "gpt-4o";
}

/**
 * Gets the model options from the configuration
 */
export function getModelOptions(config: ClientConfig): Record<string, unknown> {
  return config.model?.options || {};
}
