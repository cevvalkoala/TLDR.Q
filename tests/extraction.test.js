'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'background.js'), 'utf8');
const start = source.indexOf('function extractPage(');
const end = source.indexOf('\n}', start);
assert.ok(start >= 0 && end > start, 'extractPage function exists');
const serializedFunction = source.slice(start, end + 2);

function text(value) {
  return { nodeType: 3, nodeValue: value };
}

function element(tag, options = {}, ...children) {
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    childNodes: children.map(child => typeof child === 'string' ? text(child) : child),
    attributes: options.attributes || {},
    display: options.display || 'inline',
    visibility: options.visibility || 'visible',
    styleThrows: options.styleThrows || false,
    matches(selector) {
      const selectors = selector.split(',').map(item => item.trim());
      return selectors.includes(this.tagName.toLowerCase()) ||
        (selectors.includes('[hidden]') && Object.hasOwn(this.attributes, 'hidden')) ||
        (selectors.includes('[aria-hidden="true"]') && this.attributes['aria-hidden'] === 'true');
    }
  };
  for (const child of node.childNodes) child.parentElement = node;
  return node;
}

function extract(root, maxChars = 60000, options = {}) {
  const document = {
    title: options.title === undefined ? 'Test page' : options.title,
    body: options.body === undefined ? root : options.body,
    querySelector: () => options.selected === false ? null : root
  };
  const context = {
    document,
    getComputedStyle(node) {
      if (node.styleThrows) throw new Error('style unavailable');
      return { display: node.display, visibility: node.visibility };
    }
  };
  Object.defineProperty(context, 'location', { get() { throw new Error('location must not be accessed'); } });
  return vm.runInNewContext(`(${serializedFunction})`, context)(maxChars);
}

test('separates table cells and CSS blocks while preserving inline adjacency', () => {
  const root = element('article', {},
    element('table', { display: 'table' }, element('tr', { display: 'table-row' },
      element('th', { display: 'inline' }, 'Heading'), element('td', { display: 'inline' }, 'Value'))),
    element('span', { display: 'block' }, 'Block'),
    element('p', { display: 'block' }, element('b', {}, 'foo'), 'bar'));
  const result = extract(root);
  assert.equal(result.text, 'Heading Value Block foobar');
  assert.equal(result.wordCount, 4);
});

test('separates inline flex and grid children, including anonymous text items', () => {
  const root = element('main', {},
    element('div', { display: 'flex' }, element('span', {}, 'one'), element('span', {}, 'two'), 'three'),
    element('div', { display: 'inline-grid' }, element('span', {}, 'four'), element('span', {}, 'five')));
  const result = extract(root);
  assert.equal(result.text, 'one two three four five');
  assert.equal(result.wordCount, 5);
});

test('skips excluded tags, attributes, and computed hidden subtrees', () => {
  const excluded = ['nav', 'aside', 'footer', 'header', 'form', 'script', 'style', 'noscript', 'button', 'svg', 'iframe'];
  const root = element('article', {}, 'before',
    ...excluded.map(tag => element(tag, {}, 'secret')),
    element('span', { attributes: { hidden: '' } }, 'secret'),
    element('span', { attributes: { 'aria-hidden': 'true' } }, 'secret'),
    element('span', { display: 'none' }, 'secret'),
    element('span', { visibility: 'hidden' }, element('span', {}, 'secret')),
    element('br'), 'after');
  assert.equal(extract(root).text, 'before after');
});

test('does not expose content in a hidden ancestor or excluded root', () => {
  const root = element('article', {}, 'secret');
  element('div', { display: 'none' }, root);
  assert.equal(extract(root).text, '');
  assert.equal(extract(element('article', { attributes: { hidden: '' } }, 'secret')).wordCount, 0);
});

test('falls back to semantic block tags when computed style throws', () => {
  const root = element('article', {}, element('dt', { styleThrows: true }, 'term'),
    element('dd', { styleThrows: true }, 'definition'), element('span', {}, 'inline'));
  assert.equal(extract(root).text, 'term definition inline');
});

test('normalizes Unicode whitespace across nodes and does not read or return a URL', () => {
  const result = extract(element('article', {}, '  alpha\u00a0', element('b', {}, 'beta'), '\u2003gamma\n'));
  assert.equal(result.text, 'alpha beta gamma');
  assert.equal(result.wordCount, 3);
  assert.deepEqual(Object.keys(result).sort(), ['text', 'title', 'truncated', 'wordCount']);
});

test('does not enter shadow roots or iframe documents', () => {
  const host = element('span', {}, 'light');
  host.shadowRoot = element('div', {}, 'shadow');
  const frame = element('iframe', {}, 'fallback');
  frame.contentDocument = { body: element('body', {}, 'frame') };
  assert.equal(extract(element('article', {}, host, frame)).text, 'light');
});

test('counts all 350 words beyond the character cap', () => {
  const root = element('article', {}, Array.from({ length: 350 }, (_, i) => `word${i}`).join(' '));
  const result = extract(root, 12);
  assert.equal(result.text, 'word0 word1 ');
  assert.equal(result.wordCount, 350);
  assert.equal(result.truncated, true);
  assert.equal(extract(root, 0).wordCount, 350);
  assert.equal(extract(element('article', {}, Array(349).fill('word').join(' ')), 5).wordCount, 349);
});

test('walks deeply nested pages without exhausting the call stack', () => {
  let root = element('span', {}, 'deep');
  for (let i = 0; i < 12000; i++) root = element('span', {}, root);
  assert.equal(extract(root).text, 'deep');
});

test('reports exact caps and ignores trailing normalized whitespace', () => {
  const root = element('article', {}, ' alpha  beta \n');
  assert.equal(extract(root, 10).text, 'alpha beta');
  assert.equal(extract(root, 10).truncated, false);
  assert.equal(extract(root, 9).truncated, true);
  assert.equal(extract(element('article', {}, ' \u00a0 '), 0).truncated, false);
});

test('uses body fallback, untitled fallback, and rejects pages with no root', () => {
  const body = element('body', {}, 'fallback');
  const result = extract(null, 100, { body, selected: false, title: '' });
  assert.equal(result.text, 'fallback');
  assert.equal(result.title, 'Untitled page');
  assert.throws(() => extract(null, 100), /no readable content/);
});
