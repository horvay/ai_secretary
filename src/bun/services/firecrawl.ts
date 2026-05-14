import { getSetting } from "./app-state";

const FIRECRAWL_API_URL = "https://api.firecrawl.dev/v2";

export interface FirecrawlSettingsStatus {
  enabled: boolean;
  hasApiKey: boolean;
}

export interface FirecrawlSearchOptions {
  query: string;
  limit?: number;
  scrapeResults?: boolean;
}

export interface FirecrawlScrapeOptions {
  url: string;
  onlyMainContent?: boolean;
}

function getApiKey(): string {
  const key = getSetting("firecrawl.apiKey").trim();
  if (!key) throw new Error("Firecrawl is enabled but no API key is configured. Add your Firecrawl API key in Settings.");
  return key;
}

async function firecrawlPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${FIRECRAWL_API_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let json: unknown = null;
  if (text.trim()) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }

  if (!response.ok) {
    const message = typeof json === "object" && json && "error" in json ? String((json as { error: unknown }).error) : text;
    throw new Error(`Firecrawl ${path} failed (${response.status}): ${message || response.statusText}`);
  }

  return json as T;
}

export function getFirecrawlSettingsStatus(): FirecrawlSettingsStatus {
  const apiKey = getSetting("firecrawl.apiKey").trim();
  return {
    enabled: getSetting("firecrawl.enabled"),
    hasApiKey: apiKey.length > 0,
  };
}

export async function searchFirecrawl(options: FirecrawlSearchOptions): Promise<unknown> {
  if (!getSetting("firecrawl.enabled")) throw new Error("Firecrawl search is disabled in Settings.");
  const query = options.query.trim();
  if (!query) throw new Error("Search query is required.");
  const limit = Math.max(1, Math.min(10, Math.round(options.limit ?? 5)));
  return firecrawlPost("/search", {
    query,
    limit,
    scrapeOptions: options.scrapeResults ? { formats: ["markdown"], onlyMainContent: true } : undefined,
  });
}

export async function scrapeFirecrawl(options: FirecrawlScrapeOptions): Promise<unknown> {
  if (!getSetting("firecrawl.enabled")) throw new Error("Firecrawl search is disabled in Settings.");
  const url = options.url.trim();
  if (!url) throw new Error("URL is required.");
  return firecrawlPost("/scrape", {
    url,
    formats: ["markdown"],
    onlyMainContent: options.onlyMainContent ?? true,
  });
}
