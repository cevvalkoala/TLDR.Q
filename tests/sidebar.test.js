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

function makeSidebar(get) {
  const elements = new Map();
  const timers = new Map();
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
    browser: { runtime: {}, storage: { local: { get }, onChanged: { addListener(fn) { listener = fn; } } } },
    document: { getElementById: getElement, createElement: node },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  return {
    getElement, timers,
    change(entries, area = 'local') { listener({ entries: { newValue: entries } }, area); },
    tick() {
      assert.equal(timers.size, 1);
      const [id, timer] = timers.entries().next().value;
      assert.equal(timer.delay, 5000);
      timers.delete(id);
      timer.fn();
    }
  };
}

const running = [{ id: '1', title: 'Article', status: 'running' }];
const done = [{ id: '1', title: 'Article', status: 'done', summary: 'Finished summary' }];
const text = node => [node.textContent, ...node.children.flatMap(child => text(child))].join(' ');

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
