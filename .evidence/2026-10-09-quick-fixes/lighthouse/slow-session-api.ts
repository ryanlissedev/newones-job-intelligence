// Stand-in for the API during the PR3 Lighthouse runs. It answers only what
// /jobs and /login call before any sign-in: get-session, after the 750 ms the
// browser trace measured in production (650–800 ms of network and preflight;
// the server itself answers in ~4 ms), with no session. Everything else is a
// 404. Both the base and the head build talk to this same stub.
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:3001";
const SESSION_DELAY_MS = Number(process.env.SESSION_DELAY_MS ?? "750");

const cors = {
  "access-control-allow-credentials": "true",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-origin": WEB_ORIGIN,
};

Bun.serve({
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors, status: 204 });
    }
    if (pathname === "/health") {
      return new Response("ok", { headers: cors });
    }
    if (pathname === "/api/auth/get-session") {
      await Bun.sleep(SESSION_DELAY_MS);
      return Response.json(null, { headers: cors });
    }
    return new Response("not found", { headers: cors, status: 404 });
  },
  port: Number(process.env.PORT ?? "3100"),
});
