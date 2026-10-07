import { availableTiers, shouldUseExactModel, THRESHOLDS } from "./config.mjs";
import { decide } from "./policy.mjs";
import { askJev } from "./router.mjs";
import { defaultStore } from "./status.mjs";

/**
 * Route one new user turn without assuming any harness or wire protocol.
 *
 * `getDefaultModel` is needed only when policy lands on a different tier without accepting
 * Jev's exact model (for example, an explicit override or an availability clamp). A native
 * caller can omit it when `models` contains one canonical model per tier.
 *
 * @param {object} input
 * @param {string} input.prompt
 * @param {string} input.current Current routing tier.
 * @param {string} input.currentModel Exact model currently in use.
 * @param {Array<{id: string, tier: string, description?: string, maxInputTokens?: number}>} input.models
 *   `maxInputTokens`, when known, is the model's input window.
 * @param {number} input.contextTokens Size of the conversation, for the cache-rebuild guard.
 * @param {number} [input.requestTokens] Size of the whole request (system prompt, tools and
 *   conversation). A model whose window cannot hold it is treated as unavailable, so policy
 *   steps up to one that can. Defaults to `contextTokens`.
 * @param {number} input.contextWindow
 * @param {string} [input.statusId]
 * @param {(tier: string) => string} [input.getDefaultModel]
 * @param {typeof askJev} [input.route]
 * @returns {Promise<{tier: string, model: string, reason: string, confidence: number | null, metrics: object | null, jev: object | null, at: number}>}
 */
export async function routeTurn({
  prompt,
  current,
  currentModel,
  models = [],
  contextTokens = 0,
  requestTokens = contextTokens,
  contextWindow,
  statusId = "",
  getDefaultModel = (tier) => models.find((model) => model.tier === tier)?.id,
  route = askJev,
  store = defaultStore,
}) {
  // Disabled tiers are not offered to Jev, matching the proxy's historical behavior.
  // So are models too small for the request: the API would reject the turn outright.
  const fits = (model) =>
    !model?.maxInputTokens || requestTokens <= model.maxInputTokens * THRESHOLDS.contextHeadroom;
  const fitsId = (id) => fits(models.find((model) => model.id === id));
  const routedModels = models.filter((model) => availableTiers().includes(model.tier) && fits(model));
  const available = [...new Set(routedModels.map((model) => model.tier))];

  const jevAnswer = await route({
    prompt,
    current: currentModel,
    contextTokens,
    models: routedModels,
    contextWindow,
  });

  const chosen = routedModels.find((model) => model.id === jevAnswer?.choice);
  const tierAnswer = jevAnswer && { ...jevAnswer, choice: chosen?.tier };
  const policy = decide({ prompt, jev: tierAnswer, current, available, contextTokens });
  const tier = policy.tier;
  const fallback = () => {
    const preferred = getDefaultModel?.(tier);
    return fitsId(preferred) ? preferred : (routedModels.find((m) => m.tier === tier)?.id ?? preferred);
  };
  const model = shouldUseExactModel(policy.reason, chosen?.tier, tier)
    ? chosen.id
    : tier === current && fitsId(currentModel)
      ? currentModel
      : fallback();

  const decision = {
    tier,
    model,
    reason: policy.reason,
    confidence: jevAnswer?.confidence ?? null,
    metrics: jevAnswer?.metrics ?? null,
    jev: jevAnswer ? { request: jevAnswer.request, response: jevAnswer.response } : null,
    at: Date.now(),
  };

  if (statusId) {
    store.writeDecision(statusId, {
      tier,
      prompt,
      model,
      confidence: decision.confidence,
      metrics: decision.metrics,
      reason: decision.reason,
      jev: decision.jev,
      at: decision.at,
    });
  }
  return decision;
}
