import { createCloudflareApi, type CloudflareApiOptions } from "./api.ts";

export async function MiniflareAiProxy(options?: {
  apiOptions?: Partial<CloudflareApiOptions>;
}) {
  const api = await createCloudflareApi(options?.apiOptions);

  return {
    name: "__ALCHEMY_EXTERNAL_AI_PROXY_WORKER",
    bindings: {
      ACCOUNT_ID: api.accountId,
      API_TOKEN: api.apiToken?.unencrypted,
    },
    modules: [
      {
        type: "ESModule",
        path: "index.mjs",
        contents: `
import { WorkerEntrypoint } from 'cloudflare:workers';

class Ai {
    constructor(accountId, apiToken) {
        this.accountId = accountId;
        this.apiToken = apiToken;
        this.baseUrl = 'https://api.cloudflare.com/client/v4';
    }

    async run(model, input) {
        const url = \`\${this.baseUrl}/accounts/\${this.accountId}/ai/run/\${model}\`;
        
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': \`Bearer \${this.apiToken}\`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(input)
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(\`AI API request failed: \${response.status} \${response.statusText}. Response: \${errorText}\`);
        }

        const result = await response.json();
        
        if (result.success === false) {
            throw new Error(\`AI API returned error: \${JSON.stringify(result.errors)}\`);
        }
        
        return result.result || result;
    }

    async listModels() {
        const url = \`\${this.baseUrl}/accounts/\${this.accountId}/ai/models/search\`;
        
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': \`Bearer \${this.apiToken}\`,
                'Content-Type': 'application/json',
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(\`AI Models API request failed: \${response.status} \${response.statusText}. Response: \${errorText}\`);
        }

        const result = await response.json();
        return result.result || result;
    }
}

export default class extends WorkerEntrypoint {
    constructor(ctx, env) {
        super(ctx, env);
        this.ai = new Ai(env.ACCOUNT_ID, env.API_TOKEN);
    }

    async fetch(request) {
        return new Response('AI Proxy Service', { status: 200 });
    }
    
    async run(model, input) {
        return await this.ai.run(model, input);
    }
    
    async listModels() {
        return await this.ai.listModels();
    }
}
`,
      },
    ],
  };
}
