import { parseHTML } from "npm:linkedom";
import { Readability } from "npm:@mozilla/readability";

type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const query = url.searchParams.get("query");

    const headers = {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    };

    if (!query) {
      return new Response(
        JSON.stringify({ error: "Missing ?query=" }),
        { status: 400, headers }
      );
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

    // 2. EXTRACT + DECODE URLS
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

    // 3. FETCH + READABILITY PARSING (THE IMPORTANT PART)
    const results = await Promise.allSettled(
      raw.map(async (r) => {
        const pageRes = await fetch(r.url, {
          headers: {
            "user-agent": "Mozilla/5.0",
          },
        });

        const pageHtml = await pageRes.text();

        // Convert HTML → DOM
        const { document } = parseHTML(pageHtml);

        // Run Mozilla Readability (THIS is the “Reader Mode” engine)
        const reader = new Readability(document);
        const article = reader.parse();

        let snippet = "";

        if (article?.textContent) {
          snippet = smartTrim(article.textContent);
        } else {
          snippet = "No readable content extracted";
        }

        return {
          title: r.title,
          url: r.url,
          snippet,
        };
      })
    );

    // 4. CLEAN OUTPUT
    const finalResults = results
      .filter((r): r is PromiseFulfilledResult<SearchResult> => r.status === "fulfilled")
      .map((r) => r.value);

    return new Response(
      JSON.stringify({
        query,
        results: finalResults,
      }),
      { headers }
    );
  },
};

// ---------------- HELPERS ----------------

function decodeDuckUrl(url: string) {
  const match = url.match(/uddg=([^&]+)/);
  if (!match) return url;
  return decodeURIComponent(match[1]);
}

function clean(html: string) {
  return html.replace(/<.*?>/g, "").trim();
}

// “AI-like snippet compression”
function smartTrim(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .split(". ")
    .slice(0, 3) // take first few meaningful sentences
    .join(". ")
    .slice(0, 500);
}
