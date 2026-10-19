// Self-test for the host half: exercises the real module through a fake Cordis
// ctx, fake HTTP req/res and a stub llm stream — the route contract is verified
// without a live model or a running DSH host.
//
//   node scripts/selftest-host.mjs
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep every journal write out of the real DSH home while testing.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'po-home-'));
const journalDir = mkdtempSync(join(tmpdir(), 'po-journal-'));

const MODULE_URL = new URL('../lib/index.js', import.meta.url).href;

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log('  ok   ' + name);
  } else {
    failures += 1;
    console.log('  FAIL ' + name + (detail ? '  <' + JSON.stringify(detail) + '>' : ''));
  }
}

function fakeResponse() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.body = '';
  res.writableEnded = false;
  res.destroyed = false;
  res.setHeader = (key, value) => {
    res.headers[String(key).toLowerCase()] = value;
  };
  res.end = (payload) => {
    res.writableEnded = true;
    if (payload !== undefined) res.body = String(payload);
    res.emit('close');
  };
  res.parsed = () => {
    try {
      return JSON.parse(res.body);
    } catch {
      return null;
    }
  };
  return res;
}

function fakeRequest(method, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
  const req = Readable.from(chunks);
  req.method = method;
  req.headers = { 'content-type': 'application/json' };
  return req;
}

function makeContext({ llm, selection } = {}) {
  const routes = new Map();
  const ctx = {
    get(name) {
      if (name === 'webServer') {
        return {
          register(route) {
            routes.set(route.path, route);
            return () => routes.delete(route.path);
          },
        };
      }
      if (name === 'llm') return llm;
      if (name === 'agentDefaultModel') return selection === null ? undefined : { currentSelection: () => selection };
      return undefined;
    },
    effect(fn) {
      return fn();
    },
  };
  return { ctx, routes };
}

function stubLlm(chunks) {
  return {
    stream() {
      return (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
    },
  };
}

/** Streams a different script on each call (retry coverage). */
function sequenceLlm(sequences) {
  let index = 0;
  return {
    stream() {
      const chunks = sequences[Math.min(index, sequences.length - 1)];
      index += 1;
      return (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
    },
  };
}

/** Records every GenerateOptions it is handed (request-shape coverage). */
function capturingLlm(chunks, sink) {
  return {
    stream(options) {
      sink.push(options);
      return (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
    },
  };
}

const mod = await import(MODULE_URL);
check('module exports inject=[webServer]', Array.isArray(mod.inject) && mod.inject[0] === 'webServer', mod.inject);
check('module exports apply()', typeof mod.apply === 'function');

// ---- 1. routes register ----------------------------------------------------
{
  const { ctx, routes } = makeContext({ llm: stubLlm([]), selection: { provider: 'p', model: 'm' } });
  mod.apply(ctx);
  check('four routes registered', routes.size === 4, [...routes.keys()]);
  check('/health route', routes.has('/prompt-optimizer/health'));
  check('/optimize route', routes.has('/prompt-optimizer/optimize'));
  check('/runs route', routes.has('/prompt-optimizer/runs'));
  check('/versions route', routes.has('/prompt-optimizer/versions'));
}

// ---- 2. /health ------------------------------------------------------------
{
  const { ctx, routes } = makeContext({
    llm: stubLlm([]),
    selection: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
  });
  mod.apply(ctx);
  const res = fakeResponse();
  routes.get('/prompt-optimizer/health').handler(fakeRequest('GET'), res);
  const body = res.parsed();
  check('health 200', res.statusCode === 200, res.statusCode);
  check('health reports model', body && body.ok === true && body.model === 'deepseek-flash', body);
  check('health reports version', body && /^\d+\.\d+\.\d+$/.test(String(body.version || '')), body && body.version);
}

// ---- 3. /optimize happy path (fenced output gets cleaned) -------------------
{
  const { ctx, routes } = makeContext({
    llm: stubLlm([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '```markdown\n' },
      { type: 'text-delta', index: 0, text: '以下是优化后的提示词：\n' },
      { type: 'text-delta', index: 0, text: '你是代码审查员。\n只报告阻断问题。\n' },
      { type: 'text-delta', index: 0, text: '```' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]),
    selection: { provider: 'deepseek-official', model: 'deepseek-flash' },
  });
  mod.apply(ctx);
  const res = fakeResponse();
  await routes.get('/prompt-optimizer/optimize').handler(fakeRequest('POST', { text: '  帮我看看代码  ' }), res);
  const body = res.parsed();
  check('optimize 200', res.statusCode === 200, { status: res.statusCode, body });
  check('optimize ok=true', body && body.ok === true, body);
  check('optimize strips fence + preamble', body && body.text === '你是代码审查员。\n只报告阻断问题。', body && body.text);
  check('optimize echoes model', body && body.model === 'deepseek-flash', body && body.model);
  check(
    'optimize reports a rewrite',
    body && body.changed === true && body.reason === 'rewritten',
    body && { changed: body.changed, reason: body.reason },
  );
}

// ---- 3b. gate: an already-fine draft comes back untouched ------------------
{
  const { ctx, routes } = makeContext({
    llm: stubLlm([
      { type: 'text-delta', index: 0, text: '你好' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]),
    selection: { provider: 'p', model: 'm' },
  });
  mod.apply(ctx);
  const res = fakeResponse();
  await routes.get('/prompt-optimizer/optimize').handler(fakeRequest('POST', { text: '你好' }), res);
  const body = res.parsed();
  check('gate passes the draft through', res.statusCode === 200 && body && body.text === '你好', body && body.text);
  check(
    'gate reports changed=false',
    body && body.changed === false && body.reason === 'already-clear',
    body && { changed: body.changed, reason: body.reason },
  );
}

// ---- 3c. placeholder output is discarded, never shipped to the draft ------
{
  const draft = '帮我把这段代码整理一下';
  const { ctx, routes } = makeContext({
    llm: stubLlm([
      { type: 'text-delta', index: 0, text: '请先说明整理目标：{{待补充: 整理范围}}。' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]),
    selection: { provider: 'p', model: 'm' },
  });
  mod.apply(ctx);
  const res = fakeResponse();
  await routes.get('/prompt-optimizer/optimize').handler(fakeRequest('POST', { text: draft }), res);
  const body = res.parsed();
  check('placeholder output is discarded', res.statusCode === 200 && body && body.text === draft, body && body.text);
  check(
    'placeholder output reports changed=false',
    body && body.changed === false && body.reason === 'placeholder-output',
    body && body.reason,
  );
}

// ---- 3d. a quote-wrapped echo is still "no change" ------------------------
{
  const { ctx, routes } = makeContext({
    llm: stubLlm([
      { type: 'text-delta', index: 0, text: '「你好」' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]),
    selection: { provider: 'p', model: 'm' },
  });
  mod.apply(ctx);
  const res = fakeResponse();
  await routes.get('/prompt-optimizer/optimize').handler(fakeRequest('POST', { text: '你好' }), res);
  const body = res.parsed();
  check('decorated echo keeps the original text', body && body.text === '你好', body && body.text);
  check('decorated echo reports changed=false', body && body.changed === false, body && body.changed);
}

// ---- 3e. an empty first attempt is retried, then succeeds -----------------
{
  const { ctx, routes } = makeContext({
    llm: sequenceLlm([
      [{ type: 'finish', reason: { kind: 'max-tokens' } }],
      [
        { type: 'text-delta', index: 0, text: '请把需求写清楚：目标、输入、输出格式。' },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    ]),
    selection: { provider: 'p', model: 'm' },
  });
  mod.apply(ctx);
  const res = fakeResponse();
  await routes.get('/prompt-optimizer/optimize').handler(fakeRequest('POST', { text: '帮我弄一下' }), res);
  const body = res.parsed();
  check('empty first attempt is retried', res.statusCode === 200 && body && body.ok === true, body);
  check('retry result is returned', body && /请把需求写清楚/.test(body.text || ''), body && body.text);
}

// ---- 3f. adapters that only publish the finished block still work ---------
{
  const { ctx, routes } = makeContext({
    llm: stubLlm([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '整理后的提示词正文' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]),
    selection: { provider: 'p', model: 'm' },
  });
  mod.apply(ctx);
  const res = fakeResponse();
  await routes.get('/prompt-optimizer/optimize').handler(fakeRequest('POST', { text: '帮我弄一下' }), res);
  const body = res.parsed();
  check('block-end text is used when no deltas stream', body && body.text === '整理后的提示词正文', body && body.text);
}

// ---- 3g. reasoning-only answers are explained, not left generic -----------
{
  const { ctx, routes } = makeContext({
    llm: stubLlm([
      { type: 'reasoning-delta', index: 0, text: '先想一想…' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]),
    selection: { provider: 'p', model: 'm' },
  });
  mod.apply(ctx);
  const res = fakeResponse();
  await routes.get('/prompt-optimizer/optimize').handler(fakeRequest('POST', { text: '帮我弄一下' }), res);
  const body = res.parsed();
  check('reasoning-only -> 502 with a real reason', res.statusCode === 502 && /思考过程/.test(body && body.error), body && body.error);
}

// ---- 3h. request shape: budget, no reasoning steering, gate wording ------
{
  const captured = [];
  const { ctx, routes } = makeContext({
    llm: capturingLlm(
      [
        { type: 'text-delta', index: 0, text: '改写结果' },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
      captured,
    ),
    selection: { provider: 'p', model: 'm', reasoningEffort: 'max' },
  });
  mod.apply(ctx);
  const route = routes.get('/prompt-optimizer/optimize');

  await route.handler(fakeRequest('POST', { text: '帮我写个脚本读 csv 然后汇总' }), fakeResponse());
  const short = captured[0] || {};
  check('budget floor is applied', typeof short.maxTokens === 'number' && short.maxTokens >= 1800, short.maxTokens);
  check('reasoning effort is not forwarded', short.reasoningEffort === undefined, short.reasoningEffort);
  // OpenAI Responses routes reject sampling knobs outright; sending one turns a
  // rewrite into an HTTP 400, so absence here is a contract, not a preference.
  check('no temperature is sent', short.temperature === undefined, short.temperature);
  check('system prompt keeps the gate', /原样返回/.test(short.system || ''), 'missing gate wording');
  check('system prompt forbids template holes', /占位符/.test(short.system || ''), 'missing placeholder ban');
  check(
    'system prompt bans the six-section template',
    /不要.*套用/.test(short.system || '') && /验收标准/.test(short.system || ''),
    'missing structure rule',
  );
  check('system prompt has no placeholder instruction', !/用占位符.*标注/.test(short.system || ''), 'old placeholder advice survived');

  await route.handler(fakeRequest('POST', { text: 'x'.repeat(2000) }), fakeResponse());
  const long = captured[1] || {};
  check('long drafts grow the budget', typeof long.maxTokens === 'number' && long.maxTokens > short.maxTokens, {
    short: short.maxTokens,
    long: long.maxTokens,
  });
}

// ---- 3i. capability gate: a dropped path/number is rejected ---------------
{
  const draft = '读取 C:\\data\\a.csv 并按 id 去重';
  const { ctx, routes } = makeContext({
    llm: stubLlm([
      { type: 'text-delta', index: 0, text: '读取这个文件，按 id 去重后输出。' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]),
    selection: { provider: 'p', model: 'm' },
  });
  mod.apply(ctx);
  const res = fakeResponse();
  await routes.get('/prompt-optimizer/optimize').handler(fakeRequest('POST', { text: draft }), res);
  const body = res.parsed();
  check(
    'dropping a path is rejected',
    body && body.changed === false && body.reason === 'preserve-check',
    body && { reason: body.reason, text: body.text },
  );
  check('rejected rewrite keeps the draft', body && body.text === draft, body && body.text);
}

// ---- 3j. capability gate lets a faithful rewrite through ------------------
{
  const draft = '把接口超时改成 30 秒';
  const { ctx, routes } = makeContext({
    llm: stubLlm([
      { type: 'text-delta', index: 0, text: '把接口超时改成 30 秒；只改这一项，不要改其它配置。' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]),
    selection: { provider: 'p', model: 'm' },
  });
  mod.apply(ctx);
  const res = fakeResponse();
  await routes.get('/prompt-optimizer/optimize').handler(fakeRequest('POST', { text: draft }), res);
  const body = res.parsed();
  check('faithful rewrite keeps its numbers and applies', body && body.changed === true, body && { changed: body.changed, reason: body.reason });
}

// ---- 3k. expansion guard --------------------------------------------------
{
  const draft = '把日志级别改成 debug';
  const { ctx, routes } = makeContext({
    llm: stubLlm([
      { type: 'text-delta', index: 0, text: '请把日志级别改成 debug。' + '另外请你务必确认周边配置、环境变量与回滚方式都符合团队规范。'.repeat(12) },
      { type: 'finish', reason: { kind: 'stop' } },
    ]),
    selection: { provider: 'p', model: 'm' },
  });
  mod.apply(ctx);
  const res = fakeResponse();
  await routes.get('/prompt-optimizer/optimize').handler(fakeRequest('POST', { text: draft }), res);
  const body = res.parsed();
  check('runaway expansion is rejected', body && body.changed === false && body.reason === 'expansion-guard', body && body.reason);
}

// ---- 3l. scaffold guard: no sudden six-section template -------------------
{
  const draft = '把日志级别改成 debug';
  const { ctx, routes } = makeContext({
    llm: stubLlm([
      {
        type: 'text-delta',
        index: 0,
        text: '角色：提示词工程师\n目标：把日志级别改成 debug\n输入：无\n执行步骤：1. 修改配置\n输出格式：纯文本\n验收标准：日志级别为 debug\n负向约束：不要改其它配置',
      },
      { type: 'finish', reason: { kind: 'stop' } },
    ]),
    selection: { provider: 'p', model: 'm' },
  });
  mod.apply(ctx);
  const res = fakeResponse();
  await routes.get('/prompt-optimizer/optimize').handler(fakeRequest('POST', { text: draft }), res);
  const body = res.parsed();
  check('template scaffolding is rejected', body && body.changed === false && body.reason === 'scaffold-guard', body && body.reason);
}

// ---- 3m. evaluation 'compare': two candidates + judge ---------------------
{
  const { ctx, routes } = makeContext({
    llm: sequenceLlm([
      [
        { type: 'text-delta', index: 0, text: '把接口超时改成 30 秒。' },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
      [
        { type: 'text-delta', index: 0, text: '把接口超时改成 30 秒；只改这一项。' },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
      [
        { type: 'text-delta', index: 0, text: '{"winner":"B","reason":"更明确地限定了改动范围"}' },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    ]),
    selection: { provider: 'p', model: 'm' },
  });
  mod.apply(ctx, { evaluate: 'compare', dataDir: journalDir });
  const res = fakeResponse();
  await routes.get('/prompt-optimizer/optimize').handler(fakeRequest('POST', { text: '把接口超时改成 30 秒' }), res);
  const body = res.parsed();
  check('compare mode returns a rewrite', body && body.changed === true, body && body.reason);
  check('compare applies the judge winner', body && /只改这一项/.test(body.text || ''), body && body.text);
  check(
    'compare reports its cost',
    body && body.evaluation && body.evaluation.calls === 3 && body.evaluation.winner === 'B',
    body && body.evaluation,
  );
  check('compare records a version id', body && typeof body.version === 'string' && /^v\d{4}$/.test(body.version), body && body.version);
}

// ---- 3n. evaluation judge can reject every candidate ----------------------
{
  const draft = '把日志级别改成 debug';
  const { ctx, routes } = makeContext({
    llm: sequenceLlm([
      [{ type: 'text-delta', index: 0, text: '把日志级别改成 debug。' }, { type: 'finish', reason: { kind: 'stop' } }],
      [{ type: 'text-delta', index: 0, text: '把日志级别改成 debug 即可。' }, { type: 'finish', reason: { kind: 'stop' } }],
      [{ type: 'text-delta', index: 0, text: '{"winner":"none","reason":"原文已足够"}' }, { type: 'finish', reason: { kind: 'stop' } }],
    ]),
    selection: { provider: 'p', model: 'm' },
  });
  mod.apply(ctx, { evaluate: 'compare', dataDir: journalDir });
  const res = fakeResponse();
  await routes.get('/prompt-optimizer/optimize').handler(fakeRequest('POST', { text: draft }), res);
  const body = res.parsed();
  check('judge rejection keeps the draft', body && body.changed === false && body.text === draft, body && body.reason);
  check('judge rejection is labelled', body && body.reason === 'judge-rejected', body && body.reason);
}

// ---- 3o. evaluation 'full': cases + regression + judge --------------------
{
  const { ctx, routes } = makeContext({
    llm: sequenceLlm([
      [{ type: 'text-delta', index: 0, text: '请把接口超时改成 30 秒。' }, { type: 'finish', reason: { kind: 'stop' } }],
      [{ type: 'text-delta', index: 0, text: '请把接口超时改成 30 秒；只改超时这一项，不动其它配置。' }, { type: 'finish', reason: { kind: 'stop' } }],
      [{ type: 'text-delta', index: 0, text: '{"cases":["把超时改成 10 秒"]}' }, { type: 'finish', reason: { kind: 'stop' } }],
      [{ type: 'text-delta', index: 0, text: '已改为 10 秒' }, { type: 'finish', reason: { kind: 'stop' } }],
      [{ type: 'text-delta', index: 0, text: '已改为 10 秒（超时）' }, { type: 'finish', reason: { kind: 'stop' } }],
      [{ type: 'text-delta', index: 0, text: '已把超时改为 10 秒，其它未动' }, { type: 'finish', reason: { kind: 'stop' } }],
      [{ type: 'text-delta', index: 0, text: '{"winner":"B","reason":"更完整"}' }, { type: 'finish', reason: { kind: 'stop' } }],
    ]),
    selection: { provider: 'p', model: 'm' },
  });
  mod.apply(ctx, { evaluate: 'full', evalCases: 1, dataDir: journalDir });
  const res = fakeResponse();
  await routes.get('/prompt-optimizer/optimize').handler(fakeRequest('POST', { text: '把接口超时改成 30 秒' }), res);
  const body = res.parsed();
  check('full mode applies the winner', body && /不动其它配置/.test(body.text || ''), body && body.text);
  check(
    'full mode ran cases + judge',
    body && body.evaluation && body.evaluation.cases === 1 && body.evaluation.calls === 7,
    body && body.evaluation,
  );
}

// ---- 3p. journal: manifest hashes + immutable version log ----------------
{
  const { ctx, routes } = makeContext({ llm: stubLlm([]), selection: { provider: 'p', model: 'm' } });
  mod.apply(ctx, { dataDir: journalDir });

  const runs = fakeResponse();
  await routes.get('/prompt-optimizer/runs').handler(fakeRequest('GET'), runs);
  const runsBody = runs.parsed();
  check('/runs is served', runsBody && runsBody.ok === true, runs && runs.statusCode);
  check('manifest has records', runsBody && Array.isArray(runsBody.items) && runsBody.items.length >= 3, runsBody && runsBody.total);
  const first = (runsBody && runsBody.items && runsBody.items[0]) || {};
  check(
    'manifest records a sha256 chain',
    /^[0-9a-f]{64}$/.test(first.input && first.input.sha256) && /^[0-9a-f]{64}$/.test(first.output && first.output.sha256),
    first.input,
  );

  const versions = fakeResponse();
  await routes.get('/prompt-optimizer/versions').handler(fakeRequest('GET'), versions);
  const versionBody = versions.parsed();
  check('/versions is served', versionBody && versionBody.ok === true, versions && versions.statusCode);
  check('version log has entries', versionBody && versionBody.items.length >= 2, versionBody && versionBody.total);
  check('journal dir was created', existsSync(join(journalDir, 'runs.jsonl')), journalDir);
}

// ---- 3q. an incomplete task gets the nudge guidance on the FIRST call -----
{
  const draft = '帮我做个表格';
  const captured = [];
  const routes = new Map();
  const ctx = {
    get(name) {
      if (name === 'webServer') {
        return {
          register(route) {
            routes.set(route.path, route);
            return () => routes.delete(route.path);
          },
        };
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) };
      if (name === 'llm') {
        return {
          stream(options) {
            captured.push(options);
            return (async function* () {
              yield { type: 'text-delta', index: 0, text: '帮我做个表格：两列（名称、数量），输出为 Markdown 表格。' };
              yield { type: 'finish', reason: { kind: 'stop' } };
            })();
          },
        };
      }
      return undefined;
    },
    effect: (fn) => fn(),
  };
  mod.apply(ctx, { dataDir: journalDir });
  const res = fakeResponse();
  await routes.get('/prompt-optimizer/optimize').handler(fakeRequest('POST', { text: draft }), res);
  const body = res.parsed();
  check('incomplete task is rewritten', body && body.changed === true && /Markdown/.test(body.text || ''), body && body.text);
  check('incomplete task costs one call', captured.length === 1, captured.length);
  const firstText = captured[0] && captured[0].messages[0].content[0].text;
  check('first call carries the nudge instruction', /模式：补缺/.test(String(firstText || '')), String(firstText || '').slice(0, 80));
  check('nudge is recorded in the journal flow', body && body.flow && body.flow.primaryMode === 'nudge', body && body.flow);
}

// ---- 3r. greetings are local; questions and complete requests cost one call ---
{
  const routes = new Map();
  const captured = [];
  let echo = '';
  const ctx = {
    get(name) {
      if (name === 'webServer') {
        return {
          register(route) {
            routes.set(route.path, route);
            return () => routes.delete(route.path);
          },
        };
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) };
      if (name === 'llm') {
        return {
          stream(options) {
            captured.push(options);
            return (async function* () {
              yield { type: 'text-delta', index: 0, text: echo };
              yield { type: 'finish', reason: { kind: 'stop' } };
            })();
          },
        };
      }
      return undefined;
    },
    effect: (fn) => fn(),
  };
  mod.apply(ctx, { dataDir: journalDir });
  const route = routes.get('/prompt-optimizer/optimize');

  for (const [draft, label, expected] of [
    ['你好', 'greeting', 0],
    ['为什么优化后输出会有中括号？', 'question', 1],
    ['把日志按时间排序写到 out.csv，只保留 error 级', 'complete request', 1],
  ]) {
    echo = draft;
    captured.length = 0;
    const res = fakeResponse();
    await route.handler(fakeRequest('POST', { text: draft }), res);
    const body = res.parsed();
    check(label + ' costs ' + expected + ' call(s)', captured.length === expected, { calls: captured.length, draft });
    if (expected === 0) {
      check('greeting keeps the draft unchanged', body && body.text === draft && body.changed === false, body && body.reason);
      check('greeting is reported as a local decision', body && body.flow && body.flow.path === 'local', body && body.flow);
    }
  }
}

// ---- 3s. prompt.md overrides the meta-prompt, live, without a restart ----
{
  const promptFile = join(tmpdir(), 'po-prompt-' + process.pid + '.md');
  writeFileSync(promptFile, '自定义规则第一版：只补输出格式。原文原样返回。', 'utf8');
  process.env.DSH_PROMPT_OPTIMIZER_PROMPT_FILE = promptFile;

  const captured = [];
  const { ctx, routes } = makeContext({
    llm: capturingLlm(
      [
        { type: 'text-delta', index: 0, text: '改写结果 A' },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
      captured,
    ),
    selection: { provider: 'p', model: 'm' },
  });
  mod.apply(ctx, { dataDir: journalDir });
  const route = routes.get('/prompt-optimizer/optimize');

  await route.handler(fakeRequest('POST', { text: '帮我做个表格' }), fakeResponse());
  check('custom prompt file is used', /自定义规则第一版/.test(captured[0].system || ''), (captured[0].system || '').slice(0, 40));

  // Rewrite the file in the SAME process: the next click must see the new text.
  writeFileSync(promptFile, '自定义规则第二版：先判断再改写，长度故意与上一版不同。', 'utf8');
  const before = captured.length;
  await route.handler(fakeRequest('POST', { text: '帮我做个表格' }), fakeResponse());
  check(
    'edited prompt file is picked up live',
    /自定义规则第二版/.test(captured[before].system || ''),
    (captured[before].system || '').slice(0, 40),
  );

  delete process.env.DSH_PROMPT_OPTIMIZER_PROMPT_FILE;
}

// ---- 3t. prompt.md keeps its contract (it is the live source now) -------
{
  const file = fileURLToPath(new URL('../prompt.md', import.meta.url));
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    text = '';
  }
  check('prompt.md exists and is substantial', text.length > 500, text.length);
  check('prompt.md stays compact', text.length < 3000, text.length);
  check('prompt.md keeps the gate', /原样返回/.test(text), 'missing gate');
  check('prompt.md bans placeholders', /占位符/.test(text) && /模板标记/.test(text), 'missing placeholder ban');
  check('prompt.md keeps the six-section ban', /不要.*套用/.test(text), 'missing structure rule');
  check('prompt.md carries worked examples', /示例/.test(text), 'missing examples');
}

// ---- 4. validation paths ---------------------------------------------------
{
  const { ctx, routes } = makeContext({ llm: stubLlm([]), selection: { provider: 'p', model: 'm' } });
  mod.apply(ctx);
  const route = routes.get('/prompt-optimizer/optimize');

  const wrongMethod = fakeResponse();
  await route.handler(fakeRequest('GET'), wrongMethod);
  check('GET /optimize -> 405', wrongMethod.statusCode === 405, wrongMethod.statusCode);

  const empty = fakeResponse();
  await route.handler(fakeRequest('POST', { text: '   ' }), empty);
  check('blank draft -> 400', empty.statusCode === 400, empty.statusCode);

  const tooLong = fakeResponse();
  await route.handler(fakeRequest('POST', { text: 'x'.repeat(20000) }), tooLong);
  check('oversized draft -> 413', tooLong.statusCode === 413, tooLong.statusCode);
}

// ---- 5. no default model ---------------------------------------------------
{
  const { ctx, routes } = makeContext({ llm: stubLlm([]), selection: null });
  mod.apply(ctx);
  const res = fakeResponse();
  await routes.get('/prompt-optimizer/optimize').handler(fakeRequest('POST', { text: 'hi' }), res);
  check('missing model -> 503', res.statusCode === 503, res.statusCode);
}

// ---- 6. llm failure surfaces ----------------------------------------------
{
  const { ctx, routes } = makeContext({
    llm: stubLlm([
      { type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited', code: 'RATE_LIMIT', status: 429 } } },
    ]),
    selection: { provider: 'p', model: 'm' },
  });
  mod.apply(ctx);
  const res = fakeResponse();
  await routes.get('/prompt-optimizer/optimize').handler(fakeRequest('POST', { text: 'hi' }), res);
  const body = res.parsed();
  check('provider failure -> 502', res.statusCode === 502, res.statusCode);
  check('failure message carries code', body && /RATE_LIMIT/.test(body.error) && /429/.test(body.error), body && body.error);
}

// ---- 7. empty model output -------------------------------------------------
{
  const { ctx, routes } = makeContext({
    llm: stubLlm([{ type: 'finish', reason: { kind: 'stop' } }]),
    selection: { provider: 'p', model: 'm' },
  });
  mod.apply(ctx);
  const res = fakeResponse();
  await routes.get('/prompt-optimizer/optimize').handler(fakeRequest('POST', { text: 'hi' }), res);
  check('empty output -> 502', res.statusCode === 502, res.statusCode);
}

console.log('');
if (failures > 0) {
  console.log(failures + ' CHECK(S) FAILED');
  process.exit(1);
}
console.log('ALL CHECKS PASSED');
