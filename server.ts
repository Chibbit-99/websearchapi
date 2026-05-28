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
    const rawResults: { title: string; url: string }[] = [];

    const regex =
      /<a rel="nofollow" class="result__a" href="(.*?)".*?>(.*?)<\/a>/g;

    let match;

    while ((match = regex.exec(html)) && rawResults.length < 5) {
      rawResults.push({
        title: clean(match[2]),
        url: decodeDuckUrl(match[1]),
      });
    }

    // 3. FETCH SNIPPETS FROM EACH PAGE (IMPORTANT PART)
    const results = [];

    for (const r of rawResults) {
      try {
        const snippet = await fetchSnippet(r.url);

        results.push({
          title: r.title,
          url: r.url,
          snippet,
        });
      } catch {
        results.push({
          title: r.title,
          url: r.url,
          snippet: "Failed to fetch snippet",
        });
      }
    }

    return new Response(JSON.stringify({ query, results }), { headers });
  },
};

// -------------------- HELPERS --------------------

function decodeDuckUrl(url: string) {
  const match = url.match(/uddg=([^&]+)/);
  if (!match) return url;
  return decodeURIComponent(match[1]);
}

function clean(html: string) {
  return html.replace(/<.*?>/g, "").trim();
}

// Extract readable text from HTML (simple but effective)
function extractText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Fetch page + build snippet
async function fetchSnippet(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
    },
  });

  const html = await res.text();
  const text = extractText(html);

  // return first 300 chars as snippet
  return text.slice(0, 300);
}
