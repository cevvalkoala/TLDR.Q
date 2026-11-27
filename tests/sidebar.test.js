'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'sidebar.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeSidebar(get, options = {}) {
  const elements = new Map();
  const timers = new Map();
  const intervals = new Map();
  let listener, nextTimer = 0;
  function node() {
    return {
      textContent: '', children: [],
      addEventListener() {}, setAttribute() {},
      append(child) { this.children.push(child); },
      replaceChildren() { this.children = []; }
    };
  }
  function getElement(id) {
    if (!elements.has(id)) elements.set(id, node());
    return elements.get(id);
  }
  vm.runInNewContext(source, {
    browser: { runtime: options.runtime || {}, ...(options.chromePanel ? { sidePanel: {} } : {}), storage: { local: { get }, onChanged: { addListener(fn) { listener = fn; } } } },
    document: { getElementById: getElement, createElement: node },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, delay) { const id = ++nextTimer; intervals.set(id, { fn, delay }); return id; },
    clearInterval(id) { intervals.delete(id); }
  });
  return {
    getElement, timers, intervals,
    change(entries, area = 'local') { listener({ entries: { newValue: entries } }, area); },
    changeOrder(order, area = 'local') { listener({ sidebarOrder: { newValue: order } }, area); },
    tick() {
      assert.equal(timers.size, 1);
      const [id, timer] = timers.entries().next().value;
      assert.equal(timer.delay, 5000);
      timers.delete(id);
      timer.fn();
    }
  };
}

test('Chrome panel reconnects after worker disconnect and stops its previous heartbeat', async () => {
  const ports = [];
  const runtime = { connect(details) {
    assert.equal(details.name, 'sidebar');
    const port = { messages: [], postMessage(message) { this.messages.push(message); }, onDisconnect: { addListener(fn) { port.disconnect = fn; } } };
    ports.push(port);
    return port;
  } };
  const ui = makeSidebar(async () => ({ entries: [] }), { chromePanel: true, runtime });
  await flush();
  assert.equal(ports.length, 1);
  const heartbeat = [...ui.intervals.values()][0];
  assert.equal(heartbeat.delay, 20000);
  heartbeat.fn();
  assert.deepEqual(ports[0].messages, ['open']);
  ports[0].disconnect();
  assert.equal(ui.intervals.size, 0);
  const [id, retry] = [...ui.timers.entries()][0];
  assert.equal(retry.delay, 1000);
  ui.timers.delete(id);
  retry.fn();
  assert.equal(ports.length, 2);
  assert.equal(ui.intervals.size, 1);
});

const running = [{ id: '1', title: 'Article', status: 'running' }];
const done = [{ id: '1', title: 'Article', status: 'done', summary: 'Finished summary' }];
const text = node => [node.textContent, ...node.children.flatMap(child => text(child))].join(' ');
const titles = ui => ui.getElement('entries').children.map(article => article.children[0].children[0].textContent);

test('sidebar defaults to newest at top and changes order without changing stored entries', async () => {
  const entries = [
    { id: '1', title: 'First', status: 'done', summary: 'First summary' },
    { id: '2', title: 'Second', status: 'running' },
    { id: '3', title: 'Third', status: 'queued' }
  ];
  const ui = makeSidebar(async () => ({ entries }));
  await flush();
  assert.deepEqual(titles(ui), ['Third', 'Second', 'First']);
  ui.changeOrder('oldest-first');
  assert.deepEqual(titles(ui), ['First', 'Second', 'Third']);
  assert.deepEqual(entries.map(entry => entry.id), ['1', '2', '3']);
  const appended = [...entries, { id: '4', title: 'Fourth', status: 'queued' }];
  ui.change(appended);
  assert.deepEqual(titles(ui), ['First', 'Second', 'Third', 'Fourth']);
  ui.changeOrder('newest-first');
  assert.deepEqual(titles(ui), ['Fourth', 'Third', 'Second', 'First']);
});

test('sidebar loads saved order and ignores unrelated storage areas', async () => {
  const entries = [{ id: '1', title: 'First', status: 'done' }, { id: '2', title: 'Second', status: 'done' }];
  const ui = makeSidebar(async () => ({ entries, sidebarOrder: 'oldest-first' }));
  await flush();
  assert.deepEqual(titles(ui), ['First', 'Second']);
  ui.changeOrder('newest-first', 'sync');
  assert.deepEqual(titles(ui), ['First', 'Second']);
  ui.changeOrder(undefined);
  assert.deepEqual(titles(ui), ['Second', 'First']);
});

test('initial entries and order reads cannot overwrite newer independent changes', async () => {
  const initial = deferred();
  const entries = [{ id: '1', title: 'First', status: 'done' }, { id: '2', title: 'Second', status: 'done' }];
  const ui = makeSidebar(() => initial.promise);
  ui.changeOrder('oldest-first');
  initial.resolve({ entries, sidebarOrder: 'newest-first' });
  await flush();
  assert.deepEqual(titles(ui), ['First', 'Second']);

  const otherInitial = deferred();
  const other = makeSidebar(() => otherInitial.promise);
  other.change(entries);
  otherInitial.resolve({ entries: [], sidebarOrder: 'oldest-first' });
  await flush();
  assert.deepEqual(titles(other), ['First', 'Second']);
});

test('newer storage events cannot be overwritten by an older initial read', async () => {
  const initial = deferred();
  const ui = makeSidebar(() => initial.promise);
  ui.change(done);
  initial.resolve({ entries: running });
  await flush();
  assert.match(text(ui.getElement('entries')), /Finished summary/);
  assert.doesNotMatch(text(ui.getElement('entries')), /Summarizing/);
  assert.equal(ui.timers.size, 0);
});

test('pending entries reconcile a missed completion without reopening the sidebar', async () => {
  let entries = running;
  const ui = makeSidebar(async () => ({ entries }));
  await flush();
  assert.match(text(ui.getElement('entries')), /Summarizing/);
  entries = done;
  ui.tick();
  await flush();
  assert.match(text(ui.getElement('entries')), /Finished summary/);
  assert.equal(ui.timers.size, 0);
});

test('unchanged pending polls preserve entry nodes and keep polling', async () => {
  let entries = [{ ...running[0], text: 'Captured source' }, done[0]];
  const ui = makeSidebar(async () => ({ entries }));
  await flush();
  const original = [...ui.getElement('entries').children];
  entries = [{ ...running[0], text: 'Different captured source' }, { ...done[0] }];
  ui.tick();
  await flush();
  assert.equal(ui.getElement('entries').children[0], original[0]);
  assert.equal(ui.getElement('entries').children[1], original[1]);
  assert.equal(ui.timers.size, 1);

  entries = [{ ...running[0], status: 'done', summary: 'New summary' }, done[0]];
  ui.tick();
  await flush();
  assert.notEqual(ui.getElement('entries').children[0], original[0]);
  assert.match(text(ui.getElement('entries')), /New summary/);
  assert.equal(ui.timers.size, 0);
});

test('stale polling reads and unrelated events cannot restore deleted work', async () => {
  const delayed = deferred();
  let count = 0;
  const ui = makeSidebar(() => ++count === 1 ? Promise.resolve({ entries: running }) : delayed.promise);
  await flush();
  ui.tick();
  ui.change(done, 'sync');
  assert.match(text(ui.getElement('entries')), /Summarizing/);
  ui.change([]);
  delayed.resolve({ entries: running });
  await flush();
  assert.match(text(ui.getElement('entries')), /No summaries yet/);
  assert.equal(ui.timers.size, 0);
});

test('pending refresh retries after storage read errors', async () => {
  let count = 0;
  const ui = makeSidebar(() => ++count === 2 ? Promise.reject(new Error('Storage unavailable')) : Promise.resolve({ entries: count === 1 ? running : done }));
  await flush();
  ui.tick();
  await flush();
  assert.match(ui.getElement('status').textContent, /Storage unavailable/);
  ui.tick();
  await flush();
  assert.match(text(ui.getElement('entries')), /Finished summary/);
  assert.equal(ui.timers.size, 0);
});

test('an unchanged successful refresh clears an earlier storage error', async () => {
  let count = 0;
  const ui = makeSidebar(() => ++count === 2 ? Promise.reject(new Error('Storage unavailable')) : Promise.resolve({ entries: running }));
  await flush();
  const original = ui.getElement('entries').children[0];
  ui.tick();
  await flush();
  assert.match(ui.getElement('status').textContent, /Storage unavailable/);
  ui.tick();
  await flush();
  assert.equal(ui.getElement('entries').children[0], original);
  assert.match(ui.getElement('status').textContent, /1 request in progress or queued/);
  assert.equal(ui.timers.size, 1);
});
