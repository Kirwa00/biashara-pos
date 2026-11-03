// Edge entry for the web app: API calls go to the API Worker over a service binding, so the SPA,
// the API and their cookies share one origin on workers.dev today and on app.<domain> later. Everything else is the built SPA.
export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/v1/") || pathname === "/health") return env.API.fetch(request);
    return env.ASSETS.fetch(request);
  },
};
