import { createHash } from "node:crypto";
import { isAuto } from "./lib/config.mjs";
import { tierOf, idOf, tierSpec, CONTEXT_WINDOW_TOKENS } from "./lib/tiers/claude.mjs";
import { genericProxy } from "./generic-proxy.mjs";

const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

/**
 * Claude Code converts draft-04 relics in MCP tool schemas before sending them first-party,
 * but skips that when ANTHROPIC_BASE_URL is set, so the API rejects the request. In draft
 * 2020-12 `exclusiveMinimum`/`exclusiveMaximum` are numbers, not booleans.
 */
export function sanitizeSchema(node) {
  if (Array.isArray(node)) return node.forEach(sanitizeSchema);
  if (!node || typeof node !== "object") return;
  for (const [key, bound] of [
    ["exclusiveMinimum", "minimum"],
    ["exclusiveMaximum", "maximum"],
  ]) {
    if (typeof node[key] === "boolean") {
      if (node[key] && typeof node[bound] === "number") {
        node[key] = node[bound];
        delete node[bound];
      } else {
        delete node[key];
      }
    }
  }
  for (const v of Object.values(node)) sanitizeSchema(v);
}

/**
 * The text of a genuinely new user turn, or null.
 */
export function newTurnPrompt(body) {
  if (!Array.isArray(body?.tools) || body.tools.length === 0) return null;
  const last = body?.messages?.findLast((m) => m.role !== "system");
  if (!last || last.role !== "user") return null;
  let text;
  if (typeof last.content === "string") {
    text = last.content;
  } else if (Array.isArray(last.content)) {
    if (last.content.some((b) => b.type === "tool_result")) return null;
    text = last.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  } else {
    return null;
  }
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim() || null;
}

/**
 * Points a request at a tier, removing request fields that tier cannot accept.
 */
export function applyTier(body, tierName, model = idOf(tierName)) {
  const tier = tierSpec(tierName);
  if (!tier) return body;
  body.model = model;
  if (!tier.thinking) {
    delete body.thinking;
    const edits = body.context_management?.edits;
    if (Array.isArray(edits)) {
      body.context_management.edits = edits.filter((e) => !/thinking/i.test(e?.type ?? ""));
      if (body.context_management.edits.length === 0) delete body.context_management;
    }
  }
  if (!tier.effort && body.output_config) {
    delete body.output_config.effort;
    if (Object.keys(body.output_config).length === 0) delete body.output_config;
  }
  return body;
}

/**
 * Exact Claude models reported by the account, newest first; static ids are the cold-start fallback.
 */
export function claudeModels(catalog = []) {
  const models = catalog
    .filter((model) => tierOf(model?.id))
    .map((model) => ({
      id: model.id,
      tier: tierOf(model.id),
      description: [
        model.display_name,
        model.created_at && `released ${model.created_at.slice(0, 10)}`,
        model.max_input_tokens && `${model.max_input_tokens} input tokens`,
      ].filter(Boolean).join("; "),
    }));
  return models.length
    ? models
    : [
        { id: "claude-opus-4-1", tier: "opus", description: "claude-opus-4-1" },
        { id: "claude-sonnet-4-20250514", tier: "sonnet", description: "claude-sonnet-4-20250514" },
        { id: "claude-haiku-4-5-20251001", tier: "haiku", description: "claude-haiku-4-5-20251001" },
      ];
}

/**
 * Session id Claude Code embeds in request metadata, or "" when it isn't present.
 */
export function sessionOf(body) {
  try {
    return JSON.parse(body?.metadata?.user_id ?? "{}").session_id ?? "";
  } catch {
    return "";
  }
}

/**
 * Stable conversation key from session + first message.
 */
export function conversationKey(body) {
  const session = sessionOf(body);
  const content = body?.messages?.[0]?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("")
        : "";
  return createHash("sha1").update(`${session}|${text}`).digest("hex").slice(0, 12);
}

/**
 * Adapter for Claude Code / Anthropic API.
 *
 * Implements the adapter interface for genericProxy:
 * - isRoutingRequest: Detect routing requests (/v1/messages with sentinel model)
 * - conversationKey: Extract stable conversation identifier
 * - newTurnPrompt: Extract user prompt text, filtering boilerplate
 * - getModels: Collect available models from the catalog
 * - getDefaultModel: Default model for a tier name
 * - applyTier: Mutate request for the chosen tier
 * - decorateResponse: Pass through (Claude uses files, not SSE)
 */
const claudeAdapter = {
  contextWindow: CONTEXT_WINDOW_TOKENS,
  upstreamURL: ANTHROPIC_BASE_URL,

  isRoutingRequest(req, body) {
    return /^\/v1\/messages/.test(req.url ?? "") && isAuto(body.model);
  },

  isManualChoice(req, body) {
    return /^\/v1\/messages/.test(req.url ?? "") && !isAuto(body.model) && Array.isArray(body.tools);
  },

  conversationKey(body) {
    return conversationKey(body);
  },

  newTurnPrompt(body) {
    return newTurnPrompt(body);
  },

  getModels(catalog) {
    return claudeModels([...catalog.values()]);
  },

  getDefaultModel(tier) {
    return idOf(tier);
  },

  applyTier(body, tier, model) {
    body.tools?.forEach((t) => sanitizeSchema(t.input_schema));
    applyTier(body, tier, model);
  },

  decorateResponse(res, response, routing) {
    response.pipe(res);
  },
};

export async function startProxy({ upstreamURL = ANTHROPIC_BASE_URL, route } = {}) {
  return genericProxy({ adapter: claudeAdapter, upstreamURL, route });
}
