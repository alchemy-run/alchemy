import { Document } from "../ai";
import type { ModelConfig } from "../ai/client";
import { alchemy } from "../alchemy";
import type { Folder } from "../fs";

export interface GettingStartedProps {
  /**
   * The output directory for the getting started document.
   */
  path: string | Folder;

  /**
   * The prompt to use for generating the getting started guide.
   * This should include specific details about the product or framework.
   */
  prompt: string;

  /**
   * Optional model configuration for generating the getting started guide.
   * Defaults to Claude 3.5 Sonnet.
   */
  model?: ModelConfig;
}

export type GettingStarted = Document;

export async function GettingStarted({
  path: outFile,
  prompt,
  model = {
    id: "claude-3-5-sonnet-latest",
    provider: "anthropic",
  },
}: GettingStartedProps): Promise<Document> {
  return Document(`docs/getting-started`, {
    title: "Getting Started Guide",
    path: typeof outFile === "string" ? outFile : outFile.path,
    model,
    prompt: await alchemy`
      You are a technical writer creating a getting started guide.
      
      ${prompt}
      
      If you need a template structure to follow, use this format:
      
      # Getting Started with [Product/Framework Name]
      
      (Brief introduction to the product/framework)
      
      ## Installation
      
      \`\`\`bash
      # Installation command
      \`\`\`
      
      ## Creating Your First Project
      
      (Step-by-step guide to creating a basic project)
      
      \`\`\`ts
      // Example of a simple project
      \`\`\`
      
      ## Core Concepts
      
      ### [Concept 1]
      
      (Explanation of the first core concept)
      
      \`\`\`ts
      // Example of using the concept
      \`\`\`
      
      ### [Concept 2]
      
      (Explanation of the second core concept)
      
      \`\`\`ts
      // Example of using the concept
      \`\`\`
      
      ## Working with [Feature]
      
      (How to use a specific feature)
      
      \`\`\`ts
      // Example of using the feature
      \`\`\`
      
      ## Testing
      
      (How to test your project)
      
      \`\`\`ts
      // Example of testing
      \`\`\`
      
      ## Deployment
      
      (How to deploy your project)
      
      \`\`\`ts
      // Example of deployment
      \`\`\`
      
      ## Next Steps
      
      (Where to go next to learn more)
      
      > [!TIP]
      > Make sure the examples follow a natural progression from minimal examples to more complex use cases.
      > Keep explanations concise and focused on high-value information.
    `,
  });
}
