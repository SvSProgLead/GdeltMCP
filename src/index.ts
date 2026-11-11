import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { callGdelt, GdeltError, prepareQuery } from "./gdelt";

export { GdeltGate } from "./gdelt";

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
  const kind = err instanceof GdeltError ? err.kind : "internal";
  return {
    content: [{ type: "text" as const, text: `Error (${kind}): ${message}` }],
    isError: true,
  };
}

/**
 * ArtList does not carry a tone per article. ToneChart does: it buckets the
 * matching articles by tone (-100..+100, in integer bins) and lists the top
 * articles of each bin. Map URL -> bin so search_articles can attach an
 * approximate tone to the articles that appear there.
 */
async function toneByUrl(params: Record<string, string>): Promise<Map<string, number>> {
  const data = await callGdelt({ ...params, mode: "ToneChart" });
  const map = new Map<string, number>();
  for (const bin of data?.tonechart ?? []) {
    for (const art of bin?.toparts ?? []) {
      if (art?.url && typeof bin.bin === "number") map.set(art.url, bin.bin);
    }
  }
  return map;
}

const exactPhraseField = z
  .boolean()
  .optional()
  .describe(
    "Default true: plain multi-word input is searched as one exact phrase (electronic warfare -> \"electronic warfare\"); GDELT operators like sourcecountry:sweden are kept outside the quotes. Set false to match the words independently. Queries that already contain quotes, parentheses or OR are never changed.",
  );

const searchArticlesInput = z.object({
  query: z
    .string()
    .describe(
      "Search terms, e.g. 'electronic warfare' or 'drone swarm sourcecountry:ukraine'. Supports GDELT operators (sourcecountry:, sourcelang:, domain:, theme:, OR, -exclude).",
    ),
  exact_phrase: exactPhraseField,
  timespan: z
    .string()
    .optional()
    .describe(
      "How far back to search, e.g. '1h', '1d', '7d', '3m'. Defaults to '1d'.",
    ),
  sort: z
    .enum(["DateDesc", "DateAsc", "ToneAsc", "ToneDesc", "HybridRel"])
    .optional()
    .describe("Sort order. Defaults to HybridRel (relevance weighted by recency); DateDesc = newest first."),
  max_records: z
    .number()
    .int()
    .min(1)
    .max(250)
    .optional()
    .describe("Maximum number of articles to return (1-250). Defaults to 25."),
  include_tone: z
    .boolean()
    .optional()
    .describe(
      "Also fetch GDELT's ToneChart and attach an approximate tone (integer bin, -100..+100) to articles listed there. Costs one extra GDELT call (~5 s). Default false.",
    ),
});

const timelineInput = z.object({
  query: z.string().describe("Search terms to track over time (GDELT operators allowed)."),
  exact_phrase: exactPhraseField,
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
    version: "1.1.0",
  });

  server.registerTool(
    "search_articles",
    {
      description:
        "Search GDELT for recent news articles matching a query. Returns title, url, domain, language, source country and seen date per article (syndicated duplicates removed). Multi-word input is searched as an exact phrase by default. Tone is only included when include_tone=true (approximate, from GDELT's ToneChart); for tone over time use timeline_tone. Calls are spaced >=5 s apart because of GDELT's rate limit, so expect a few seconds' latency.",
      inputSchema: searchArticlesInput,
    },
    async ({ query, exact_phrase, timespan, sort, max_records, include_tone }) => {
      try {
        const base = { query: prepareQuery(query, exact_phrase ?? true), format: "json", timespan: timespan ?? "1d" };
        const data = await callGdelt({
          ...base,
          mode: "ArtList",
          sort: sort ?? "HybridRel",
          maxrecords: String(max_records ?? 25),
        });

        let tones: Map<string, number> | null = null;
        let toneNote: string | undefined;
        if (include_tone) {
          try {
            tones = await toneByUrl(base);
          } catch (err) {
            toneNote = `tone unavailable: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        const articles = (data.articles ?? []).map((a: any) => ({
          title: a.title,
          url: a.url,
          domain: a.domain,
          language: a.language,
          sourcecountry: a.sourcecountry,
          seendate: a.seendate,
          ...(tones ? { tone: tones.get(a.url) ?? null } : {}),
        }));

        const deduped = dedupeArticles(articles);
        const payload = {
          query_sent: base.query,
          count: deduped.length,
          ...(tones ? { tone_note: "tone = GDELT ToneChart bin; null if the article is not among ToneChart's top articles" } : {}),
          ...(toneNote ? { tone_note: toneNote } : {}),
          articles: deduped,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
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
    async ({ query, exact_phrase, timespan }) => {
      try {
        const data = await callGdelt({
          query: prepareQuery(query, exact_phrase ?? true),
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
    async ({ query, exact_phrase, timespan }) => {
      try {
        const data = await callGdelt({
          query: prepareQuery(query, exact_phrase ?? true),
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
