// main.ts
type Result = {
  title: string;
  url: string;
  displayUrl: string;
  snippet: string;
  language: string;
  score: number;
  source: string;
};

type ResponsePayload = {
  query: string;
  cached: boolean;
  results: Result[];
  answer: string;
  context: string;
};

const memoryCache = new Map<string, { expires: number; value: ResponsePayload }>();

const CORS_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const { query, limit, lang } = await readInput(req);
  if (!query) {
    return json({ error: "Missing query. Use ?query=iphone or POST {\"query\":\"iphone\"}" }, 400);
  }

  const cacheKey = `${normalize(query)}|${limit}|${lang}`;
  const cached = memoryCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return json({ ...cached.value, cached: true });
  }

  try {
    const searchResults = await searchDuckDuckGo(query, limit, lang);
    const enriched = await enrichResults(searchResults, query, lang);

    const results = enriched
      .filter((r) => r.snippet.length > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    const context = buildContext(results);
    const answer = buildAnswer(results, query);

    const payload: ResponsePayload = {
      query,
      cached: false,
      results,
      answer,
      context,
    };

    memoryCache.set(cacheKey, {
      expires: Date.now() + 1000 * 60 * 10,
      value: payload,
    });

    return json(payload);
  } catch (err) {
    return json(
      {
        error: "Search failed",
        details: String(err),
      },
      500,
    );
  }
});

async function readInput(req: Request): Promise<{ query: string; limit: number; lang: string }> {
  const url = new URL(req.url);

  let body: any = {};
  if (req.method === "POST") {
    try {
      body = await req.json();
    } catch {
      body = {};
    }
  }

  const query = String(url.searchParams.get("query") ?? body.query ?? "").trim();
  const limit = clampInt(url.searchParams.get("limit"), 5, 1, 10);
  const lang = String(url.searchParams.get("lang") ?? body.lang ?? "en").toLowerCase().trim();

  return { query, limit, lang };
}

async function searchDuckDuckGo(query: string, limit: number, lang: string) {
  const q = lang === "en" ? `${query} lang:en` : query;
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;

  const res = await fetch(searchUrl, {
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "accept-language": lang === "en" ? "en-US,en;q=0.9" : `${lang},en;q=0.6`,
    },
  });

  const html = await res.text();
  const items: { title: string; url: string; displayUrl: string }[] = [];

  const regex = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(html)) && items.length < limit * 3) {
    const url = decodeDuckUrl(match[1]);
    const title = stripTags(match[2]);

    if (!url || !title) continue;
    if (isBadUrl(url)) continue;

    items.push({
      title,
      url,
      displayUrl: displayUrl(url),
    });
  }

  return dedupe(items).slice(0, limit);
}

async function enrichResults(
  items: { title: string; url: string; displayUrl: string }[],
  query: string,
  lang: string,
): Promise<Result[]> {
  const out: Result[] = [];

  for (const item of items) {
    try {
      const pageRes = await fetchWithTimeout(item.url, 12000);
      if (!pageRes.ok) {
        out.push({
          title: item.title,
          url: item.url,
          displayUrl: item.displayUrl,
          snippet: "",
          language: "unknown",
          score: 0,
          source: `http_${pageRes.status}`,
        });
        continue;
      }

      const contentType = pageRes.headers.get("content-type") ?? "";
      if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
        out.push({
          title: item.title,
          url: item.url,
          displayUrl: item.displayUrl,
          snippet: "",
          language: "unknown",
          score: 0,
          source: "non_html",
        });
        continue;
      }

      const html = await pageRes.text();
      const text = extractReadableText(html);

      if (!text) {
        out.push({
          title: item.title,
          url: item.url,
          displayUrl: item.displayUrl,
          snippet: "",
          language: "unknown",
          score: 0,
          source: "unreadable",
        });
        continue;
      }

      const language = detectLanguage(text);
      if (lang === "en" && language !== "en") {
        continue;
      }

      const snippet = makeSnippet(text, query);
      const score = scoreText(snippet || text, query);

      out.push({
        title: item.title,
        url: item.url,
        displayUrl: item.displayUrl,
        snippet,
        language,
        score,
        source: "fetched",
      });
    } catch {
      out.push({
        title: item.title,
        url: item.url,
        displayUrl: item.displayUrl,
        snippet: "",
        language: "unknown",
        score: 0,
        source: "fetch_failed",
      });
    }
  }

  return out;
}

function extractReadableText(html: string): string {
  const title = metaContent(html, "description") || metaContent(html, "og:description") || "";
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
    .replace(/<form[\s\S]*?<\/form>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

  const combined = [title, body].filter(Boolean).join(" ").trim();
  return combined.length >= 80 ? combined : "";
}

function makeSnippet(text: string, query: string): string {
  const sentences = splitSentences(clean(text));
  const ranked = sentences
    .map((s) => ({ text: s, score: sentenceScore(s, query) }))
    .filter((x) => x.text.length >= 30)
    .sort((a, b) => b.score - a.score);

  const chosen: string[] = [];
  for (const item of ranked) {
    if (chosen.length >= 3) break;
    if (chosen.some((c) => overlap(c, item.text) > 0.75)) continue;
    chosen.push(item.text);
  }

  return (chosen.length ? chosen.join(" ") : clean(text).slice(0, 400)).slice(0, 500);
}

function buildAnswer(results: Result[], query: string): string {
  const blacklist = [
    "external links",
    "navigation",
    "main menu",
    "official website",
    "v t e",
    "privacy policy",
    "terms of use",
    "skip to content",
    "sign in",
    "subscribe",
    "cookie",
    "all rights reserved",
  ];

  // Combine snippets
  const allText = results
    .map((r) => r.snippet)
    .filter(Boolean)
    .join(" ");

  if (!allText.trim()) {
    return `No reliable information found for "${query}".`;
  }

  // Split into sentences
  let sentences = allText
    .split(/(?<=[.!?])\s+/)
    .map((s) => clean(s))
    .filter(Boolean);

  // Remove garbage / nav text
  sentences = sentences.filter((s) => {
    const lower = s.toLowerCase();

    if (s.length < 40) return false;

    for (const bad of blacklist) {
      if (lower.includes(bad)) return false;
    }

    // remove super noisy sentences
    const capsRatio =
      (s.match(/[A-Z]/g)?.length ?? 0) / Math.max(1, s.length);

    if (capsRatio > 0.35) return false;

    return true;
  });

  // Rank sentences
  const ranked = sentences
    .map((s) => ({
      text: s,
      score: sentenceScore(s, query),
    }))
    .sort((a, b) => b.score - a.score);

  // Deduplicate overlapping sentences
  const chosen: string[] = [];

  for (const item of ranked) {
    if (chosen.length >= 5) break;

    const tooSimilar = chosen.some(
      (existing) => overlap(existing, item.text) > 0.75,
    );

    if (!tooSimilar) {
      chosen.push(item.text);
    }
  }

  // Final compression
  return chosen
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

function summarize(text: string): string {
  const sentences = splitSentences(clean(text));
  if (!sentences.length) return "";
  return sentences.sort((a, b) => b.length - a.length).slice(0, 3).join(" ");
}

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function sentenceScore(sentence: string, query: string): number {
  const qWords = tokenize(query);
  const sWords = tokenize(sentence);
  const qSet = new Set(qWords);

  let score = 0;
  for (const w of sWords) if (qSet.has(w)) score += 3;

  const lower = sentence.toLowerCase();
  if (sentence.length >= 60 && sentence.length <= 220) score += 2;
  if (/\d/.test(sentence)) score += 1;
  if (/[A-Z]/.test(sentence[0] ?? "")) score += 1;

  for (const w of ["is", "was", "are", "released", "developed", "defined", "means", "announced", "supports", "available", "includes"]) {
    if (lower.includes(w)) score += 1;
  }

  return score;
}

function scoreText(text: string, query: string): number {
  return Math.max(...splitSentences(text).map((s) => sentenceScore(s, query)).concat([0]));
}

function detectLanguage(text: string): string {
  const sample = clean(text).slice(0, 2000).toLowerCase();

  const en = [" the ", " and ", " of ", " to ", " in ", " for ", " with ", " is ", " that "];
  const nl = [" de ", " het ", " en ", " van ", " voor ", " met ", " is ", " dat ", " een "];
  const es = [" el ", " la ", " de ", " y ", " que ", " en ", " para ", " con ", " es "];

  const count = (words: string[]) => words.reduce((n, w) => n + (sample.includes(w) ? 1 : 0), 0);

  const enScore = count(en);
  const nlScore = count(nl);
  const esScore = count(es);

  if (enScore >= nlScore && enScore >= esScore) return "en";
  if (nlScore >= esScore) return "nl";
  return "es";
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "accept-language": "en-US,en;q=0.9",
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

function decodeDuckUrl(url: string): string {
  try {
    const u = new URL(url.startsWith("http") ? url : `https:${url}`);
    const uddg = u.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    return u.toString();
  } catch {
    return url;
  }
}

function metaContent(html: string, name: string): string {
  const patterns = [
    new RegExp(`<meta[^>]+name=["']${escapeRegExp(name)}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+property=["']${escapeRegExp(name)}["'][^>]+content=["']([^"']+)["']`, "i"),
  ];

  for (const p of patterns) {
    const m = html.match(p);
    if (m?.[1]) return decodeEntities(m[1]);
  }

  return "";
}

function dedupe(items: { title: string; url: string; displayUrl: string }[]) {
  const seen = new Set<string>();
  const out: typeof items = [];
  for (const item of items) {
    const key = canonical(item.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function canonical(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    if (u.pathname !== "/" && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return url;
  }
}

function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.replace(/\/$/, "");
  } catch {
    return url;
  }
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function isBadUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return ["duckduckgo.com", "google.com", "bing.com"].some((x) => h.includes(x));
  } catch {
    return true;
  }
}

function clean(text: string): string {
  return decodeEntities(text).replace(/\s+/g, " ").trim();
}

function stripTags(html: string): string {
  return clean(html.replace(/<[^>]+>/g, " "));
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function tokenize(text: string): string[] {
  return clean(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((s) => s.length >= 2);
}

function overlap(a: string, b: string): number {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  let common = 0;
  for (const x of A) if (B.has(x)) common++;
  return common / Math.max(1, Math.min(A.size, B.size));
}

function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalize(q: string): string {
  return clean(q).toLowerCase();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: CORS_HEADERS,
  });
}
