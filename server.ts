export default {
  async fetch(req: Request) {
    const url = new URL(req.url);
    const query = url.searchParams.get("query");

    const headers = {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    };

    if (!query) {
      return new Response(JSON.stringify({ error: "missing query" }), {
        status: 400,
        headers,
      });
    }

    const res = await fetch(
      `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`
    );

    const html = await res.text();

    // VERY simple extraction (title + links)
    const results = [...html.matchAll(/<a rel="nofollow" class="result__a" href="(.*?)".*?>(.*?)<\/a>/g)]
      .slice(0, 5)
      .map((m) => ({
        url: m[1],
        title: m[2].replace(/<.*?>/g, ""),
      }));

    return new Response(
      JSON.stringify({ query, results }),
      { headers }
    );
  },
};
