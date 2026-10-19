/**
 * Live-editable meta-prompt.
 *
 * Restarting DSH just to tweak one sentence in the prompt is the wrong loop, so
 * the system prompt is read from `<package>/prompt.md` on demand and cached by
 * (mtime, size). Edit the file, click the button again — no restart, no rebuild.
 *
 * Fallback order:
 *   1. process.env.DSH_PROMPT_OPTIMIZER_PROMPT_FILE (test seam)
 *   2. <package>/prompt.md
 *   3. the built-in default compiled into lib/index.js
 *
 * A missing/empty/unreadable file never breaks the plugin: the last good text
 * (or the built-in default) keeps serving.
 */

import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './store.js';

/** Package root (this file lives in lib/). */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Resolve the prompt file path for this process.
 * @returns {string} absolute path.
 */
export function promptFilePath() {
  const override = process.env.DSH_PROMPT_OPTIMIZER_PROMPT_FILE;
  if (typeof override === 'string' && override.trim()) return override.trim();
  return join(PACKAGE_ROOT, 'prompt.md');
}

/**
 * Create the prompt source bound to one fallback text.
 * @param {string} fallback - built-in system prompt, used when the file is absent.
 * @returns {{ refresh: () => void, text: () => string, sha256: () => string, file: () => string }} prompt source.
 */
export function createPromptSource(fallback) {
  const fallbackText = String(fallback || '');
  let text = fallbackText;
  let digest = sha256(fallbackText);
  let signature = '';

  /**
   * Re-read the file when its (mtime, size) changed; keep the last good text on error.
   * @returns {void}
   */
  function refresh() {
    const file = promptFilePath();
    let stat;
    try {
      stat = statSync(file);
    } catch {
      // No file (or unreadable): keep whatever we have.
      return;
    }
    const next = file + ':' + String(stat.mtimeMs) + ':' + String(stat.size);
    if (next === signature) return;
    try {
      const raw = readFileSync(file, 'utf8').trim();
      if (!raw) return;
      text = raw;
      digest = sha256(raw);
      signature = next;
    } catch {
      // A transient read failure must not replace a working prompt.
    }
  }

  return {
    refresh,
    text: () => text,
    sha256: () => digest,
    file: promptFilePath,
  };
}
