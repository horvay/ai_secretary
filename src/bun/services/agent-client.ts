import type { AgentClientInstance } from "./agent/types";
import { getSetting } from "./app-state";

let cachedClient: AgentClientInstance | null = null;
let cachedBackend: AgentBackend | null = null;

type AgentBackend = "pi" | "local-llama";

function getRequestedAgentBackend(): AgentBackend {
  if (process.env.AI_SECRETARY_AGENT_BACKEND === "local-llama") return "local-llama";

  const backendFlagIndex = process.argv.findIndex((arg) => arg === "--agent-backend");
  if (backendFlagIndex >= 0 && process.argv[backendFlagIndex + 1] === "local-llama") return "local-llama";
  if (process.argv.includes("--local-llama")) return "local-llama";

  return getSetting("agent.backend");
}

export function getAgentBackend(): AgentBackend {
  return getRequestedAgentBackend();
}

export async function getAgentClient(): Promise<AgentClientInstance> {
  const requestedBackend = getRequestedAgentBackend();
  if (cachedClient) {
    cachedBackend = requestedBackend;
    return cachedClient;
  }

  const module = await import("./pi-sdk");
  cachedClient = module.getPiClient();
  cachedBackend = requestedBackend;
  return cachedClient;
}
