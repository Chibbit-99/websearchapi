// main.ts
import { parseHTML } from "npm:linkedom";
import { Readability } from "npm:@mozilla/readability";

type SearchItem = {
  title: string;
  url: string;
  displayUrl: string;
  snippet: string;
  source: string;
  language?: string;
  score: number;
};

type ApiResponse = {
  query: string;
  results: SearchItem[];
  answer: string;
  context: string;
  cached: boolean;
};

const kv = await Deno.openKv();

const CORS_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const input = await readInput(req);
  const query = input.query.trim();

  if (!query) {
    return json({ error: "Missing query. Use ?query=iphone or POST {\"query\":\"iphone\"}" }, 400);
  }

  const cacheKey = ["search", normalizeQuery(query), input.lang, input.limit] as const;
  const cached = await kv.get<ApiResponse>(cacheKey);

  if (cached.value) {
    return json({ ...cached.value, cached: true });
  }

  const rawResults = await searchDuckDuckGo(query, input.limit, input.lang);
  const fetched = await enrichResults(rawResults, query, input.lang);

  const ranked = fetched
    .filter((x) => x.score > 0 || x.snippet.length > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, input.limit);

  const context = buildContext(ranked);
  const answer = buildExtractiveAnswer(ranked, query);

  const payload: ApiResponse = {
    query,
    results: ranked,
    answer,
    context,
    cached: false,
  };

  await kv.set(cacheKey, payload, { expireIn: 1000 * 60 * 15 });

  return json(payload);
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

  const query = String(url.searchParams.get("query") ?? body.query ?? "");
  const limit = clampInt(url.searchParams.get("limit"), 5, 1, 10);
  const lang = String(url.searchParams.get("lang") ?? body.lang ?? "en").toLowerCase().trim();

  return { query, limit, lang };
}

async function searchDuckDuckGo(query: string, limit: number, lang: string) {
  const q = lang === "en" ? `${query} lang:en` : query;

  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "accept-language": lang === "en" ? "en-US,en;q=0.9" : `${lang},en;q=0.6`,
    },
  });

  const html = await res.text();
  const results: { title: string; url: string; displayUrl: string }[] = [];

  const regex =
    /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) && results.length < limit * 3) {
    const url = decodeDuckUrl(match[1]);
    const title = stripTags(match[2]);

    if (!url || !title) continue;
    if (isBadUrl(url)) continue;

    results.push({
      title,
      url,
      displayUrl: safeDisplayUrl(url),
    });
  }

  return dedupeByUrl(results).slice(0, limit);
}

async function enrichResults(
  items: { title: string; url: string; displayUrl: string }[],
  query: string,
  lang: string,
): Promise<SearchItem[]> {
  const concurrency = 3;
  const out: SearchItem[] = [];

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);

    const batchResults = await Promise.allSettled(
      batch.map(async (item) => {
        const cacheKey = ["page", item.url] as const;
        const cached = await kv.get<{ snippet: string; language: string }>(cacheKey);

        if (cached.value) {
          return {
            title: item.title,
            url: item.url,
            displayUrl: item.displayUrl,
            snippet: cached.value.snippet,
            language: cached.value.language,
            source: "cache",
            score: scoreDocument(cached.value.snippet, query),
          } satisfies SearchItem;
        }

        const page = await fetchWithTimeout(item.url, 12000);
        const contentType = page.headers.get("content-type") ?? "";

        if (!page.ok) {
          return {
            title: item.title,
            url: item.url,
            displayUrl: item.displayUrl,
            snippet: "",
            source: `http_${page.status}`,
            score: 0,
          } satisfies SearchItem;
        }

        if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
          return {
            title: item.title,
            url: item.url,
            displayUrl: item.displayUrl,
            snippet: "",
            source: "non_html",
            score: 0,
          } satisfies SearchItem;
        }

        const html = await page.text();
        const articleText = extractReadableText(html, item.url);

        if (!articleText) {
          return {
            title: item.title,
            url: item.url,
            displayUrl: item.displayUrl,
            snippet: "",
            source: "unreadable",
            score: 0,
          } satisfies SearchItem;
        }

        const detected = detectLanguage(articleText);
        if (lang === "en" && detected !== "en") {
          return {
            title: item.title,
            url: item.url,
            displayUrl: item.displayUrl,
            snippet: "",
            language: detected,
            source: "non_english_skipped",
            score: 0,
          } satisfies SearchItem;
        }

        const snippet = makeSnippet(articleText, query);
        const score = scoreDocument(snippet || articleText, query);

        await kv.set(cacheKey, { snippet, language: detected }, { expireIn: 1000 * 60 * 60 * 24 });

        return {
          title: item.title,
          url: item.url,
          displayUrl: item.displayUrl,
          snippet,
          language: detected,
          source: "fetched",
          score,
        } satisfies SearchItem;
      }),
    );

    for (const r of batchResults) {
      if (r.status === "fulfilled") out.push(r.value);
    }
  }

  return out;
}

function extractReadableText(html: string, pageUrl: string): string {
  const { document } = parseHTML(html);
  try {
    const reader = new Readability(document, { uri: pageUrl });
    const article = reader.parse();

    if (article?.textContent) {
      return cleanText(article.textContent);
    }
  } catch {
    // fall through to fallback extraction
  }

  const fallback = cleanText(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
      .replace(/<header[\s\S]*?<\/header>/gi, " ")
      .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
      .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  );

  return fallback.length > 200 ? fallback : "";
}

function makeSnippet(text: string, query: string): string {
  const sentences = splitSentences(cleanText(text));

  const scored = sentences
    .map((s) => ({ text: s, score: sentenceScore(s, query) }))
    .filter((x) => x.text.length >= 40)
    .sort((a, b) => b.score - a.score);

  const chosen: string[] = [];
  for (const item of scored) {
    if (chosen.length >= 3) break;
    if (chosen.some((c) => overlap(c, item.text) > 0.7)) continue;
    chosen.push(item.text);
  }

  if (!chosen.length) {
    return cleanText(text).slice(0, 400);
  }

  return chosen.join(" ").slice(0, 500);
}

function buildContext(results: SearchItem[]): string {
  return results
    .map((r, i) => {
      return [
        `[${i + 1}] ${r.title}`,
        `URL: ${r.url}`,
        `Host: ${hostFromUrl(r.url)}`,
        `Snippet: ${r.snippet || "(no snippet)"}`,
      ].join("\n");
    })
    .join("\n\n")
    .slice(0, 12000);
}

function buildExtractiveAnswer(results: SearchItem[], query: string): string {
  const top = results.filter((r) => r.snippet).slice(0, 3);
  if (!top.length) return `I could not find readable English results for "${query}".`;

  const joined = top.map((r) => r.snippet).join(" ");
  return summarizeText(joined).slice(0, 700);
}

function summarizeText(text: string): string {
  const sentences = splitSentences(cleanText(text));
  if (!sentences.length) return "";

  return sentences
    .sort((a, b) => b.length - a.length)
    .slice(0, 3)
    .join(" ");
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

  let score = 0;
  const qSet = new Set(qWords);

  for (const w of sWords) {
    if (qSet.has(w)) score += 3;
  }

  const lower = sentence.toLowerCase();
  if (sentence.length >= 60 && sentence.length <= 220) score += 2;
  if (/[A-Z]/.test(sentence[0] ?? "")) score += 1;
  if (/\d/.test(sentence)) score += 1;

  const boostWords = [
    "is",
    "was",
    "are",
    "released",
    "developed",
    "defined",
    "means",
    "announced",
    "supports",
    "available",
    "includes",
  ];
  for (const w of boostWords) {
    if (lower.includes(w)) score += 1;
  }

  return score;
}

function scoreDocument(text: string, query: string): number {
  const sentences = splitSentences(text);
  if (!sentences.length) return 0;

  const top = Math.max(...sentences.map((s) => sentenceScore(s, query)));
  const queryHits = overlapWords(text, query);
  return top + Math.min(8, queryHits * 2);
}

function overlapWords(text: string, query: string): number {
  const t = new Set(tokenize(text));
  let hits = 0;
  for (const q of tokenize(query)) {
    if (t.has(q)) hits++;
  }
  return hits;
}

function overlap(a: string, b: string): number {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  let common = 0;
  for (const x of A) if (B.has(x)) common++;
  return common / Math.max(1, Math.min(A.size, B.size));
}

function tokenize(text: string): string[] {
  return cleanText(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

function detectLanguage(text: string): string {
  const sample = cleanText(text).slice(0, 2000).toLowerCase();

  const en = [" the ", " and ", " of ", " to ", " in ", " for ", " with ", " is ", " that "];
  const nl = [" de ", " het ", " en ", " van ", " voor ", " met ", " is ", " dat ", " een "];
  const es = [" el ", " la ", " de ", " y ", " que ", " en ", " para ", " con ", " es "];

  const score = (words: string[]) => words.reduce((n, w) => n + (sample.includes(w) ? 1 : 0), 0);

  const enScore = score(en);
  const nlScore = score(nl);
  const esScore = score(es);

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

function dedupeByUrl(items: { title: string; url: string; displayUrl: string }[]) {
  const seen = new Set<string>();
  const out: { title: string; url: string; displayUrl: string }[] = [];
  for (const item of items) {
    const key = canonicalUrl(item.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    if (u.pathname !== "/" && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return url;
  }
}

function safeDisplayUrl(url: string): string {
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
  const bad = [
    "duckduckgo.com",
    "google.com/search",
    "bing.com/search",
  ];
  try {
    const h = new URL(url).hostname;
    return bad.some((x) => h.includes(x));
  } catch {
    return true;
  }
}

function cleanText(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(html: string): string {
  return cleanText(html.replace(/<[^>]+>/g, " "));
}

function normalizeQuery(q: string): string {
  return cleanText(q).toLowerCase();
}

function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: CORS_HEADERS,
  });
}
