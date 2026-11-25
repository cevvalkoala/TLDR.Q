'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
require('../src/providers.js');

function makeOptions(options = {}) {
  const elements = new Map();
  const requests = [];
  const writes = [];
  const checks = [];
  const modelCalls = [];
  const shortcutUpdates = [];
  let shortcut = options.shortcut ?? 'Alt+Shift+Q';
  const consent = { granted: options.granted !== false, supported: options.supported !== false };
  function getElement(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', hidden: false, disabled: false, children: [],
      classList: { toggle() {} },
      addEventListener(name, handler) { this[name] = handler; },
      replaceChildren() { this.children = []; }, append(node) { this.children.push(node); }, blur() { this.blurred = true; }
    });
    return elements.get(id);
  }
  const browser = {
    permissions: {
      request(request) { requests.push(request); return options.request ? options.request(request) : Promise.resolve(true); },
      async getAll() { return consent.supported ? { data_collection: consent.granted ? ['authenticationInfo'] : [] } : {}; },
      async contains(request) { checks.push(request); return consent.granted; }
    },
    storage: { local: {
      async get() { return options.stored || {}; },
      async set(value) {
        if (options.setError) throw new Error(options.setError);
        writes.push(value);
      }
    } },
    commands: options.firefox ? {
      async getAll() { return [{ name: 'summarize', shortcut }]; },
      async update(update) {
        shortcutUpdates.push(update);
        if (options.updateError) throw new Error(options.updateError);
        shortcut = options.unassigned ? '' : update.shortcut;
      },
      async reset() { shortcut = 'Alt+Shift+Q'; }
    } : {},
    runtime: options.firefox ? { getBrowserInfo() {} } : {}
  };
  const providers = { ...globalThis.TLDRProviders, async listModels(config, hooks) {
    modelCalls.push(config);
    if (options.listModels) return options.listModels(config, hooks, consent);
    await hooks.beforeRequest();
    return ['model'];
  } };
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'options.js'), 'utf8');
  vm.runInNewContext(source, {
    browser, TLDRProviders: providers, URL, Promise,
    document: { getElementById: getElement, createElement() { return {}; } },
    navigator: { userAgent: options.firefox ? 'Firefox/144.0' : 'Chrome', platform: options.platform || 'Win32' }, confirm: () => true
  });
  return { getElement, requests, writes, checks, modelCalls, consent, browser, shortcutUpdates };
}

async function readyOptions(options = {}) {
  const ui = makeOptions(options);
  await new Promise(resolve => setImmediate(resolve));
  ui.getElement('provider').value = 'ollama';
  ui.getElement('base-url').value = 'http://localhost:11434';
  ui.getElement('model').value = 'model';
  ui.getElement('api-key').value = options.key === undefined ? 'secret' : options.key;
  return ui;
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('sidebar order defaults to newest first and saves independently of provider settings', async () => {
  const ui = makeOptions();
  await flush();
  const order = ui.getElement('sidebar-order');
  assert.equal(order.value, 'newest-first');
  assert.equal(order.disabled, false);
  order.value = 'oldest-first';
  await order.change();
  assert.deepEqual(JSON.parse(JSON.stringify(ui.writes)), [{ sidebarOrder: 'oldest-first' }]);
  assert.equal(ui.requests.length, 0);
  assert.match(ui.getElement('sidebar-order-status').textContent, /saved/i);
});

test('sidebar order loads persisted value and restores it when saving fails', async () => {
  const ui = makeOptions({ stored: { sidebarOrder: 'oldest-first' }, setError: 'Storage unavailable' });
  await flush();
  const order = ui.getElement('sidebar-order');
  assert.equal(order.value, 'oldest-first');
  order.value = 'newest-first';
  await order.change();
  assert.equal(order.value, 'oldest-first');
  assert.equal(order.disabled, false);
  assert.match(ui.getElement('sidebar-order-status').textContent, /Storage unavailable/);
  assert.equal(ui.writes.length, 0);
});

test('settings rejects wildcard URLs before requesting any permission', async () => {
  const ui = makeOptions();
  await new Promise(resolve => setImmediate(resolve));
  ui.getElement('provider').value = 'ollama';
  ui.getElement('model').value = 'model';
  for (const url of ['https://*', 'https://*.example.com', 'https://example.com/%2A']) {
    ui.getElement('base-url').value = url;
    ui.getElement('save').click();
    ui.getElement('load-models').click();
    assert.equal(ui.requests.length, 0, url);
    assert.match(ui.getElement('save-status').textContent, /wildcards/i);
    assert.match(ui.getElement('connection-status').textContent, /wildcards/i);
  }
  assert.equal(ui.writes.length, 0);
});

test('settings requests the specific configured host synchronously', async () => {
  const ui = makeOptions();
  await new Promise(resolve => setImmediate(resolve));
  ui.getElement('provider').value = 'ollama';
  ui.getElement('base-url').value = 'http://localhost:11434/api';
  ui.getElement('model').value = 'model';
  ui.getElement('save').click();
  assert.deepEqual(JSON.parse(JSON.stringify(ui.requests)), [{ origins: ['http://localhost/*'] }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.writes[0].config.baseUrl, 'http://localhost:11434/api');
});

test('Firefox requests host and authentication consent synchronously for save and discovery', async () => {
  const ui = await readyOptions({ firefox: true });
  ui.getElement('save').click();
  assert.deepEqual(JSON.parse(JSON.stringify(ui.requests)), [{ origins: ['http://localhost/*'], data_collection: ['authenticationInfo'] }]);
  await flush();
  assert.equal(ui.writes.length, 1);
  ui.getElement('load-models').click();
  assert.equal(ui.requests.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.requests[1])), { origins: ['http://localhost/*'], data_collection: ['authenticationInfo'] });
  await flush();
  assert.equal(ui.modelCalls.length, 1);
  assert.ok(ui.checks.length >= 2);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.checks[0])), { data_collection: ['authenticationInfo'] });
});

test('Firefox denial or revocation prevents saving and model discovery', async () => {
  for (const scenario of [{ request: () => Promise.resolve(false) }, { granted: false }, { supported: false }, { request: () => Promise.reject(new Error('unsupported')) }]) {
    const ui = await readyOptions({ firefox: true, ...scenario });
    ui.getElement('save').click();
    await flush();
    assert.equal(ui.writes.length, 0);
    assert.match(ui.getElement('save-status').textContent, /authentication information permission/i);
    ui.getElement('load-models').click();
    await flush();
    assert.equal(ui.modelCalls.length, 0);
    assert.match(ui.getElement('connection-status').textContent, /authentication information permission/i);
  }
});

test('model discovery rechecks Firefox consent between requests', async () => {
  let fetches = 0;
  const ui = await readyOptions({ firefox: true, async listModels(config, { beforeRequest }, consent) {
    await beforeRequest();
    fetches++;
    consent.granted = false;
    await beforeRequest();
    fetches++;
    return ['model'];
  } });
  ui.getElement('load-models').click();
  await flush();
  assert.equal(fetches, 1);
  assert.match(ui.getElement('connection-status').textContent, /authentication information permission/i);
});

test('keyless Firefox and keyed Chrome request only the host', async () => {
  for (const scenario of [{ firefox: true, key: '' }, { firefox: false, key: 'secret' }]) {
    const ui = await readyOptions(scenario);
    ui.getElement('save').click();
    assert.deepEqual(JSON.parse(JSON.stringify(ui.requests[0])), { origins: ['http://localhost/*'] });
    await flush();
    assert.equal(ui.writes.length, 1);
    ui.getElement('load-models').click();
    await flush();
    assert.equal(ui.modelCalls.length, 1);
    assert.equal(ui.checks.length, 0);
  }
});

test('model discovery selects the first model while keeping the list editable', async () => {
  const ui = await readyOptions({ key: '', listModels: async () => ['first-model', 'second-model'] });
  ui.getElement('model').value = '';
  ui.getElement('load-models').click();
  await flush();
  assert.equal(ui.getElement('model').value, 'first-model');
  assert.deepEqual(ui.getElement('model-list').children.map(item => item.value), ['first-model', 'second-model']);
  assert.match(ui.getElement('connection-status').textContent, /save settings/i);
  ui.getElement('model').value = 'custom-model';
  ui.getElement('save').click();
  await flush();
  assert.equal(ui.writes[0].config.model, 'custom-model');
});

test('empty or failed discovery does not overwrite the existing model', async () => {
  for (const listModels of [async () => [], async () => { throw new Error('Discovery failed.'); }]) {
    const ui = await readyOptions({ key: '', listModels });
    ui.getElement('model').value = 'existing-model';
    ui.getElement('load-models').click();
    await flush();
    assert.equal(ui.getElement('model').value, 'existing-model');
  }
});

function pressShortcut(ui, key, modifiers = {}) {
  const input = ui.getElement('shortcut');
  const event = { key, currentTarget: input, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...modifiers };
  input.keydown(event);
  return event;
}

test('records Ctrl+Alt+S and applies the Firefox shortcut', async () => {
  const ui = await readyOptions({ firefox: true });
  assert.equal(ui.getElement('shortcut-firefox').hidden, false);
  const input = ui.getElement('shortcut');
  input.focus();
  pressShortcut(ui, 'Control', { ctrlKey: true });
  pressShortcut(ui, 'Alt', { ctrlKey: true, altKey: true });
  assert.equal(input.value, 'Alt+Shift+Q');
  // Firefox on Windows reports AltGraph when Ctrl and Alt are pressed together.
  assert.equal(pressShortcut(ui, 's', { ctrlKey: true, altKey: true, getModifierState: name => name === 'AltGraph' }).defaultPrevented, true);
  assert.equal(input.value, 'Ctrl+Alt+S');
  assert.equal(ui.shortcutUpdates.length, 0);
  ui.getElement('save-shortcut').click();
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(ui.shortcutUpdates)), [{ name: 'summarize', shortcut: 'Ctrl+Alt+S' }]);
  assert.match(ui.getElement('shortcut-status').textContent, /updated/i);
});

test('shortcut recording handles supported keys and macOS modifiers', async () => {
  const ui = await readyOptions({ firefox: true, platform: 'MacIntel' });
  for (const [key, modifiers, expected] of [
    ['s', { metaKey: true, altKey: true, getModifierState: name => name === 'AltGraph' }, 'Command+Alt+S'],
    ['s', { ctrlKey: true, shiftKey: true }, 'MacCtrl+Shift+S'],
    ['ArrowLeft', { metaKey: true }, 'Command+Left'],
    [',', { ctrlKey: true }, 'MacCtrl+Comma'],
    ['F19', {}, 'F19'],
    ['MediaTrackNext', {}, 'MediaNextTrack']
  ]) {
    pressShortcut(ui, key, modifiers);
    assert.equal(ui.getElement('shortcut').value, expected);
  }
});

test('unsupported shortcuts do not overwrite the previous recording', async () => {
  const ui = await readyOptions({ firefox: true });
  const input = ui.getElement('shortcut');
  for (const [key, modifiers] of [
    ['s', {}],
    ['s', { ctrlKey: true, altKey: true, shiftKey: true }],
    ['s', { metaKey: true }],
    ['@', { ctrlKey: true, altKey: true, getModifierState: () => true }],
    ['F1', { shiftKey: true }]
  ]) {
    pressShortcut(ui, key, modifiers);
    assert.equal(input.value, 'Alt+Shift+Q');
    assert.match(ui.getElement('shortcut-status').textContent, /unsupported/i);
  }
  assert.equal(pressShortcut(ui, 'Tab').defaultPrevented, false);
  assert.equal(pressShortcut(ui, 'Escape').defaultPrevented, true);
  assert.equal(input.blurred, true);
});

test('shortcut can be removed, reset, and reports browser assignment failures', async () => {
  const ui = await readyOptions({ firefox: true });
  ui.getElement('remove-shortcut').click();
  await flush();
  assert.equal(ui.shortcutUpdates[0].shortcut, '');
  assert.equal(ui.getElement('shortcut').value, '');
  ui.getElement('reset-shortcut').click();
  await flush();
  assert.equal(ui.getElement('shortcut').value, 'Alt+Shift+Q');

  const rejected = await readyOptions({ firefox: true, updateError: 'Shortcut rejected by browser.' });
  pressShortcut(rejected, 's', { ctrlKey: true, altKey: true });
  rejected.getElement('save-shortcut').click();
  await flush();
  assert.match(rejected.getElement('shortcut-status').textContent, /rejected/i);

  const unassigned = await readyOptions({ firefox: true, unassigned: true });
  pressShortcut(unassigned, 's', { ctrlKey: true, altKey: true });
  unassigned.getElement('save-shortcut').click();
  await flush();
  assert.match(unassigned.getElement('shortcut-status').textContent, /did not assign/i);
});
