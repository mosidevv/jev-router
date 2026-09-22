import http from "node:http";
import https from "node:https";
import { writeFileSync } from "node:fs";
import { availableTiers, shouldUseExactModel } from "./lib/config.mjs";
import { askJev } from "./lib/router.mjs";
import { decide } from "./lib/policy.mjs";
import { log } from "./lib/log.mjs";
import { writeDecision, writeStatus } from "./lib/status.mjs";

const debug = (line) => process.env.JEV_DEBUG && log(line);

/**
 * Generic proxy that accepts a harness adapter.
 *
 * Each harness (Claude, Codex, Agent Orchestrator, etc.) has a different wire protocol
 * for requests and responses. This proxy parametrizes the routing logic — the eight-step
 * pipeline that appears in both proxy.mjs and codex-proxy.mjs — and delegates the protocol
 * details to an adapter.
 *
 * The adapter must provide:
 *
 *   - isRoutingRequest(req, body) → boolean: Is this a turn we should route?
 *   - conversationKey(body) → string: Stable identifier for deduping the conversation.
 *   - newTurnPrompt(body) → string | null: The user's prompt, or null for tool continuations.
 *   - getModels(catalog) → {id, tier, description}[]: Available models for this harness.
 *   - applyTier(body, tier, model) → body: Mutate the request for this tier.
 *   - getDefaultModel(tier) → string: Fallback model id for a tier.
 *   - decorateResponse(res, response, routing) → void: Inject harness-specific feedback.
 *   - upstreamURL (static): where to proxy to (e.g. api.anthropic.com, chatgpt.com).
 *   - contextWindow: tokens in the harness's context (200000 for Anthropic, etc).
 *   - statusId (optional): If not "", pass this to writeStatus/writeDecision instead of session.
 *
 * Adapters Claude Code and Codex both export their adapter structure from their own files.
 */
export async function genericProxy({
  adapter,
  upstreamURL,
  route = askJev,
} = {}) {
  if (!adapter) throw new Error("adapter is required");

  // Tier routed for each conversation's turn in flight, reused by its follow-ups.
  const conversations = new Map();
  const catalog = new Map();

  const stateFor = (key) => {
    let s = conversations.get(key);
    if (!s) {
      if (conversations.size > 50) conversations.delete(conversations.keys().next().value);
      conversations.set(key, (s = { tier: null, model: null }));
    }
    return s;
  };

  const server = http.createServer((req, res) => {
    // Probes (HEAD requests for Claude, others) should pass through.
    if (req.method === "HEAD") return res.writeHead(200).end();

    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      let out = Buffer.concat(chunks);
      let routing = null; // For response decoration

      try {
        const body = JSON.parse(out.toString());

        if (process.env.JEV_DUMP) {
          writeFileSync(`${process.env.JEV_DUMP}.${Date.now()}.json`, JSON.stringify(body, null, 2));
        }

        if (adapter.isRoutingRequest?.(req, body)) {
          const key = adapter.conversationKey?.(body);
          const state = stateFor(key);
          const current = state.tier ?? "opus";
          const prompt = adapter.newTurnPrompt?.(body);
          const explaining = prompt?.includes("<jev-explain>") || prompt?.includes("$jev-explain");

          if (prompt && !explaining) {
            const models = adapter.getModels?.(catalog);
            const available = [...new Set(models.map((m) => m.tier))].filter((t) =>
              availableTiers().includes(t),
            );
            const currentModel = state.model ?? adapter.getDefaultModel?.(current);
            const contextTokens = Math.round(JSON.stringify(body.messages ?? body.input ?? "").length / 4);

            const jev = await route({
              prompt,
              current: currentModel,
              contextTokens,
              models,
              contextWindow: adapter.contextWindow,
            });

            const chosen = models.find((m) => m.id === jev?.choice);
            const tierAnswer = jev && { ...jev, choice: chosen?.tier };
            const decision = decide({
              prompt,
              jev: tierAnswer,
              current,
              available,
              contextTokens,
            });

            const tier = decision.tier;
            const model =
              shouldUseExactModel(decision.reason, chosen?.tier, tier)
                ? chosen.id
                : tier === current
                  ? currentModel
                  : adapter.getDefaultModel?.(tier);

            state.tier = tier;
            state.model = model;

            routing = {
              prompt,
              model,
              confidence: jev?.confidence ?? null,
              metrics: jev?.metrics ?? null,
              reason: decision.reason,
              jev: jev ? { request: jev.request, response: jev.response } : null,
              at: Date.now(),
            };

            const statusKey = adapter.statusId || "";
            writeDecision(statusKey, { tier, ...routing });
            debug(
              `${key} ${jev ? `${jev.ms}ms p=${jev.confidence.toFixed(2)}` : "no-jev"} ` +
                `${current} -> ${tier} (${decision.reason}) ctx~${contextTokens} | ${prompt.slice(0, 60)}`,
            );

            // Apply tier to the request body.
            adapter.applyTier?.(body, tier, model);
          } else if (prompt) {
            // Explaining request — skip routing but mark as manual if it's a real turn.
            const statusKey = adapter.statusId || "";
            writeStatus(statusKey, { manual: true, at: Date.now() });
          }
        } else {
          // Not a routing request — check if it's an explicit model choice (manual).
          if (adapter.isManualChoice?.(req, body)) {
            const statusKey = adapter.statusId || "";
            writeStatus(statusKey, { manual: true, at: Date.now() });
          }
        }

        out = Buffer.from(JSON.stringify(body));
      } catch (err) {
        debug(`generic-proxy: could not process body: ${err.message}`);
      }

      // Proxy the request upstream.
      const target = new URL(upstreamURL);
      const transport = target.protocol === "http:" ? http : https;
      const headers = { ...req.headers, host: target.host };
      delete headers["content-length"];

      const upstream = transport.request(
        {
          hostname: target.hostname,
          port: target.port || undefined,
          path: `${target.pathname.replace(/\/$/, "")}${req.url}`,
          method: req.method,
          headers,
        },
        (response) => {
          // Special handling for model catalog endpoints.
          const isModels = req.method === "GET" && /\/models(?:\?|$)/.test(req.url ?? "");
          if (isModels && adapter.decorateModelCatalog) {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () => {
              try {
                const data = Buffer.concat(chunks);
                const catalog = JSON.parse(data.toString());
                adapter.decorateModelCatalog?.(catalog);
                const newData = Buffer.from(JSON.stringify(catalog));
                const newHeaders = { ...response.headers };
                delete newHeaders["content-length"];
                res.writeHead(response.statusCode, newHeaders);
                res.end(newData);
              } catch (err) {
                debug(`could not decorate model catalog: ${err.message}`);
                res.writeHead(response.statusCode, response.headers);
                res.end(Buffer.concat(chunks));
              }
            });
            return;
          }

          // Allow the adapter to decorate the response (e.g., SSE injection for Codex).
          if (routing && response.statusCode >= 200 && response.statusCode < 300 && adapter.decorateResponse) {
            adapter.decorateResponse?.(res, response, routing);
          } else {
            res.writeHead(response.statusCode, response.headers);
            response.pipe(res);
          }
        },
      );

      upstream.on("error", (err) => {
        debug(`upstream error: ${err.message}`);
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: err.message, type: "proxy_error" } }));
      });

      if (out.length) upstream.write(out);
      upstream.end();
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => server.close() };
}
