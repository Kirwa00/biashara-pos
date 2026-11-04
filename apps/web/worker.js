// Edge entry for the web app: API calls go to the API Worker over a service binding, so the SPA,
// the API and their cookies share one origin. http and www redirect to the main https address; everything else is the built SPA.
const MAIN_HOST = "biasharapos.com";

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    const isWww = url.hostname === `www.${MAIN_HOST}`;
    if (isWww || (url.protocol === "http:" && url.hostname !== "localhost")) {
      if (isWww) url.hostname = MAIN_HOST;
      url.protocol = "https:";
      return Response.redirect(url.toString(), 308);
    }
    const { pathname } = url;
    if (pathname.startsWith("/v1/") || pathname === "/health") return env.API.fetch(request);
    return env.ASSETS.fetch(request);
  },
};
