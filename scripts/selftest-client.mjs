// Self-test for the browser half: loads the real bundle with a stub
// window/require, then exercises the slot registration and the button's
// render / fetch / setDraft path.
//
//   node scripts/selftest-client.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CLIENT_PATH = fileURLToPath(new URL('../lib/client.js', import.meta.url));

let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log('  ok   ' + name);
  else {
    failures += 1;
    console.log('  FAIL ' + name + (detail === undefined ? '' : '  <' + JSON.stringify(detail) + '>'));
  }
}

// ---- minimal React ---------------------------------------------------------
const createElement = (type, props, ...children) => ({ type, props: props || {}, children });

function makeHooks() {
  const slots = [];
  let index = 0;
  const next = () => {
    const slot = slots[index] !== undefined ? slots[index] : (slots[index] = {});
    index += 1;
    return slot;
  };
  return {
    reset() {
      index = 0;
    },
    React: {
      createElement,
      useState(initial) {
        const slot = next();
        if (!('value' in slot)) slot.value = initial;
        return [
          slot.value,
          (value) => {
            slot.value = typeof value === 'function' ? value(slot.value) : value;
          },
        ];
      },
      useRef(initial) {
        const slot = next();
        if (!slot.ref) slot.ref = { current: initial };
        return slot.ref;
      },
      useEffect() {},
    },
  };
}

const hooks = makeHooks();
const React = hooks.React;

// ---- load the bundle -------------------------------------------------------
let captured = null;
const windowStub = {
  __ModuleLoader__: {
    load: (spec) => {
      captured = spec;
    },
  },
};
const requireStub = (id) => {
  if (id === 'react') return React;
  throw new Error('unexpected require: ' + id);
};
const code = readFileSync(CLIENT_PATH, 'utf8');
new Function('window', 'require', code)(windowStub, requireStub);

check('bundle registered itself', !!captured, captured === null ? 'no load() call' : undefined);
check('bundle id is the package name', captured && captured.id === 'dsh-plugin-prompt-optimizer', captured && captured.id);
check('factory is a function', captured && typeof captured.factory === 'function');

const moduleExports = captured.factory(requireStub);
check('exports apply', typeof moduleExports.apply === 'function');
check('exports inject=[slots]', Array.isArray(moduleExports.inject) && moduleExports.inject[0] === 'slots', moduleExports.inject);

// ---- slot registration -----------------------------------------------------
let registration = null;
let injectedKey = null;
const fakeSlots = {
  inject(key, callback) {
    injectedKey = key;
    const disposer = callback();
    return () => {
      if (typeof disposer === 'function') disposer();
    };
  },
  register(meta, component) {
    registration = { meta, component };
    return () => {
      registration = null;
    };
  },
};
const fakeCtx = {
  get: (name) => (name === 'slots' ? fakeSlots : undefined),
  effect: (fn) => fn(),
};

moduleExports.apply(fakeCtx);
check('registers through slots.inject', injectedKey === 'conversation.input.right', injectedKey);
check('entry targets conversation.input.right', registration && registration.meta.name === 'conversation.input.right');
check('entry id is prompt-optimizer', registration && registration.meta.id === 'prompt-optimizer');
check('entry order keeps the icon beside the submit action', registration && registration.meta.order === 30, registration && registration.meta.order);
check('component registered', registration && typeof registration.component === 'function');

// ---- render helpers --------------------------------------------------------
function collect(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    node.forEach((child) => collect(child, out));
    return out;
  }
  if (node.type) out.push(node);
  (node.children || []).forEach((child) => collect(child, out));
  return out;
}

function render(props) {
  hooks.reset();
  return registration.component(props);
}

function runButtonOf(tree) {
  return collect(tree).find((node) => String(node.props.className || '').includes('dsh-po-btn'));
}

function textOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((child) => textOf(child, out));
    return out;
  }
  if (typeof node === 'object') (node.children || []).forEach((child) => textOf(child, out));
  return out;
}

function hasText(tree, pattern) {
  return textOf(tree).some((text) => pattern.test(text));
}

const writes = [];
const inputActions = { setDraft: (value) => writes.push(value) };

// ---- render: blank draft is disabled --------------------------------------
{
  const tree = render({ input: { draft: '   ', phase: 'plain' }, inputActions });
  const buttons = collect(tree).filter((node) => node.type === 'button');
  check('blank draft renders one button', buttons.length === 1, buttons.length);
  check('blank draft button is disabled', buttons[0] && buttons[0].props.disabled === true);
}

// ---- render: filled draft is enabled, and the control is icon-only --------
{
  const tree = render({ input: { draft: '帮我写一个排序函数', phase: 'plain' }, inputActions });
  const runButton = runButtonOf(tree);
  check('filled draft enables the button', runButton && runButton.props.disabled === false, runButton && runButton.props.disabled);
  const kids = (runButton && runButton.children) || [];
  check(
    'button renders exactly one svg and no text',
    kids.length === 1 && kids[0] && kids[0].type === 'svg',
    kids.map((child) => (child && child.type) || typeof child),
  );
  check(
    'button exposes an accessible name',
    typeof runButton.props['aria-label'] === 'string' && runButton.props['aria-label'].length > 0,
    runButton.props['aria-label'],
  );
  check('the row carries no composer copy', !hasText(tree, /优化提示词/), textOf(tree));
  check('the row has no label element', collect(tree).every((node) => node.type !== 'label'));
}

// ---- click -> fetch -> setDraft -------------------------------------------
{
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, text: '  优化后的提示词正文  ', provider: 'p', model: 'stub-model', ms: 5 }),
    };
  };

  const tree = render({ input: { draft: '帮我写一个排序函数', phase: 'plain' }, inputActions });
  await runButtonOf(tree).props.onClick();

  check('click posts to the host route', calls.length === 1 && calls[0].url === '/prompt-optimizer/optimize', calls[0] && calls[0].url);
  check('request body carries the draft', calls[0] && JSON.parse(calls[0].init.body).text === '帮我写一个排序函数');
  check('optimized text is written back to the draft', writes.length === 1 && writes[0] === '优化后的提示词正文', writes);
}

// ---- placeholders never reach the draft (works with an older host too) ----
{
  writes.length = 0;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, text: '角色：加固者。输入：{{待补充: 原文}}', provider: 'p', model: 'm' }),
  });
  const tree = render({ input: { draft: '帮我加固这段提示词', phase: 'plain' }, inputActions });
  await runButtonOf(tree).props.onClick();
  check('placeholder output never reaches the draft', writes.length === 0, writes);
}

// ---- gate: server says nothing to change -> draft untouched ---------------
{
  writes.length = 0;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, changed: false, reason: 'already-clear', text: '你好', provider: 'p', model: 'm' }),
  });
  const tree = render({ input: { draft: '你好', phase: 'plain' }, inputActions });
  await runButtonOf(tree).props.onClick();
  check('no-change result leaves the draft alone', writes.length === 0, writes);
}

// ---- failure path: host error surfaces, draft untouched --------------------
{
  writes.length = 0;
  globalThis.fetch = async () => ({
    ok: false,
    status: 503,
    json: async () => ({ ok: false, error: '当前没有默认模型，请先在「设置 → 模型」里选一个' }),
  });
  const tree = render({ input: { draft: 'x', phase: 'plain' }, inputActions });
  await runButtonOf(tree).props.onClick();
  check('failure does not overwrite the draft', writes.length === 0, writes);
}

// ---- phase guard ----------------------------------------------------------
{
  const tree = render({ input: { draft: 'hi', phase: 'submitting' }, inputActions });
  check('submitting phase disables the button', runButtonOf(tree).props.disabled === true);
}

// ---- no inputActions: nothing to write, stay disabled ---------------------
{
  const tree = render({ input: { draft: 'hi', phase: 'plain' } });
  check('missing inputActions keeps the button disabled', runButtonOf(tree).props.disabled === true);
}

console.log('');
if (failures > 0) {
  console.log(failures + ' CHECK(S) FAILED');
  process.exit(1);
}
console.log('ALL CHECKS PASSED');
