const body = "x".repeat(100_000);
Bun.serve({ port: 4567, fetch: () => new Response(body, { headers: { "content-type": "text/html" } }) });
