const state = { status: null, events: [], filter: 'all', nextBefore: null, hasMore: false };
const byId = id => document.getElementById(id);

function categoryFor(type = '') {
  if (/(?:failed|blocked|rejected|stopped|unavailable)$/.test(type) || type === 'cycle_failed') return 'error';
  if (/(?:buy|trade|execution|approval)/.test(type)) return 'trade';
  if (/(?:api|signal|board|route|cost)/.test(type)) return 'data';
  if (/(?:claim|fund|budget|wallet|gas)/.test(type)) return 'funding';
  return 'system';
}

function categoryLabel(category) {
  return { trade: 'Trade', data: 'Data', funding: 'Funding', error: 'Issue', system: 'System' }[category] || 'System';
}

function dateParts(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { day: 'Unknown date', time: '—' };
  return {
    day: new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' }).format(date),
    time: new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(date) + ' ET',
  };
}

function fullDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date) + ' ET';
}

function appendText(parent, tag, text, className) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  item.textContent = text;
  parent.append(item);
  return item;
}

function renderSummary(data) {
  const status = data.status === 'healthy' ? 'Agent online' : data.status === 'degraded' ? 'Needs attention' : 'Status stale';
  byId('current-state').textContent = status;
  byId('current-mode').textContent = data.mode === 'live' ? 'Live execution enabled' : 'Read-only mode';
  byId('last-result').textContent = data.lastResult === 'success' ? 'Completed' : data.lastResult === 'failed' ? 'Failed' : 'Waiting';
  byId('cycle-count').textContent = Number(data.totalCycles || 0).toLocaleString('en-US');
  byId('entry-count').textContent = Number(data.activityRetained || 0).toLocaleString('en-US');
  byId('last-completed').textContent = fullDate(data.lastCompletedAt);
  byId('status-light').className = data.status === 'healthy' ? 'healthy' : data.status === 'degraded' ? 'degraded' : '';
}

function createDecision(event) {
  const category = categoryFor(event.type);
  const article = document.createElement('article');
  article.className = 'decision-entry category-' + category;

  const when = document.createElement('div');
  when.className = 'decision-time';
  const parts = dateParts(event.at);
  appendText(when, 'span', parts.day);
  const time = appendText(when, 'time', parts.time);
  time.dateTime = event.at || '';

  const rail = document.createElement('div');
  rail.className = 'decision-rail';
  appendText(rail, 'i', '', 'decision-dot').setAttribute('aria-hidden', 'true');

  const content = document.createElement('div');
  content.className = 'decision-content';
  const meta = document.createElement('div');
  meta.className = 'decision-meta';
  appendText(meta, 'span', categoryLabel(category));
  if (event.ticker) appendText(meta, 'span', event.ticker, 'ticker');
  if (event.amountUsdg) appendText(meta, 'span', event.amountUsdg + ' USDG');
  appendText(meta, 'span', '#' + event.id);
  content.append(meta);
  appendText(content, 'h3', event.title || 'Recorded decision');
  appendText(content, 'p', event.detail || 'No additional detail was recorded.');

  if (event.txHash || event.xPostId) {
    const links = document.createElement('div');
    links.className = 'decision-links';
    if (event.txHash && state.status?.explorer) {
      const transaction = appendText(links, 'a', 'Verify transaction');
      transaction.href = state.status.explorer + '/tx/' + event.txHash;
      transaction.target = '_blank';
      transaction.rel = 'noopener noreferrer';
    }
    if (event.xPostId) {
      const post = appendText(links, 'a', 'View X post');
      post.href = 'https://x.com/i/web/status/' + event.xPostId;
      post.target = '_blank';
      post.rel = 'noopener noreferrer';
    }
    content.append(links);
  }

  article.append(when, rail, content);
  return article;
}

function renderEvents() {
  const list = byId('decision-list');
  list.replaceChildren();
  const filtered = state.filter === 'all' ? state.events : state.events.filter(event => categoryFor(event.type) === state.filter);
  byId('filter-summary').textContent = filtered.length + (filtered.length === 1 ? ' recorded decision' : ' recorded decisions') + (state.filter === 'all' ? '' : ' in this view');
  if (!filtered.length) {
    appendText(list, 'p', 'No decisions match this filter yet.', 'empty-journal');
  } else {
    filtered.forEach(event => list.append(createDecision(event)));
  }
  byId('load-more').hidden = !state.hasMore;
}

async function loadStatus() {
  const refresh = byId('refresh-decisions');
  refresh.disabled = true;
  refresh.textContent = 'Refreshing…';
  try {
    const response = await fetch('/status.json', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('Status feed unavailable');
    const data = await response.json();
    state.status = data;
    state.events = Array.isArray(data.activity) ? data.activity : [];
    state.nextBefore = state.events.at(-1)?.id || null;
    state.hasMore = Number(data.activityRetained || 0) > state.events.length;
    renderSummary(data);
    renderEvents();
  } catch (error) {
    byId('current-state').textContent = 'Connection lost';
    byId('current-mode').textContent = 'The public status feed could not be loaded';
    byId('status-light').className = 'degraded';
    byId('filter-summary').textContent = error.message;
  } finally {
    refresh.disabled = false;
    refresh.textContent = 'Refresh data';
  }
}

async function loadMore() {
  if (!state.nextBefore) return;
  const button = byId('load-more');
  button.disabled = true;
  button.textContent = 'Loading…';
  try {
    const response = await fetch('/activity.json?limit=100&before=' + encodeURIComponent(state.nextBefore), { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('Earlier decisions unavailable');
    const page = await response.json();
    state.events.push(...(page.events || []));
    state.nextBefore = page.nextBefore;
    state.hasMore = Boolean(page.hasMore);
    renderEvents();
  } catch (error) {
    byId('filter-summary').textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Load earlier decisions';
  }
}

document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
  state.filter = button.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  renderEvents();
}));
byId('refresh-decisions').addEventListener('click', loadStatus);
byId('load-more').addEventListener('click', loadMore);
loadStatus();
