import { parseHTML } from "npm:linkedom";
import { Readability } from "npm:@mozilla/readability";

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const query = url.searchParams.get("query");

    const headers = {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    };

    if (!query) {
      return new Response(JSON.stringify({ error: "Missing query" }), {
        status: 400,
        headers,
      });
    }

    // 1. SEARCH
    const searchRes = await fetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      {
        headers: {
          "user-agent": "Mozilla/5.0",
        },
      }
    );

    const html = await searchRes.text();

    // 2. EXTRACT RESULTS
    const raw: { title: string; url: string }[] = [];

    const regex =
      /<a rel="nofollow" class="result__a" href="(.*?)".*?>(.*?)<\/a>/g;

    let match;

    while ((match = regex.exec(html)) && raw.length < 5) {
      raw.push({
        title: clean(match[2]),
        url: decodeDuckUrl(match[1]),
      });
    }

    // 3. FETCH + PROCESS PAGES
    const results = await Promise.allSettled(
      raw.map(async (r) => {
        const page = await fetch(r.url, {
          headers: {
            "user-agent": "Mozilla/5.0",
          },
        });

        const pageHtml = await page.text();

        const { document } = parseHTML(pageHtml);
        const reader = new Readability(document);
        const article = reader.parse();

        let text = article?.textContent ?? "";

        // 🧠 FILTER OUT NON-ENGLISH (simple heuristic)
        if (!looksEnglish(text)) {
          throw new Error("Non-English content skipped");
        }

        const snippet = compressText(text);

        return {
          title: r.title,
          url: r.url,
          snippet,
        };
      })
    );

    const finalResults = results
      .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled")
      .map((r) => r.value);

    return new Response(
      JSON.stringify({ query, results: finalResults }),
      { headers }
    );
  },
};

// ---------------- HELPERS ----------------

function decodeDuckUrl(url: string) {
  const match = url.match(/uddg=([^&]+)/);
  return match ? decodeURIComponent(match[1]) : url;
}

function clean(text: string) {
  return text.replace(/<.*?>/g, "").trim();
}

function looksEnglish(text: string): boolean {
  if (!text) return false;

  const sample = text.slice(0, 500);

  // heuristic: count common English words
  const englishWords = [
    "the",
    "is",
    "and",
    "to",
    "of",
    "in",
    "for",
    "with",
    "on",
    "this",
    "it",
    "by",
  ];

  const lower = sample.toLowerCase();
  const score = englishWords.reduce((acc, w) => acc + (lower.includes(w) ? 1 : 0), 0);

  return score >= 3;
}

function compressText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .split(". ")
    .map(scoreSentence)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((s) => s.text)
    .join(". ")
    .slice(0, 450);
}

function scoreSentence(sentence: string) {
  const keywords = [
    "is",
    "are",
    "was",
    "definition",
    "means",
    "released",
    "developed",
    "used",
    "known",
  ];

  let score = 0;

  const lower = sentence.toLowerCase();

  if (sentence.length > 40 && sentence.length < 200) score += 2;

  for (const k of keywords) {
    if (lower.includes(k)) score += 2;
  }

  return { text: sentence, score };
}
