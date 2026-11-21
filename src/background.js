'use strict';

const ext = globalThis.browser ?? globalThis.chrome;
const isFirefox = typeof globalThis.browser?.runtime?.getBrowserInfo === 'function';
const MAX_CHARS = 60000;
const TIMEOUT_MS = 120000;
const OLLAMA_TIMEOUT_MS = 1800000;
let mutation = Promise.resolve();
let processing = false;
let pendingKick = false;
let activeController = null;
let activeId = null;
const cancelledIds = new Set();
let deleteGeneration = 0;

// Serialize all writes to the shared queue, including deletion during requests.
function updateEntries(fn) {
  const next = mutation.then(async () => {
    const { entries = [] } = await ext.storage.local.get('entries');
    const result = fn(entries);
    await ext.storage.local.set({ entries });
    return result;
  });
  mutation = next.catch(() => {});
  return next;
}

// This function is serialized into the page's isolated scripting world.
function extractPage(maxChars) {
  const root = document.querySelector('article, main, [role="main"]') || document.body;
  if (!root) throw new Error('This page has no readable content.');
  const excluded = 'nav, aside, footer, header, form, script, style, noscript, button, svg, iframe, [hidden], [aria-hidden="true"]';
  const blockTags = new Set(['ADDRESS', 'ARTICLE', 'BLOCKQUOTE', 'CAPTION', 'DD', 'DETAILS', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'LI', 'MAIN', 'OL', 'OPTION', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL']);
  const limit = Math.max(0, maxChars);
  const chunks = [];
  let length = 0;
  let wordCount = 0;
  let pendingSpace = false;

  function styleFor(node) {
    try { return getComputedStyle(node); } catch (_) { return null; }
  }

  function hidden(node, style) {
    return node.matches(excluded) || style?.display === 'none' || style?.visibility === 'hidden';
  }

  function boundary() {
    if (length) pendingSpace = true;
  }

  function append(value) {
    if (length < limit) chunks.push(value.slice(0, limit - length));
    length += value.length;
  }

  function addText(value) {
    const parts = /\s+|\S+/gu;
    let part;
    while ((part = parts.exec(value)) !== null) {
      if (/\s/u.test(part[0][0])) {
        boundary();
      } else {
        if (!length || pendingSpace) wordCount++;
        if (pendingSpace) append(' ');
        pendingSpace = false;
        append(part[0]);
      }
    }
  }

  // Ancestors outside the selected root can hide the entire subtree.
  let ancestor = root.parentElement;
  let rootHidden = false;
  while (ancestor) {
    if (hidden(ancestor, styleFor(ancestor))) { rootHidden = true; break; }
    ancestor = ancestor.parentElement;
  }

  // Walk light-DOM children only; shadow roots and iframe documents are not traversed.
  const stack = rootHidden ? [] : [{ node: root, entered: false, child: 0, separate: false, flex: false }];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    const node = frame.node;
    if (!frame.entered) {
      frame.entered = true;
      if (node.nodeType === 3) {
        addText(node.nodeValue || '');
        stack.pop();
        continue;
      }
      if (node.nodeType !== 1) { stack.pop(); continue; }
      const style = styleFor(node);
      if (hidden(node, style)) { stack.pop(); continue; }
      const display = style?.display;
      frame.separate = node.tagName === 'BR' || node.tagName === 'TD' || node.tagName === 'TH' ||
        (display ? display !== 'inline' && display !== 'contents' : blockTags.has(node.tagName));
      frame.flex = !!display && /\b(?:flex|grid)\b/u.test(display);
      if (frame.separate) boundary();
    }
    if (frame.child < node.childNodes.length) {
      const child = node.childNodes[frame.child++];
      if (frame.flex && (child.nodeType === 1 || frame.previousElement)) boundary();
      frame.previousElement = child.nodeType === 1;
      stack.push({ node: child, entered: false, child: 0, separate: false, flex: false });
    } else {
      if (frame.separate) boundary();
      stack.pop();
    }
  }
  return { title: document.title || 'Untitled page', text: chunks.join(''), wordCount, truncated: length > limit };
}

function newId() {
  return crypto.randomUUID();
}

async function capture(tab, generation = deleteGeneration) {
  if (tab?.incognito) return;
  if (generation !== deleteGeneration) return;
  try {
    if (!tab || !Number.isInteger(tab.id)) throw new Error('No active tab was found.');
    const [{ result }] = await ext.scripting.executeScript({ target: { tabId: tab.id }, func: extractPage, args: [MAX_CHARS] });
    if (!result || !result.text) throw new Error('No readable page text was found.');
    const added = await updateEntries(entries => {
      if (generation !== deleteGeneration) return false;
      const { title, text, wordCount, truncated } = result;
      entries.push({ id: newId(), title, text, wordCount, truncated, status: 'queued', createdAt: Date.now() });
      return true;
    });
    if (added) void processQueue();
  } catch (error) {
    await updateEntries(entries => {
      if (generation !== deleteGeneration) return;
      entries.push({ id: newId(), title: 'Page unavailable', status: 'error', error: 'Could not read this page. It may be empty or restricted; browser pages, extension pages, PDF viewers, and some sites cannot be accessed.', createdAt: Date.now() });
    });
  }
}

function openPanel(tab) {
  try {
    let result;
    if (ext.sidebarAction) result = ext.sidebarAction.open();
    else if (ext.sidePanel && tab?.windowId != null) result = ext.sidePanel.open({ windowId: tab.windowId });
    else return;
    Promise.resolve(result).catch(() => {});
  } catch (_) {
    // Some browser versions reject opening a panel from keyboard gestures.
  }
}

async function checkConsent(config) {
  if (!isFirefox || !config.apiKey) return;
  let granted = false;
  try {
    if (ext.permissions?.getAll && ext.permissions?.contains) {
      const all = await ext.permissions.getAll();
      granted = Array.isArray(all?.data_collection) && await ext.permissions.contains({ data_collection: ['authenticationInfo'] });
    }
  } catch (_) {
    // Missing or unsupported consent APIs must not allow keyed requests.
  }
  if (!granted) throw new Error('Firefox authentication information permission is required to send an API key. Open Settings and save or load models to grant it, or enable it in about:addons under Permissions and data.');
}

// Call the native panel API before any asynchronous work to preserve the gesture.
ext.action.onClicked.addListener(tab => {
  if (tab?.incognito) return;
  openPanel(tab);
  void capture(tab);
});
ext.commands.onCommand.addListener((name, tab) => {
  if (name !== 'summarize' || tab?.incognito) return;
  const generation = deleteGeneration;
  openPanel(tab);
  if (tab?.id != null) void capture(tab, generation);
  else void ext.tabs.query({ active: true, currentWindow: true }).then(tabs => capture(tabs[0], generation));
});

async function processQueue() {
  if (processing) { pendingKick = true; return; }
  processing = true;
  pendingKick = false;
  // Firefox can suspend an event page while fetch is pending, even with the sidebar open.
  const heartbeat = isFirefox ? setInterval(() => {
    try { Promise.resolve(ext.runtime.getPlatformInfo()).catch(() => {}); } catch (_) {}
  }, 10000) : null;
  try {
    await recovered;
    while (true) {
      const generation = deleteGeneration;
      const job = await updateEntries(entries => {
        const item = entries.find(entry => entry.status === 'queued');
        if (item) {
          item.status = 'running';
          activeId = item.id;
          activeController = new AbortController();
        }
        return item ? { ...item } : null;
      });
      if (!job) break;
      const started = Date.now();
      const controller = activeController;
      let timedOut = false;
      let timeoutMs = TIMEOUT_MS;
      let timer;
      let result;
      let errorMessage;
      try {
        const { config } = await ext.storage.local.get('config');
        if (controller.signal.aborted || cancelledIds.has(job.id) || generation !== deleteGeneration) throw new Error('Request canceled.');
        if (!config) throw new Error('Configure an AI provider and model in Settings first.');
        const validated = TLDRProviders.validateConfig(config);
        timeoutMs = validated.provider === 'ollama' ? OLLAMA_TIMEOUT_MS : TIMEOUT_MS;
        timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
        if (config.prompt === TLDRProviders.defaultPrompt && job.wordCount < 350) {
          result = { text: `This page contains approximately ${job.wordCount} words, fewer than 350. It was not summarized.`, usage: null };
        } else {
          await checkConsent(validated);
          if (controller.signal.aborted || cancelledIds.has(job.id) || generation !== deleteGeneration) throw new Error('Request canceled.');
          result = await TLDRProviders.summarize(validated, job, controller.signal, { beforeRequest: () => checkConsent(validated) });
        }
      } catch (error) {
        errorMessage = timedOut ? `The request timed out after ${timeoutMs / 1000} seconds.` : (error?.message || 'The request failed.');
      } finally {
        clearTimeout(timer);
        cancelledIds.delete(job.id);
      }
      const elapsedMs = Date.now() - started;
      await updateEntries(entries => {
        const item = entries.find(entry => entry.id === job.id);
        if (!item) return;
        item.status = errorMessage ? 'error' : 'done';
        if (errorMessage) item.error = errorMessage;
        else { item.summary = result.text; item.usage = result.usage; if (result.warning) item.warning = result.warning; }
        item.elapsedMs = elapsedMs;
        delete item.text;
      });
      activeId = null;
      activeController = null;
    }
  } finally {
    if (heartbeat !== null) clearInterval(heartbeat);
    processing = false;
    if (pendingKick) void processQueue();
  }
}

const recovered = updateEntries(entries => {
  // A stopped event page or service worker cannot keep its previous request alive.
  for (const entry of entries) {
    delete entry.url;
    if (entry.status === 'running') entry.status = 'queued';
  }
});
recovered.then(() => processQueue()).catch(() => {});
ext.runtime.onStartup.addListener(() => { void processQueue(); });
ext.runtime.onInstalled.addListener(() => { void processQueue(); });

ext.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== ext.runtime.id) return false;
  if (message?.type !== 'delete' && message?.type !== 'deleteAll') return false;
  const id = message.id;
  if (message.type === 'deleteAll') deleteGeneration++;
  else cancelledIds.add(id);
  if (message.type === 'deleteAll' || id === activeId) activeController?.abort();
  updateEntries(entries => {
    if (message.type === 'deleteAll') entries.splice(0);
    else {
      const index = entries.findIndex(entry => entry.id === id);
      if (index >= 0) entries.splice(index, 1);
    }
  }).then(() => respond({ ok: true }), error => respond({ ok: false, error: error.message }));
  return true;
});
