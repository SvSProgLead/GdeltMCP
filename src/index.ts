import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

const GDELT_DOC_API = "https://api.gdeltproject.org/api/v2/doc/doc";

/**
 * Small helper so all three tools share the same fetch + error handling logic.
 */
async function callGdelt(params: Record<string, string>) {
  const url = `${GDELT_DOC_API}?${new URLSearchParams(params).toString()}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "gdelt-mcp/1.0 (internal team server)" },
  });

  if (!res.ok) {
    throw new Error(`GDELT API returned ${res.status} ${res.statusText}`);
  }

  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // GDELT occasionally returns an HTML error page (e.g. for malformed
    // queries) instead of JSON even with a 200 status.
    throw new Error(
      `GDELT API did not return valid JSON. First 200 chars: ${text.slice(0, 200)}`,
    );
  }
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

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(articles, null, 2) },
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
