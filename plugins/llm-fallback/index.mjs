// llm-fallback — config-driven LLM provider fallback on the llm/stream
// waterfall. A chain is keyed by source provider AND source model, so only
// the exact configured model switches (never every model of a provider).
// When a call matching a chain fails with a configured failure code (default
// QUOTA, RATE_LIMIT) before producing any content, the call is re-issued
// against each route in order until one completes; the first completing route
// wins and the caller sees one uninterrupted stream.
//
// Config (row config):
//   chains:
//     ollama-cloud:
//       sourceModel: glm-5.3-flash          # required guard: only this model falls back
//       routes:
//         - provider: openrouter
//           model: deepseek/deepseek-v4-flash-0731
//           strip: [maxTokens]              # optional fields the target rejects
//   fallbackOn: [QUOTA, RATE_LIMIT]         # optional; default shown
//
// A chain is one-hop by design: chains-of-chains are unsupported and a route
// that re-enters a provider already visited in the same waterfall entry is
// skipped (cycle guard). A route targeting the same provider as its own chain
// is a config error. A chain only fires before any content chunk was
// delivered; after content the error propagates (cannot rewind).
export const name = 'llm-fallback';

const DEFAULT_FALLBACK_ON = ['QUOTA', 'RATE_LIMIT'];

export function apply(ctx, config) {
  const chains = normalizeChains(config?.chains);
  const fallbackOn = new Set(normalizeFallbackOn(config?.fallbackOn));
  ctx.on('llm/stream', function (options, next) {
    const chain = chains[options.provider];
    if (!chain) return next();
    // Source-model filter: only the configured source model falls back, so a
    // provider with several models keeps every other model on its direct path.
    if (options.model !== chain.sourceModel) return next();
    return withFallback(this, options, next, chain.routes, fallbackOn);
  });
}

export function normalizeChains(chains) {
  if (chains === undefined || chains === null) return {};
  if (typeof chains !== 'object' || Array.isArray(chains)) {
    throw new Error('llm-fallback: config.chains must be an object of provider → chain specs');
  }
  const out = {};
  for (const [provider, spec] of Object.entries(chains)) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      throw new Error(`llm-fallback: config.chains.${provider} must be a { sourceModel, routes } spec`);
    }
    if (typeof spec.sourceModel !== 'string' || spec.sourceModel.length === 0) {
      throw new Error(`llm-fallback: config.chains.${provider} needs a sourceModel filter`);
    }
    const source = spec.routes;
    if (!Array.isArray(source) || source.length === 0) {
      throw new Error(`llm-fallback: config.chains.${provider} must have a non-empty routes array`);
    }
    const routes = source.map((route, index) => {
      if (!route || typeof route.provider !== 'string' || typeof route.model !== 'string') {
        throw new Error(`llm-fallback: config.chains.${provider}.routes[${index}] needs string provider and model`);
      }
      // A route that targets the source provider loops forever through the
      // waterfall — a config error, caught here.
      if (route.provider === provider) {
        throw new Error(`llm-fallback: config.chains.${provider}.routes[${index}] targets its own provider (cycle)`);
      }
      const strip = route.strip === undefined ? [] : route.strip;
      if (!Array.isArray(strip) || strip.some((field) => typeof field !== 'string')) {
        throw new Error(`llm-fallback: config.chains.${provider}.routes[${index}].strip must be an array of field names`);
      }
      return {
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
        strip,
      };
    });
    out[provider] = { sourceModel: spec.sourceModel, routes };
  }
  for (const spec of Object.values(out)) {
    for (const route of spec.routes) {
      if (Object.hasOwn(out, route.provider)) {
        throw new Error('llm-fallback: chained fallback providers are unsupported');
      }
    }
  }
  return out;
}

export function normalizeFallbackOn(codes) {
  if (codes === undefined || codes === null) return DEFAULT_FALLBACK_ON;
  if (!Array.isArray(codes) || codes.some((code) => typeof code !== 'string')) {
    throw new Error('llm-fallback: config.fallbackOn must be an array of failure codes');
  }
  return codes;
}

export function buildOptions(options, route) {
  const next = { ...options, provider: route.provider, model: route.model };
  if (route.reasoningEffort !== undefined) next.reasoningEffort = route.reasoningEffort;
  for (const field of route.strip) next[field] = undefined;
  return next;
}

export async function* withFallback(runtime, options, next, chain, fallbackOn) {
  const visited = new Set([options.provider]);
  const candidates = chain.filter((route) => !visited.has(route.provider));
  let sawContent = false;
  for await (const chunk of next()) {
    if (chunk.type !== 'usage' && chunk.type !== 'finish') sawContent = true;
    if (chunk.type === 'finish' && chunk.reason?.kind === 'error' && !sawContent) {
      if (fallbackOn.has(chunk.reason.failure?.code)) {
        let lastFailure = chunk;
        for (const route of candidates) {
          const attempt = runtime.stream(buildOptions(options, route));
          let routeContent = false;
          let failed = null;
          for await (const candidate of attempt) {
            if (candidate.type !== 'usage' && candidate.type !== 'finish') routeContent = true;
            if (candidate.type === 'finish' && candidate.reason?.kind === 'error' && !routeContent) {
              if (!fallbackOn.has(candidate.reason.failure?.code)) {
                yield candidate;
                return;
              }
              failed = candidate;
              break;
            }
            yield candidate;
          }
          if (!failed) return; // route completed (or failed after content — already delivered)
          lastFailure = failed;
          visited.add(route.provider);
        }
        yield lastFailure; // every route failed before content
        return;
      }
    }
    yield chunk;
  }
}