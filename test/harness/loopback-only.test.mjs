import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { isForeignRequest } from "../../src/generic-proxy.mjs";
import { startProxy } from "../../src/proxy.mjs";

test("only loopback hosts without a foreign origin are accepted", () => {
  assert.equal(isForeignRequest({ host: "127.0.0.1:4100" }, 4100), false);
  assert.equal(isForeignRequest({ host: "localhost:4100" }, 4100), false);
  assert.equal(isForeignRequest({ host: "127.0.0.1:4100", origin: "http://127.0.0.1:4100" }, 4100), false);
  assert.equal(isForeignRequest({ host: "rebound.example:4100" }, 4100), true, "DNS rebinding");
  assert.equal(isForeignRequest({ host: "127.0.0.1:9999" }, 4100), true);
  assert.equal(isForeignRequest({}, 4100), true);
  assert.equal(isForeignRequest({ host: "127.0.0.1:4100", origin: "https://evil.example" }, 4100), true, "cross-site POST");
  assert.equal(isForeignRequest({ host: "127.0.0.1:4100", origin: "null" }, 4100), true);
});

test("the proxy refuses a rebound or cross-site request before it reaches upstream or Jev", async (t) => {
  let upstreamHits = 0;
  const upstream = http.createServer((req, res) => {
    upstreamHits++;
    req.resume();
    req.on("end", () => res.end("{}"));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  let routeCalls = 0;
  const { port, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async () => (routeCalls++, null),
  });
  t.after(close);

  const send = (headers) =>
    new Promise((resolve, reject) => {
      const body = JSON.stringify({ model: "jev-router", tools: [{ name: "Bash" }], messages: [{ role: "user", content: "hi" }] });
      const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/v1/messages", headers: { "content-type": "text/plain", ...headers } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject);
      req.end(body);
    });

  assert.equal(await send({ host: `rebound.example:${port}` }), 403);
  assert.equal(await send({ origin: "https://evil.example" }), 403);
  assert.equal(upstreamHits, 0);
  assert.equal(routeCalls, 0);

  assert.equal(await send({}), 200, "the CLI's own request still goes through");
  assert.equal(upstreamHits, 1);
});
