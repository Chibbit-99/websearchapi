import { DDGS } from "npm:duckduckgo-search";

type SearchResult = {
  title: string;
  snippet: string;
  url: string;
};

async function webSearch(query: string, maxResults = 5): Promise<SearchResult[]> {
  const results: SearchResult[] = [];

  const ddgs = new DDGS();
  const searchResults = await ddgs.text(query, { max_results: maxResults });

  for (const r of searchResults) {
    results.push({
      title: r.title ?? "",
      snippet: r.body ?? "",
      url: r.href ?? "",
    });
  }

  return results;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const query = url.searchParams.get("query");

  // basic CORS (so you can call it from browsers)
  const headers = {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
  };

  if (!query) {
    return new Response(
      JSON.stringify({
        error: "Missing query parameter. Use /?query=your+search",
      }),
      { status: 400, headers }
    );
  }

  try {
    const results = await webSearch(query);

    return new Response(
      JSON.stringify({
        query,
        results,
      }),
      { headers }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: "Search failed",
        details: String(err),
      }),
      { status: 500, headers }
    );
  }
});
