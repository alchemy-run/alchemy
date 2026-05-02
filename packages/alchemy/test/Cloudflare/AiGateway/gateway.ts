import * as Cloudflare from "@/Cloudflare/index.ts";

export const Gateway = Cloudflare.AiGateway("Gateway", {
  id: "alchemy-test-ai-gateway-binding",
  cacheTtl: 60,
  collectLogs: true,
});
