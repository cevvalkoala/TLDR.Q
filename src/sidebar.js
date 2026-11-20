'use strict';
const ext = globalThis.browser ?? globalThis.chrome;
const container = document.getElementById('entries');
const statusLine = document.getElementById('status');

document.getElementById('settings').addEventListener('click', () => ext.runtime.openOptionsPage());

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function usageText(entry) {
  const usage = entry.usage;
  const duration = typeof entry.elapsedMs === 'number' ? ` · ${(entry.elapsedMs / 1000).toFixed(1)} s` : '';
  if (!usage || (usage.input == null && usage.output == null && usage.total == null)) return `Token usage not reported${duration}`;
  const parts = [];
  if (usage.input != null) parts.push(`in ${usage.input}`);
  if (usage.output != null) parts.push(`out ${usage.output}`);
  if (usage.total != null) parts.push(`total ${usage.total}`);
  return `Tokens: ${parts.join(' · ')}${duration}`;
}

function render(entries) {
  container.replaceChildren();
  const pending = entries.filter(entry => entry.status === 'queued' || entry.status === 'running').length;
  statusLine.textContent = pending ? `${pending} request${pending === 1 ? '' : 's'} in progress or queued` : '';
  if (!entries.length) {
    container.append(element('p', 'No summaries yet. Choose a page and click the TLDR.Q toolbar button.', 'empty'));
    return;
  }
  for (const entry of [...entries].reverse()) {
    const article = element('article', null, 'entry');
    const heading = element('div', null, 'heading');
    heading.append(element('h2', entry.title || 'Untitled page'));
    const remove = element('button', entry.status === 'queued' || entry.status === 'running' ? 'Cancel' : 'Delete', 'remove');
    remove.type = 'button';
    remove.setAttribute('aria-label', `${remove.textContent}: ${entry.title || 'Untitled page'}`);
    remove.addEventListener('click', async () => {
      try {
        const result = await ext.runtime.sendMessage({ type: 'delete', id: entry.id });
        if (!result?.ok) throw new Error(result?.error || 'Delete failed.');
      } catch (error) { statusLine.textContent = error.message; }
    });
    heading.append(remove);
    article.append(heading);
    if (entry.status === 'queued') article.append(element('p', 'Queued', 'state'));
    else if (entry.status === 'running') article.append(element('p', 'Summarizing...', 'state'));
    else if (entry.status === 'error') article.append(element('p', entry.error || 'Request failed.', 'error'));
    else {
      article.append(element('p', entry.summary, 'summary'));
      if (entry.truncated) article.append(element('p', 'Long page: only the first 60,000 characters were sent.', 'meta'));
      if (entry.warning) article.append(element('p', `Warning: ${entry.warning}`, 'warning'));
      article.append(element('p', usageText(entry), 'meta'));
    }
    container.append(article);
  }
}

ext.storage.local.get('entries').then(({ entries = [] }) => render(entries)).catch(error => { statusLine.textContent = error.message; });
ext.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.entries) render(changes.entries.newValue || []);
});
