import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

const GDELT_DOC_API = "https://api.gdeltproject.org/api/v2/doc/doc";

// How long we're willing to keep retrying a single request before giving up.
const MAX_RETRIES = 4;
// Base delay for exponential backoff (ms). Sequence: 500, 1000, 2000, 4000.
const BASE_DELAY_MS = 500;
// How long successful responses are cached (seconds). Identical queries
// from any team member within this window are served from cache instead
// of hitting GDELT again, which also reduces how often we get rate-limited.
const CACHE_TTL_SECONDS = 300;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Small helper so all three tools share the same fetch + error handling logic.
 * Adds two things on top of a plain fetch:
 *   1. Retries with exponential backoff when GDELT returns 429 (or a 5xx
 *      transient error), instead of failing on the very first hiccup.
 *   2. A short-lived shared cache (Cloudflare's edge Cache API) so that the
 *      same query fired by different team members within a few minutes of
 *      each other reuses one result instead of generating N calls to GDELT.
 */
async function callGdelt(params: Record<string, string>) {
  const url = `${GDELT_DOC_API}?${new URLSearchParams(params).toString()}`;
  const cacheKey = new Request(url, { method: "GET" });
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached.json();
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      headers: { "User-Agent": "gdelt-mcp/1.0 (internal team server)" },
    });

    if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
      lastError = new Error(`GDELT API returned ${res.status} ${res.statusText}`);
      if (attempt < MAX_RETRIES) {
        // Respect Retry-After if GDELT sends one, otherwise back off ourselves.
        const retryAfterHeader = res.headers.get("Retry-After");
        const retryAfterMs = retryAfterHeader
          ? Number(retryAfterHeader) * 1000
          : BASE_DELAY_MS * 2 ** attempt;
        await sleep(retryAfterMs);
        continue;
      }
      throw lastError;
    }

    if (!res.ok) {
      // A non-retryable error (e.g. 400 bad query) - fail immediately.
      throw new Error(`GDELT API returned ${res.status} ${res.statusText}`);
    }

    const text = await res.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      // GDELT occasionally returns an HTML error page (e.g. for malformed
      // queries) instead of JSON even with a 200 status.
      throw new Error(
        `GDELT API did not return valid JSON. First 200 chars: ${text.slice(0, 200)}`,
      );
    }

    // Cache the good response for everyone else's benefit.
    const cacheResponse = new Response(JSON.stringify(data), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `max-age=${CACHE_TTL_SECONDS}`,
      },
    });
    await cache.put(cacheKey, cacheResponse);

    return data;
  }

  // Unreachable in practice, but keeps TypeScript happy.
  throw lastError ?? new Error("GDELT API request failed for an unknown reason.");
}

/**
 * Lowercases, strips punctuation and collapses whitespace so that titles
 * differing only in casing, hyphens/dashes, or a trailing " - SiteName"
 * still compare equal.
 */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Pulls the last non-empty path segment out of a URL. Syndicated copies of
 * the same wire story are frequently published on many different domains
 * (e.g. a dozen local radio station sites) but keep the same unique story
 * ID in the URL path, so this catches duplicates that normalizeTitle alone
 * might miss due to per-site title rewriting.
 */
function extractUrlId(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    return segments[segments.length - 1] ?? parsed.pathname;
  } catch {
    return url;
  }
}

/**
 * Removes duplicate/syndicated articles from a GDELT ArtList result.
 * Two articles are considered the same story if they share a normalized
 * title OR the same trailing URL path segment. Keeps the first (most
 * relevant, since GDELT ArtList preserves sort order) occurrence of each.
 */
function dedupeArticles<T extends { title?: string; url?: string }>(
  articles: T[],
): T[] {
  const seenTitles = new Set<string>();
  const seenUrlIds = new Set<string>();
  const result: T[] = [];

  for (const article of articles) {
    const titleKey = normalizeTitle(article.title ?? "");
    const urlId = article.url ? extractUrlId(article.url) : "";

    const isDuplicate =
      (titleKey.length > 0 && seenTitles.has(titleKey)) ||
      (urlId.length > 0 && seenUrlIds.has(urlId));

    if (isDuplicate) continue;

    if (titleKey.length > 0) seenTitles.add(titleKey);
    if (urlId.length > 0) seenUrlIds.add(urlId);
    result.push(article);
  }

  return result;
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

const searchArticlesInput = z.object({
  query: z
    .string()
    .describe("Search terms, e.g. 'climate summit' or 'Sweden election'"),
  timespan: z
    .string()
    .optional()
    .describe(
      "How far back to search, e.g. '1h', '1d', '7d', '3m'. Defaults to '1d'.",
    ),
  sort: z
    .enum(["DateDesc", "DateAsc", "ToneAsc", "ToneDesc", "HybridRel"])
    .optional()
    .describe("Sort order. Defaults to DateDesc (most recent first)."),
  max_records: z
    .number()
    .int()
    .min(1)
    .max(250)
    .optional()
    .describe("Maximum number of articles to return (1-250). Defaults to 25."),
});

const timelineInput = z.object({
  query: z.string().describe("Search terms to track over time"),
  timespan: z
    .string()
    .optional()
    .describe("How far back to look, e.g. '7d', '1m', '3m'. Defaults to '1m'."),
});

/**
 * Factory that builds a fresh MCP server for each request. This is the
 * pattern required by createMcpHandler on Cloudflare Workers (stateless,
 * one server per request).
 */
function createServer() {
  const server = new McpServer({
    name: "gdelt-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "search_articles",
    {
      description:
        "Search GDELT for recent news articles matching a query. Returns title, url, domain, language, publish date and tone for each match.",
      inputSchema: searchArticlesInput,
    },
    async ({ query, timespan, sort, max_records }) => {
      try {
        const data = await callGdelt({
          query,
          mode: "ArtList",
          format: "json",
          timespan: timespan ?? "1d",
          sort: sort ?? "DateDesc",
          maxrecords: String(max_records ?? 25),
        });

        const articles = (data.articles ?? []).map((a: any) => ({
          title: a.title,
          url: a.url,
          domain: a.domain,
          language: a.language,
          seendate: a.seendate,
          tone: a.tone,
        }));

        const deduped = dedupeArticles(articles);

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(deduped, null, 2) },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "timeline_tone",
    {
      description:
        "Get the daily average sentiment tone (-100 very negative to +100 very positive) for a topic over time, based on GDELT's global news coverage.",
      inputSchema: timelineInput,
    },
    async ({ query, timespan }) => {
      try {
        const data = await callGdelt({
          query,
          mode: "TimelineTone",
          format: "json",
          timespan: timespan ?? "1m",
        });

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(data, null, 2) },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "timeline_volume",
    {
      description:
        "Get the daily news volume (as a % of global news coverage) for a topic over time, based on GDELT's global news monitoring.",
      inputSchema: timelineInput,
    },
    async ({ query, timespan }) => {
      try {
        const data = await callGdelt({
          query,
          mode: "TimelineVolInfo",
          format: "json",
          timespan: timespan ?? "1m",
        });

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(data, null, 2) },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}

// One handler instance at module scope, per Cloudflare's guidance.
const handler = createMcpHandler(createServer, {
  // Restrict who can call this if you later put it behind a custom domain.
  // allowedHostnames: ["gdelt-mcp.yourteam.workers.dev"],
});

export default {
  fetch(request: Request, env: unknown, ctx: ExecutionContext) {
    return handler(request, env, ctx);
  },
} satisfies ExportedHandler;
