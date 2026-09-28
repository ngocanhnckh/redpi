// Test-only (never loaded by RedPi): sends the real `jg` CLI's Jev requests for its four
// provider endpoints to a local fake Jev at JEV_TEST_ORIGIN. Same idea as Jevgrep's own
// test/fixtures/provider-route.mjs (MIT).
const endpoints = new Set([
  "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
  "https://api.typesafe.ai/v1/systemone",
  "https://openrouter.ai/api/v1/systemone",
  "https://opencode.ai/zen/v1/systemone",
]);
if (process.env.JEV_TEST_ORIGIN) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (!endpoints.has(url.href)) throw new Error(`Unexpected provider destination: ${url.href}`);
    const headers = new Headers(init?.headers);
    headers.set("x-original-url", url.href);
    return original(new URL(url.pathname, process.env.JEV_TEST_ORIGIN), { ...init, headers });
  };
}
