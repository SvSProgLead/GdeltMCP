import { DurableObject, env } from "cloudflare:workers";

/**
 * GDELT DOC 2.0 API client.
 *
 * GDELT allows roughly one request per 5 seconds per client and answers
 * anything faster with a plain-text 429 ("Please limit requests to one every
 * 5 seconds…"), usually without a Retry-After header. So every call:
 *   1. is served from the edge cache when the same query ran recently;
 *   2. otherwise reserves a send slot in the GdeltGate Durable Object, which
 *      spaces calls at least MIN_GAP_MS apart across *all* isolates/users of
 *      this Worker (an in-memory timer alone would only cover one isolate);
 *   3. on 429/5xx retries with exponential backoff (honouring Retry-After),
 *      within a total wait budget so the MCP call doesn't time out.
 *
 * Note: GDELT rate-limits per IP, and Cloudflare egress IPs are shared with
 * other Workers. A 429 can therefore happen even when *we* are well-behaved;
 * that is what the retries are for.
 */

const GDELT_DOC_API = "https://api.gdeltproject.org/api/v2/doc/doc";
const USER_AGENT = "gdelt-mcp/1.1 (+https://github.com/SvSProgLead/GdeltMCP)";

export const MIN_GAP_MS = 5_500;
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 6_000; // 6 s, 12 s, 24 s
/** Longest a 429 may push back *other* callers. */
const MAX_PENALTY_MS = 30_000;
/** Give up once waiting would push the whole call past this. */
const TOTAL_WAIT_BUDGET_MS = 50_000;
const CACHE_TTL_SECONDS = 600;

export type GdeltErrorKind = "rate_limited" | "bad_query" | "upstream_error" | "network" | "bad_response";

export class GdeltError extends Error {
  constructor(public kind: GdeltErrorKind, message: string) {
    super(message);
  }
}

/**
 * Serialises GDELT calls Worker-wide. One instance, addressed by name.
 * The next free slot is persisted in the DO's storage: an idle Durable Object
 * is evicted after a few seconds, and an in-memory value would be lost then.
 */
export class GdeltGate extends DurableObject {
  private async next(): Promise<number> {
    return (await this.ctx.storage.get<number>("nextSlot")) ?? 0;
  }

  /**
   * Reserve the next free send slot; returns how many ms the caller must wait.
   * If that would exceed maxWaitMs, nothing is reserved and the (positive)
   * wait is returned as a negative number so the caller can fail fast.
   */
  async reserve(minGapMs: number, maxWaitMs: number): Promise<number> {
    const now = Date.now();
    const slot = Math.max(now, await this.next());
    if (slot - now > maxWaitMs) return -(slot - now);
    await this.ctx.storage.put("nextSlot", slot + minGapMs);
    return slot - now;
  }

  /** After a 429, push every later caller back too. */
  async penalise(ms: number): Promise<void> {
    await this.ctx.storage.put("nextSlot", Math.max(await this.next(), Date.now() + ms));
  }
}

interface GateEnv {
  GDELT_GATE?: DurableObjectNamespace<GdeltGate>;
}

function gate() {
  const ns = (env as GateEnv).GDELT_GATE;
  return ns ? ns.get(ns.idFromName("gdelt")) : null;
}

// Fallback when the DO binding is missing: per-isolate spacing.
let localNextSlot = 0;

async function waitForSlot(maxWaitMs: number): Promise<void> {
  const g = gate();
  let wait: number;
  if (g) {
    wait = await g.reserve(MIN_GAP_MS, maxWaitMs);
  } else {
    const now = Date.now();
    const slot = Math.max(now, localNextSlot);
    wait = slot - now > maxWaitMs ? -(slot - now) : slot - now;
    if (wait >= 0) localNextSlot = slot + MIN_GAP_MS;
  }
  if (wait < 0) {
    throw new GdeltError(
      "rate_limited",
      `GDELT is cooling down after recent 429 responses (or many queued calls); the next free slot is in ${Math.ceil(-wait / 1000)} s. Retry after that.`,
    );
  }
  if (wait > 0) await sleep(wait);
}

async function penalise(ms: number) {
  ms = Math.min(ms, MAX_PENALTY_MS);
  const g = gate();
  if (g) await g.penalise(ms);
  else localNextSlot = Math.max(localNextSlot, Date.now() + ms);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(h: string | null): number | null {
  if (!h) return null;
  const n = Number(h);
  if (Number.isFinite(n)) return n * 1000;
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : null;
}

export async function callGdelt(params: Record<string, string>): Promise<any> {
  const url = `${GDELT_DOC_API}?${new URLSearchParams(params).toString()}`;
  const cacheKey = new Request(url, { method: "GET" });
  const cache = (caches as unknown as { default: Cache }).default;

  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  const started = Date.now();
  let last: GdeltError | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await waitForSlot(TOTAL_WAIT_BUDGET_MS - (Date.now() - started));

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      last = new GdeltError("network", `Network error or timeout reaching GDELT: ${String(err)}`);
      continue;
    }

    if (res.status === 429 || res.status >= 500) {
      const body = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
      const backoff = Math.max(retryAfterMs(res.headers.get("Retry-After")) ?? 0, BACKOFF_BASE_MS * 2 ** attempt);
      last =
        res.status === 429
          ? new GdeltError(
              "rate_limited",
              `GDELT rate limit (HTTP 429) persisted after ${attempt + 1} attempt(s) over ${Math.round((Date.now() - started) / 1000)} s. GDELT allows ~1 request per 5 s per IP and Cloudflare's egress IPs are shared, so wait a minute and retry. GDELT said: ${body}`,
            )
          : new GdeltError("upstream_error", `GDELT server error (HTTP ${res.status}). ${body}`);
      if (res.status === 429) await penalise(backoff);
      if (attempt < MAX_RETRIES && Date.now() - started + backoff + MIN_GAP_MS < TOTAL_WAIT_BUDGET_MS) {
        await sleep(backoff);
        continue;
      }
      throw last;
    }

    const text = await res.text();
    if (!res.ok) {
      throw new GdeltError("bad_query", `GDELT rejected the request (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }

    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      // GDELT answers query-syntax problems with a 200 and a plain-text
      // message, e.g. "The specified phrase is too short." or
      // "Your search contained a keyword that was too short or too common."
      throw new GdeltError("bad_query", `GDELT did not accept the query: ${text.replace(/\s+/g, " ").slice(0, 200)}`);
    }

    await cache.put(
      cacheKey,
      new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${CACHE_TTL_SECONDS}` },
      }),
    );
    return data;
  }

  throw last ?? new GdeltError("network", "GDELT request failed for an unknown reason.");
}

/**
 * GDELT treats unquoted words as independent keywords, so
 *   electronic warfare  →  any article with "electronic" and "warfare" anywhere.
 * Wrap the plain free-text part in quotes so it is searched as a phrase, while
 * leaving GDELT operators alone:
 *   electronic warfare sourcecountry:sweden  →  "electronic warfare" sourcecountry:sweden
 * Queries that already use quotes, parentheses or OR are passed through as-is.
 */
export function prepareQuery(query: string, exactPhrase = true): string {
  const q = query.trim().replace(/\s+/g, " ");
  if (!exactPhrase || /["()]|\bOR\b/.test(q)) return q;
  const tokens = q.split(" ");
  const isOperator = (t: string) => t.includes(":") || t.startsWith("-") || t === "AND";
  const words = tokens.filter((t) => !isOperator(t));
  const ops = tokens.filter(isOperator).filter((t) => t !== "AND");
  if (words.length < 2) return q;
  return [`"${words.join(" ")}"`, ...ops].join(" ");
}
