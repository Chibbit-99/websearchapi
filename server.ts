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
        JSON.stringify({ error: "Missing query param: ?query=" }),
        { status: 400, headers }
      );
    }

    const res = await fetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      }
    );

    const html = await res.text();

    // More stable extraction (DuckDuckGo lite uses result__a reliably)
    const results: { title: string; url: string }[] = [];

    const regex =
      /<a rel="nofollow" class="result__a" href="(.*?)".*?>(.*?)<\/a>/g;

    let match;

    while ((match = regex.exec(html)) !== null && results.length < 5) {
      results.push({
        url: match[1],
        title: match[2].replace(/<.*?>/g, "").trim(),
      });
    }

    return new Response(
      JSON.stringify({
        query,
        results,
      }),
      { headers }
    );
  },
};
