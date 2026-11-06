// Settings and paths shared by dshv and the journeys.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = resolve(SKILL_DIR, '../../..');

/** Expand $VAR, ${VAR}, and ${VAR:-default} against `vars`. */
function expand(text, vars) {
  return text.replace(/\$\{(\w+)(?::-([^}]*))?\}|\$(\w+)/g, (_, braced, fallback, bare) => {
    const value = vars[braced ?? bare];
    return value === undefined || value === '' ? (fallback ?? '') : value;
  });
}

/**
 * Settings: the shell environment wins over the skill's .env, which wins over defaults.
 * @returns {Record<string, string>}
 */
export function loadSettings(env = process.env) {
  const vars = { REPO, ...env };
  const file = join(SKILL_DIR, '.env');
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Za-z_]\w*)=(.*)$/);
      if (!match || env[match[1]] !== undefined) continue;
      vars[match[1]] = expand(match[2].trim(), vars);
    }
  }
  const pick = (key, fallback) => vars[key] || expand(fallback, vars);
  return {
    dshRoot: resolve(pick('DSHV_DSH_ROOT', '$REPO/../deepseek-harness')),
    runRoot: resolve(pick('DSHV_RUN_ROOT', '${TMPDIR:-/tmp}/dshv')),
    evidenceRoot: resolve(pick('DSHV_EVIDENCE_ROOT', '$REPO/reports/verify-dsh-plugins')),
    browsersPath: pick('PLAYWRIGHT_BROWSERS_PATH', '$HOME/.cache/ms-playwright'),
    livePort: pick('DSHV_LIVE_PORT', '3080'),
    mockSequence: pick('DSHV_MOCK_SEQUENCE', 'success'),
  };
}

/** Error whose message tells the reader what to do next. */
export class DshvError extends Error {
  constructor(message, next) {
    super(next ? `${message}\nnext: ${next}` : message);
  }
}
