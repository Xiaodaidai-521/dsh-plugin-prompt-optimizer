/**
 * Run journal + prompt version log for dsh-plugin-prompt-optimizer.
 *
 * This is the cheap half of an evaluation harness: it costs ZERO extra model
 * calls, yet it gives the two things that actually make optimization auditable:
 *
 *   runs.jsonl          one append-only record per rewrite attempt — input and
 *                       output SHA-256, model route, mode, gates, decision,
 *                       latency, and the version id it produced (a hash chain,
 *                       not a mutable latest-pointer).
 *   versions/vNNNN-*.md one immutable file per APPLIED rewrite, mirroring the
 *                       reference implementation's `prompt_vN.md` discipline:
 *                       a new version is created, never overwritten.
 *
 * Everything here fails soft: a journal write must never break a rewrite.
 */

import { mkdir, appendFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve the default data directory: `<DSH_HOME or ~/.dsh>/storages/prompt-optimizer`.
 * @returns {string} absolute directory.
 */
export function defaultDataDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'storages', 'prompt-optimizer');
}

/**
 * Hex SHA-256 of one string.
 * @param {string} text - input text.
 * @returns {string} 64-char hex digest.
 */
export function sha256(text) {
  return createHash('sha256').update(String(text == null ? '' : text), 'utf8').digest('hex');
}

/**
 * Short id for one run.
 * @returns {string} `po_<base36 time>_<random>`.
 */
export function runId() {
  return 'po_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/**
 * Create the journal handle bound to one directory.
 * @param {string} [dir] - data directory; defaults to {@link defaultDataDir}.
 * @param {{ keepVersions?: boolean }} [options] - version retention switch.
 * @returns {object} journal handle.
 */
export function createJournal(dir, options = {}) {
  const rootDir = dir || defaultDataDir();
  const keepVersions = options.keepVersions !== false;
  const runsFile = join(rootDir, 'runs.jsonl');
  const versionsDir = join(rootDir, 'versions');
  let versionSeq = null;

  /**
   * Read the highest existing version number once, so numbering survives restarts.
   * @returns {Promise<number>} latest version number (0 when none).
   */
  async function latestVersion() {
    if (versionSeq !== null) return versionSeq;
    versionSeq = 0;
    try {
      const entries = await readdir(versionsDir);
      for (const name of entries) {
        const match = /^v(\d+)-/.exec(name);
        if (match) versionSeq = Math.max(versionSeq, Number(match[1]));
      }
    } catch {
      // No versions directory yet.
    }
    return versionSeq;
  }

  /**
   * Append one record to the journal (best effort).
   * @param {object} entry - record body.
   * @returns {Promise<void>} settles even when the disk write fails.
   */
  async function record(entry) {
    try {
      await mkdir(rootDir, { recursive: true });
      await appendFile(runsFile, JSON.stringify(entry) + '\n', 'utf8');
    } catch (error) {
      console.error('[prompt-optimizer] journal write failed:', error && error.message);
    }
  }

  /**
   * Persist one applied rewrite as an immutable version file.
   * @param {string} text - the applied prompt body.
   * @returns {Promise<{ id: string, file: string, sha256: string } | null>} version descriptor, or null.
   */
  async function saveVersion(text) {
    if (!keepVersions) return null;
    try {
      await mkdir(versionsDir, { recursive: true });
      const next = (await latestVersion()) + 1;
      versionSeq = next;
      const digest = sha256(text);
      const id = 'v' + String(next).padStart(4, '0');
      const file = join(versionsDir, id + '-' + digest.slice(0, 8) + '.md');
      await writeFile(file, text, 'utf8');
      return { id, file, sha256: digest };
    } catch (error) {
      console.error('[prompt-optimizer] version write failed:', error && error.message);
      return null;
    }
  }

  /**
   * Read the most recent journal records, newest last.
   * @param {number} limit - maximum records.
   * @returns {Promise<object[]>} parsed records.
   */
  async function listRuns(limit) {
    try {
      const raw = await readFile(runsFile, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const slice = lines.slice(Math.max(0, lines.length - Math.max(1, Math.min(200, limit || 20))));
      return slice.map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { malformed: line.slice(0, 120) };
        }
      });
    } catch {
      return [];
    }
  }

  /**
   * List the version log (ids, hashes, sizes — never the text).
   * @param {number} limit - maximum entries.
   * @returns {Promise<Array<{ id: string, file: string, bytes: number }>>} version descriptors.
   */
  async function listVersions(limit) {
    try {
      const entries = await readdir(versionsDir);
      return entries
        .filter((name) => name.endsWith('.md'))
        .sort()
        .slice(-Math.max(1, Math.min(200, limit || 50)))
        .map((name) => ({ id: name.replace(/\.md$/, ''), file: name }));
    } catch {
      return [];
    }
  }

  return { rootDir, runsFile, versionsDir, record, saveVersion, listRuns, listVersions };
}
