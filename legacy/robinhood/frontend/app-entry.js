import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  getAddress,
  isAddress,
  isHex,
  keccak256,
  parseAbi,
  parseAbiItem,
  parseEther,
  parseUnits,
  toBytes,
} from 'viem';
import { portfolioPerformance } from '../public/portfolio-performance.js';
import '../public/market-clock.js';

const tokenAbi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function decimals() view returns (uint8)',
]);
const votesAbi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function getVotes(address account) view returns (uint256)',
  'function delegates(address account) view returns (address)',
  'function depositFor(address account, uint256 amount) returns (bool)',
  'function withdrawTo(address account, uint256 amount) returns (bool)',
  'function delegate(address delegatee)',
]);
const governorAbi = parseAbi([
  'function state(uint256 proposalId) view returns (uint8)',
  'function hasVoted(uint256 proposalId, address account) view returns (bool)',
  'function castVoteWithReason(uint256 proposalId, uint8 support, string reason) returns (uint256)',
  'function propose(address[] targets, uint256[] values, bytes[] calldatas, string description) returns (uint256)',
  'function queue(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash) returns (uint256)',
  'function execute(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash) payable returns (uint256)',
]);
const treasuryAbi = parseAbi([
  'function paused() view returns (bool)',
  'function owner() view returns (address)',
  'function currentCreatorFeeRecipient() view returns (address)',
  'function claimableCreatorFees() view returns (uint256)',
  'function claimCreatorFees() returns (uint256)',
]);
const proposalCreatedEvent = parseAbiItem(
  'event ProposalCreated(uint256 proposalId, address proposer, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 voteStart, uint256 voteEnd, string description)',
);

const el = id => document.getElementById(id);
const amount = (value, digits = 2) => {
  const number = Number(value);
  return Number.isFinite(number)
    ? new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(number)
    : '—';
};
const short = value => value && value.length > 13 ? value.slice(0, 7) + '…' + value.slice(-5) : value;
const isHash = value => /^0x[0-9a-fA-F]{64}$/.test(value || '');
const isPost = value => /^[0-9]{1,25}$/.test(value || '');
const stateLabels = ['Pending', 'Active', 'Canceled', 'Defeated', 'Succeeded', 'Queued', 'Expired', 'Executed'];
let config = null;
let statusData = null;
let account = null;
let publicClient = null;
let walletClient = null;
let tokenDecimals = 18;
let contractsReady = false;
let toastTimer = null;
let portfolioSignature = null;
let expandedStock = null;
const stockViews = new Map();
const chatStorageKey = 'afterhours-chat-v1';
const chatTurns = [];
let chatBusy = false;

function setText(id, value) {
  const item = el(id);
  if (item) item.textContent = value == null ? '—' : String(value);
}

function notify(message, error = false) {
  const toast = el('site-toast');
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = 'toast' + (error ? ' error' : '');
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 5000);
}

function time(iso) {
  const date = new Date(iso);
  return iso && !Number.isNaN(date.getTime())
    ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(date) + ' ET'
    : '—';
}

function exitTime(iso) {
  const date = new Date(iso);
  return iso && !Number.isNaN(date.getTime())
    ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit' }).format(date) + ' ET'
    : 'Confirmed fill';
}

function renderAgent(data) {
  statusData = data;
  const light = el('agent-light');
  light.className = data.status === 'healthy' ? 'good' : data.status === 'degraded' ? 'bad' : '';
  setText('agent-status', data.status === 'healthy' ? 'Agent online' : data.status === 'degraded' ? 'Last check failed' : 'Status stale');
  setText('agent-mode', data.mode === 'live' ? 'Trading enabled' : 'Read-only mode');

  const portfolio = data.portfolio;
  const valued = portfolio?.treasuryValuationComplete && portfolio?.estimatedTreasuryUsdg != null;
  setText('stat-treasury', valued ? '$' + amount(portfolio.estimatedTreasuryUsdg) : '—');
  setText('portfolio-total', valued ? '$' + amount(portfolio.estimatedTreasuryUsdg) : '—');
  setText('stat-treasury-note', valued ? 'Latest full-balance sell estimate' : 'Waiting for complete quotes');
  setText('portfolio-updated', portfolio?.checkedAt ? 'Checked ' + time(portfolio.checkedAt) : 'Waiting for wallet check');
  setText('stat-fees', '$' + amount(data.totals?.claimedUsdg));
  setText('stat-deployed', '$' + amount(data.totals?.boughtUsdg));
  setText('capital-available', data.funds ? '$' + amount(data.funds.availableUsdg ?? data.funds.earnedAvailableUsdg) : '—');
  setText('oracle-spend', '$' + amount(data.totals?.apiPaidUsdg));
  setText('oracle-count', Number(data.totals?.apiPayments || 0).toLocaleString('en-US') + ' paid signals');
  setText('confirmed-buys', Number(data.totals?.buys || 0).toLocaleString('en-US'));
  setText('confirmed-buy-value', '$' + amount(data.totals?.boughtUsdg) + ' USDG deployed');
  setText('gas-balance', data.funds?.gasEth == null ? '—' : amount(data.funds.gasEth, 5) + ' ETH');
  setText('rule-discount', '≥ ' + amount(data.policy?.minDiscountPct) + '%');
  setText('rule-buy', '$' + amount(data.policy?.buyUsdg) + ' USDG');
  setText('rule-daily', String(data.policy?.maxDailyUsdg) === '0' ? 'No daily cap' : '$' + amount(data.policy?.maxDailyUsdg));
  setText('rule-fee', '$' + amount(data.policy?.maxApiFeeUsdg) + ' USDG');
  setText('footer-sync', 'Synced ' + time(new Date().toISOString()));

  const walletLink = el('agent-wallet-link');
  walletLink.hidden = !isAddress(data.creatorWallet || '');
  if (!walletLink.hidden) walletLink.href = data.explorer + '/address/' + data.creatorWallet;

  renderPortfolio(portfolio);
  if (expandedStock) {
    const view = stockView(expandedStock);
    if (!view.loading && Date.now() - view.fetchedAt > 60_000) loadStockDetail(expandedStock);
  }
  renderLatestAction(data.activity?.[0], data.explorer);
}

function renderTradingPnl(data, exits) {
  const performance = portfolioPerformance(data.portfolio, exits);
  const estimate = Number(performance?.estimatedGrossTradingPnlUsdg);
  const available = performance && Number.isFinite(estimate);
  setText('stat-profit', available ? (estimate >= 0 ? '+' : '−') + '$' + amount(Math.abs(estimate)) : 'Pending');
  el('stat-profit').className = available ? (estimate >= 0 ? 'positive' : 'negative') : '';
  if (exits?.totalVerifiedAcquisitionUsdg != null) {
    setText('stat-deployed', '$' + amount(exits.totalVerifiedAcquisitionUsdg));
    setText('stat-deployed-note', 'Verified onchain acquisitions');
  } else {
    setText('stat-deployed-note', 'Recorded Stock Token buys');
  }
}

function renderPortfolio(portfolio) {
  const { checkedAt, ...holdings } = portfolio || {};
  const signature = JSON.stringify(portfolio ? holdings : null);
  if (signature === portfolioSignature) return;
  portfolioSignature = signature;
  const rows = el('portfolio-rows');
  const bar = el('allocation-bar');
  const legend = el('allocation-legend');
  rows.replaceChildren();
  bar.replaceChildren();
  legend.replaceChildren();
  legend.hidden = true;
  if (!portfolio) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No portfolio data yet.';
    rows.append(empty);
    return;
  }
  const complete = portfolio.treasuryValuationComplete && Number(portfolio.estimatedTreasuryUsdg) > 0;
  const total = Number(portfolio.estimatedTreasuryUsdg);
  const colors = ['#f8f8f4', '#4bea3a', '#7895ff', '#ff9a68', '#f0d56a', '#c895ff'];
  const entries = [
    { ticker: 'USDG', name: 'Treasury cash', balance: portfolio.cashUsdg, value: portfolio.cashUsdg, color: colors[0] },
    ...(portfolio.stocks || []).map((stock, index) => ({ ticker: stock.ticker, name: 'Stock Token', balance: stock.quantity, value: stock.estimatedSellUsdg, color: colors[index % (colors.length - 1) + 1] })),
    ...(portfolio.afterhours ? [{ ticker: '$AFTERHOURS', name: 'Full-balance sell quote',
      balance: portfolio.afterhours.quantity, value: portfolio.afterhours.estimatedSellUsdg, color: '#a6df8e' }] : []),
  ];
  const allocation = [];
  for (const entry of entries) {
    const share = complete && entry.value != null ? Number(entry.value) / total * 100 : NaN;
    const isStock = ['AAPL', 'NVDA'].includes(entry.ticker);
    const row = document.createElement(isStock ? 'button' : 'div');
    row.className = 'holding-row' + (isStock ? ' holding-toggle' : '');
    if (isStock) {
      row.type = 'button';
      row.setAttribute('aria-expanded', String(expandedStock === entry.ticker));
      row.setAttribute('aria-controls', 'stock-details-' + entry.ticker);
      row.addEventListener('click', () => toggleStock(entry.ticker));
    }
    const assetName = document.createElement('span');
    assetName.className = 'asset-name';
    const key = document.createElement('i');
    key.className = 'allocation-key';
    key.style.backgroundColor = entry.color;
    key.setAttribute('aria-hidden', 'true');
    const ticker = document.createElement('b');
    ticker.textContent = entry.ticker;
    const name = document.createElement('small');
    name.textContent = isStock ? (expandedStock === entry.ticker ? 'Hide chart and buys' : 'View chart and buys') : entry.name;
    assetName.append(key, ticker, name);
    const balance = document.createElement('span');
    balance.textContent = entry.balance == null ? '—' : amount(entry.balance,
      ['USDG', '$AFTERHOURS'].includes(entry.ticker) ? 2 : 6);
    const value = document.createElement('span');
    value.textContent = entry.value == null ? '—' : '$' + amount(entry.value);
    const shareCell = document.createElement('span');
    shareCell.textContent = Number.isFinite(share) ? amount(share, 1) + '%' : '—';
    row.append(assetName, balance, value, shareCell);
    if (isStock) {
      const item = document.createElement('div');
      item.className = 'holding-stock';
      const detail = document.createElement('div');
      detail.className = 'stock-detail';
      detail.id = 'stock-details-' + entry.ticker;
      detail.hidden = expandedStock !== entry.ticker;
      item.append(row, detail);
      rows.append(item);
      if (!detail.hidden) renderStockDetail(entry.ticker);
    } else rows.append(row);
    if (Number.isFinite(share) && share > 0) {
      const segment = document.createElement('i');
      segment.style.width = share + '%';
      segment.style.backgroundColor = entry.color;
      segment.title = entry.ticker + ' ' + amount(share, 1) + '%';
      bar.append(segment);
      const legendItem = document.createElement('span');
      legendItem.className = 'allocation-legend-item';
      const swatch = document.createElement('i');
      swatch.style.backgroundColor = entry.color;
      swatch.setAttribute('aria-hidden', 'true');
      const legendTicker = document.createElement('b');
      legendTicker.textContent = entry.ticker;
      const legendShare = document.createElement('span');
      legendShare.textContent = amount(share, 1) + '%';
      legendItem.append(swatch, legendTicker, legendShare);
      legend.append(legendItem);
      allocation.push(entry.ticker + ' ' + amount(share, 1) + '%');
    }
  }
  legend.hidden = allocation.length === 0;
  bar.setAttribute('aria-label', allocation.length ? 'Portfolio allocation: ' + allocation.join(', ') : 'Portfolio allocation unavailable');
}

function stockView(ticker) {
  if (!stockViews.has(ticker)) stockViews.set(ticker, { hours: 24, shown: 12,
    history: null, buys: null, historyError: false, buysError: false, loading: false, fetchedAt: 0 });
  return stockViews.get(ticker);
}

function toggleStock(ticker) {
  expandedStock = expandedStock === ticker ? null : ticker;
  for (const button of document.querySelectorAll('.holding-toggle')) {
    const open = button.getAttribute('aria-controls') === 'stock-details-' + expandedStock;
    button.setAttribute('aria-expanded', String(open));
    button.querySelector('.asset-name small').textContent = open ? 'Hide chart and buys' : 'View chart and buys';
    el(button.getAttribute('aria-controls')).hidden = !open;
  }
  if (expandedStock) {
    renderStockDetail(expandedStock);
    const view = stockView(expandedStock);
    if (!view.loading && Date.now() - view.fetchedAt > 60_000) loadStockDetail(expandedStock);
  }
}

async function loadStockDetail(ticker) {
  const view = stockView(ticker);
  if (view.loading) return;
  view.loading = true;
  renderStockDetail(ticker);
  const load = async path => {
    const response = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Stock detail unavailable');
    return response.json();
  };
  const [history, buys] = await Promise.allSettled([
    load('/history.json?ticker=' + ticker + '&hours=' + view.hours),
    load('/buys.json?ticker=' + ticker),
  ]);
  view.history = history.status === 'fulfilled' ? history.value : null;
  view.historyError = history.status === 'rejected';
  view.buys = buys.status === 'fulfilled' ? buys.value : null;
  view.buysError = buys.status === 'rejected';
  view.loading = false;
  view.fetchedAt = Date.now();
  if (expandedStock === ticker) renderStockDetail(ticker);
}

function stockChart(ticker, history, buys) {
  const figure = document.createElement('figure');
  figure.className = 'stock-chart';
  const points = (history?.points || []).filter(point => Number.isFinite(point.price) &&
    Number.isFinite(point.close) && Number.isFinite(Date.parse(point.at)));
  if (!points.length) {
    const empty = document.createElement('p');
    empty.className = 'stock-detail-empty';
    empty.textContent = 'No recorded pool quotes in this range.';
    figure.append(empty);
    return figure;
  }
  const width = 760, height = 230, left = 12, right = 12, top = 16, bottom = 18;
  const firstTime = Date.parse(points[0].at);
  const lastTime = Date.parse(points.at(-1).at);
  const values = points.flatMap(point => [point.price, point.close]);
  const low = Math.min(...values), high = Math.max(...values);
  const padding = Math.max((high - low) * .12, high * .002, .01);
  const yMin = low - padding, yMax = high + padding;
  const x = (point, index) => firstTime === lastTime
    ? left + (width - left - right) * (points.length === 1 ? .5 : index / (points.length - 1))
    : left + (Date.parse(point.at) - firstTime) / (lastTime - firstTime) * (width - left - right);
  const y = value => top + (yMax - value) / (yMax - yMin) * (height - top - bottom);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${ticker} recorded pool quotes and last NYSE close`);
  const add = (tag, attributes, parent = svg) => {
    const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    parent.append(element);
    return element;
  };
  for (const fraction of [.25, .5, .75]) {
    const lineY = top + fraction * (height - top - bottom);
    add('line', { x1: left, y1: lineY, x2: width - right, y2: lineY, class: 'chart-guide' });
  }
  const path = key => points.map((point, index) =>
    (index ? 'L' : 'M') + x(point, index).toFixed(2) + ',' + y(point[key]).toFixed(2)).join(' ');
  add('path', { d: path('close'), class: 'chart-close' });
  add('path', { d: path('price'), class: 'chart-pool' });
  if (points.length === 1) add('circle', { cx: x(points[0], 0), cy: y(points[0].price), r: 4, class: 'chart-point' });
  for (const buy of buys?.buys || []) {
    const at = Date.parse(buy.at);
    if (!Number.isFinite(at) || at < firstTime || at > lastTime) continue;
    const nearest = points.reduce((best, point, index) =>
      Math.abs(Date.parse(point.at) - at) < Math.abs(Date.parse(points[best].at) - at) ? index : best, 0);
    const marker = add('circle', { cx: x(points[nearest], nearest), cy: y(points[nearest].price), r: 5, class: 'chart-buy' });
    add('title', {}, marker).textContent = `${ticker} bought for ${amount(buy.spentUsdg)} USDG`;
  }
  figure.append(svg);
  const legend = document.createElement('figcaption');
  legend.className = 'stock-chart-legend';
  for (const [className, label] of [['pool', 'Pool quote'], ['close', 'Last NYSE close'], ['buy', 'Confirmed buy']]) {
    const item = document.createElement('span');
    const mark = document.createElement('i');
    mark.className = className;
    item.append(mark, document.createTextNode(label));
    legend.append(item);
  }
  figure.append(legend);
  const axis = document.createElement('div');
  axis.className = 'stock-chart-axis';
  const start = document.createElement('span');
  start.textContent = exitTime(points[0].at);
  const end = document.createElement('span');
  end.textContent = exitTime(points.at(-1).at);
  axis.append(start, end);
  figure.append(axis);
  return figure;
}

function renderStockDetail(ticker) {
  const container = el('stock-details-' + ticker);
  if (!container) return;
  const view = stockView(ticker);
  container.replaceChildren();
  const header = document.createElement('div');
  header.className = 'stock-detail-head';
  const title = document.createElement('div');
  const kicker = document.createElement('span');
  kicker.textContent = ticker + ' / Stock Token';
  const heading = document.createElement('h3');
  heading.textContent = 'Quotes and buys';
  title.append(kicker, heading);
  const ranges = document.createElement('div');
  ranges.className = 'stock-ranges';
  ranges.setAttribute('aria-label', 'Chart range');
  for (const [hours, label] of [[6, '6h'], [24, '24h'], [168, '7d']]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.setAttribute('aria-pressed', String(view.hours === hours));
    button.disabled = view.loading;
    button.addEventListener('click', async () => {
      if (view.hours === hours) return;
      view.hours = hours;
      await loadStockDetail(ticker);
      el('stock-details-' + ticker)?.querySelector('.stock-ranges button[aria-pressed="true"]')?.focus({ preventScroll: true });
    });
    ranges.append(button);
  }
  header.append(title, ranges);
  container.append(header);
  if (view.loading && !view.history && !view.buys) {
    const loading = document.createElement('p');
    loading.className = 'stock-detail-empty';
    loading.textContent = 'Loading recorded quotes and purchase receipts…';
    container.append(loading);
    return;
  }
  if (view.historyError) {
    const error = document.createElement('p');
    error.className = 'stock-detail-empty';
    error.textContent = 'Recorded quotes are temporarily unavailable.';
    container.append(error);
  } else {
    const latest = view.history?.points?.at(-1);
    if (latest) {
      const prices = document.createElement('div');
      prices.className = 'stock-price-strip';
      for (const [label, value] of [['Last recorded quote', latest.price], ['Last NYSE close', latest.close]]) {
        const item = document.createElement('span');
        const name = document.createElement('small');
        name.textContent = label;
        const price = document.createElement('strong');
        price.textContent = amount(value, 4) + ' USDG/token';
        item.append(name, price);
        prices.append(item);
      }
      container.append(prices);
    }
    container.append(stockChart(ticker, view.history, view.buys));
  }
  const caption = document.createElement('p');
  caption.className = 'stock-chart-source';
  caption.textContent = 'Recorded approved-pool quotes at the agent’s configured buy size. Buy markers align with the nearest recorded quote, not the execution price. Up to 400 checks are retained.';
  container.append(caption);
  const buysHead = document.createElement('div');
  buysHead.className = 'stock-buys-head';
  const buysTitle = document.createElement('h4');
  buysTitle.textContent = 'Onchain buys';
  const count = document.createElement('span');
  count.textContent = view.buys?.available ? view.buys.buys.length.toLocaleString('en-US') + ' verified receipts' : 'Receipt index pending';
  buysHead.append(buysTitle, count);
  container.append(buysHead);
  if (view.buysError || !view.buys?.available) {
    const pending = document.createElement('p');
    pending.className = 'stock-detail-empty';
    pending.textContent = view.buysError ? 'Purchase receipts are temporarily unavailable.' :
      'The read-only purchase history is being indexed. Check again after the next agent cycle.';
    container.append(pending);
    return;
  }
  if (!view.buys.buys.length) {
    const empty = document.createElement('p');
    empty.className = 'stock-detail-empty';
    empty.textContent = 'No confirmed agent buys for this stock.';
    container.append(empty);
    return;
  }
  const list = document.createElement('div');
  list.className = 'stock-buy-list';
  for (const buy of view.buys.buys.slice(0, view.shown)) {
    const row = document.createElement('div');
    row.className = 'stock-buy-row';
    const date = document.createElement('time');
    date.dateTime = buy.at;
    date.textContent = exitTime(buy.at);
    const quantity = document.createElement('span');
    quantity.textContent = amount(buy.quantity, 6) + ' tokens';
    const spent = document.createElement('span');
    spent.textContent = '$' + amount(buy.spentUsdg) + ' USDG';
    const paidPerToken = Number(buy.spentUsdg) / Number(buy.quantity);
    if (Number.isFinite(paidPerToken)) {
      const unitPrice = document.createElement('small');
      unitPrice.textContent = amount(paidPerToken, 4) + ' USDG/token paid';
      spent.append(unitPrice);
    }
    const proof = document.createElement('a');
    proof.href = statusData.explorer + '/tx/' + buy.txHash;
    proof.target = '_blank';
    proof.rel = 'noopener noreferrer';
    proof.textContent = 'Verify buy';
    row.append(date, quantity, spent, proof);
    list.append(row);
  }
  container.append(list);
  if (view.shown < view.buys.buys.length) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'stock-load-more';
    more.textContent = 'Show more buys';
    more.addEventListener('click', () => { view.shown += 20; renderStockDetail(ticker); });
    container.append(more);
  }
}

function renderLatestAction(event, explorer) {
  setText('action-time', event ? time(event.at) : '—');
  setText('action-title', event?.title || 'Waiting for the agent');
  setText('action-detail', event?.detail || 'The latest recorded decision will appear here.');
  const proof = el('action-proof');
  proof.hidden = true;
  if (isHash(event?.txHash)) {
    proof.href = explorer + '/tx/' + event.txHash;
    proof.textContent = 'Verify transaction';
    proof.hidden = false;
  } else if (isPost(event?.xPostId)) {
    proof.href = 'https://x.com/i/web/status/' + event.xPostId;
    proof.textContent = 'View X post';
    proof.hidden = false;
  }
}

function renderExits(data, explorer) {
  const rows = el('exit-rows');
  rows.replaceChildren();
  if (!data?.available) {
    setText('exit-count', '—');
    setText('exit-spread', '—');
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.className = 'exit-empty';
    cell.textContent = 'Confirmed sale records are temporarily unavailable.';
    row.append(cell);
    rows.append(row);
    return;
  }
  setText('exit-count', Number(data.count).toLocaleString('en-US'));
  const totalSpread = Number(data.grossSpreadUsdg);
  const spread = el('exit-spread');
  spread.textContent = Number.isFinite(totalSpread)
    ? (data.count ? (totalSpread >= 0 ? '+' : '−') : '') + '$' + amount(Math.abs(totalSpread)) : '—';
  spread.className = Number.isFinite(totalSpread) && data.count
    ? (totalSpread >= 0 ? 'positive' : 'negative') : '';
  if (!data.sales?.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.className = 'exit-empty';
    cell.textContent = 'No confirmed Stock Token sales yet. Completed exits will appear here.';
    row.append(cell);
    rows.append(row);
    return;
  }
  for (const sale of data.sales) {
    const row = document.createElement('tr');
    row.className = 'exit-sale-row';
    const asset = document.createElement('td');
    const ticker = document.createElement('strong');
    ticker.textContent = sale.ticker;
    const detail = document.createElement('small');
    detail.textContent = amount(sale.quantity, 6) + ' tokens' +
      ' · ' + exitTime(sale.filledAt);
    asset.append(ticker, detail);
    const cost = document.createElement('td');
    cost.dataset.label = 'Acquisition cost';
    cost.textContent = '$' + amount(sale.acquisitionCostUsdg);
    const proceeds = document.createElement('td');
    proceeds.dataset.label = 'USDG received';
    proceeds.textContent = '$' + amount(sale.proceedsUsdg);
    const gross = document.createElement('td');
    gross.dataset.label = 'Trading spread';
    const value = Number(sale.grossSpreadUsdg);
    gross.textContent = (value >= 0 ? '+' : '−') + '$' + amount(Math.abs(value));
    gross.className = value >= 0 ? 'positive' : 'negative';
    const receipt = document.createElement('td');
    receipt.dataset.label = 'Onchain receipt';
    if (isHash(sale.txHash)) {
      const link = document.createElement('a');
      link.href = explorer + '/tx/' + sale.txHash;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Verify sale';
      receipt.append(link);
    }
    row.append(asset, cost, proceeds, gross, receipt);
    rows.append(row);
  }
}

async function refreshExits(explorer) {
  try {
    const response = await fetch('/exits.json', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('Confirmed exits unavailable');
    const exits = await response.json();
    renderExits(exits, explorer);
    return exits;
  } catch {
    const unavailable = { available: false };
    renderExits(unavailable);
    return unavailable;
  }
}

function renderBuybacks(data, explorer) {
  const enabled = Boolean(data?.enabled);
  setText('buyback-policy-state', enabled ? 'Agent policy active' : 'Agent policy paused');
  setText('stat-burn', data?.available ? amount(data.totalBurned, 2) : '—');
  setText('stat-burn-note', data?.available
    ? (data.count ? '$' + amount(data.totalSpentUsdg) + ' USDG spent · tokens burned'
      : enabled ? 'No confirmed burn yet' : 'Automatic buybacks disabled')
    : 'Burn ledger unavailable');
  const box = el('buyback-receipts');
  box.replaceChildren();
  if (!data?.count) return;
  const latest = data.burns[0];
  box.append(document.createTextNode('Latest burn: ' + amount(latest.burned, 2) +
    ' $AFTERHOURS from $' + amount(latest.spentUsdg) + ' USDG · '));
  if (isHash(latest.swapTxHash) && isHash(latest.burnTxHash)) {
    for (const [label, hash] of [['Buyback receipt', latest.swapTxHash],
      ['Burn receipt', latest.burnTxHash]]) {
      const link = document.createElement('a');
      link.href = explorer + '/tx/' + hash;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = label;
      box.append(link, document.createTextNode('  '));
    }
  }
}

async function refreshBuybacks(explorer) {
  try {
    const response = await fetch('/buybacks.json', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('Buyback ledger unavailable');
    renderBuybacks(await response.json(), explorer);
  } catch { renderBuybacks({ available: false }, explorer); }
}

async function refreshAgent() {
  try {
    const response = await fetch('/status.json', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('Status unavailable');
    const data = await response.json();
    renderAgent(data);
    const [exits] = await Promise.all([refreshExits(data.explorer), refreshBuybacks(data.explorer)]);
    renderTradingPnl(data, exits);
  } catch {
    setText('agent-status', 'Connection lost');
    el('agent-light').className = 'bad';
  }
}

function deployedConfiguration() {
  const governance = config?.governance;
  return ['deployed', 'local-fork'].includes(governance?.status)
    && Number.isSafeInteger(governance?.deploymentBlock)
    && governance.deploymentBlock >= 0
    && ['votes', 'governor', 'timelock', 'treasury'].every(key => isAddress(governance[key] || ''));
}

function chainDefinition() {
  return {
    id: Number(config.network.chainId),
    name: config.network.name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: config.network.rpcUrl ? [config.network.rpcUrl] : [] } },
    blockExplorers: config.network.explorer ? { default: { name: 'Explorer', url: config.network.explorer } } : undefined,
  };
}

async function loadConfig() {
  const response = await fetch('/dao-config.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('DAO configuration unavailable');
  config = await response.json();
  setText('header-network', config.network?.name || 'Robinhood Chain');
  const ready = deployedConfiguration();
  setText('governance-state', ready ? config.governance.label || 'Configured' : 'Contracts not deployed');
  setText('governance-badge', ready ? 'Contracts configured' : 'Deployment pending');
  setText('footer-contract-state', ready ? config.governance.label || 'Contracts configured' : 'Governance deployment pending');
  el('deployment-strip').className = 'deployment-strip ' + (ready ? '' : 'pending');
  if (ready && config.network.explorer) {
    const link = el('governor-explorer');
    link.href = config.network.explorer + '/address/' + config.governance.governor;
    link.hidden = false;
  }
  el('connect-wallet').disabled = false;
  toggleGovernanceControls(false);
}

function toggleGovernanceControls(enabled) {
  for (const id of ['wrap-button', 'unwrap-button', 'delegate-button', 'claim-fees-button', 'proposal-submit', 'refresh-governance']) {
    const button = el(id);
    if (button) button.disabled = !enabled;
  }
}

function updateWalletButton(chainId) {
  const button = el('connect-wallet');
  if (!config?.network) {
    button.disabled = true;
    return;
  }
  if (!account) {
    button.textContent = 'Connect wallet';
    button.classList.remove('connected');
  } else if (Number(chainId) !== Number(config.network.chainId)) {
    button.textContent = 'Switch network';
    button.classList.remove('connected');
  } else {
    button.textContent = short(account);
    button.classList.add('connected');
  }
}

async function connectWallet() {
  if (!window.ethereum?.request) {
    notify('No EVM browser wallet was detected.', true);
    return;
  }
  try {
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    account = accounts?.[0] ? getAddress(accounts[0]) : null;
    let chainHex = await window.ethereum.request({ method: 'eth_chainId' });
    let chainId = Number.parseInt(chainHex, 16);
    if (chainId !== Number(config.network.chainId)) {
      try {
        await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x' + Number(config.network.chainId).toString(16) }] });
        chainHex = await window.ethereum.request({ method: 'eth_chainId' });
        chainId = Number.parseInt(chainHex, 16);
      } catch (error) {
        if (error?.code === 4902 && config.network.rpcUrl) {
          await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [{
            chainId: '0x' + Number(config.network.chainId).toString(16), chainName: config.network.name,
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: [config.network.rpcUrl],
            blockExplorerUrls: config.network.explorer ? [config.network.explorer] : undefined,
          }] });
          chainId = Number(config.network.chainId);
        } else throw error;
      }
    }
    updateWalletButton(chainId);
    if (!deployedConfiguration()) {
      notify('Wallet connected. Governance contracts are not deployed yet.');
      return;
    }
    const chain = chainDefinition();
    publicClient = createPublicClient({ chain, transport: custom(window.ethereum) });
    walletClient = createWalletClient({ account, chain, transport: custom(window.ethereum) });
    await validateContracts();
    await refreshGovernance();
  } catch (error) {
    notify(error?.shortMessage || error?.message || 'Wallet connection was not completed.', true);
  }
}

async function validateContracts() {
  const addresses = config.governance;
  const code = await Promise.all(['votes', 'governor', 'timelock', 'treasury'].map(key => publicClient.getBytecode({ address: addresses[key] })));
  if (code.some(value => !value || value === '0x')) {
    contractsReady = false;
    el('deployment-strip').className = 'deployment-strip invalid';
    setText('governance-state', 'Configured address has no contract code');
    throw new Error('Governance contract verification failed on the connected network');
  }
  contractsReady = true;
  el('deployment-strip').className = 'deployment-strip';
  setText('governance-state', config.governance.label || 'Contracts verified');
  toggleGovernanceControls(true);
}

async function refreshGovernance() {
  if (!contractsReady || !account) return;
  const addresses = config.governance;
  const [decimals, tokenBalance, wrappedBalance, votingPower, delegatee, treasuryPaused, treasuryOwner, feeRecipient, claimable] = await Promise.all([
    publicClient.readContract({ address: config.token.address, abi: tokenAbi, functionName: 'decimals' }),
    publicClient.readContract({ address: config.token.address, abi: tokenAbi, functionName: 'balanceOf', args: [account] }),
    publicClient.readContract({ address: addresses.votes, abi: votesAbi, functionName: 'balanceOf', args: [account] }),
    publicClient.readContract({ address: addresses.votes, abi: votesAbi, functionName: 'getVotes', args: [account] }),
    publicClient.readContract({ address: addresses.votes, abi: votesAbi, functionName: 'delegates', args: [account] }),
    publicClient.readContract({ address: addresses.treasury, abi: treasuryAbi, functionName: 'paused' }),
    publicClient.readContract({ address: addresses.treasury, abi: treasuryAbi, functionName: 'owner' }),
    publicClient.readContract({ address: addresses.treasury, abi: treasuryAbi, functionName: 'currentCreatorFeeRecipient' }),
    publicClient.readContract({ address: addresses.treasury, abi: treasuryAbi, functionName: 'claimableCreatorFees' }),
  ]);
  tokenDecimals = Number(decimals);
  setText('token-balance', amount(formatUnits(tokenBalance, tokenDecimals), 2));
  setText('votes-balance', amount(formatUnits(wrappedBalance, tokenDecimals), 2));
  setText('voting-power', amount(formatUnits(votingPower, tokenDecimals), 2));
  const selfDelegated = delegatee.toLowerCase() === account.toLowerCase();
  el('delegate-button').textContent = selfDelegated ? 'Votes delegated to this wallet ✓' : 'Delegate existing votes to myself';
  el('delegate-button').disabled = selfDelegated;
  setText('governance-state', `${config.governance.label || 'Contracts verified'} · Treasury ${treasuryPaused ? 'paused' : 'active'}`);
  el('deployment-strip').title = `Treasury owner ${treasuryOwner}; fee recipient ${feeRecipient}; claimable ${formatUnits(claimable, 6)} USDG`;
  await loadProposals();
}

async function sendContract(label, request) {
  notify(label + ' — confirm in your wallet.');
  const hash = await walletClient.writeContract({ account, ...request });
  notify(label + ' submitted. Waiting for confirmation…');
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(label + ' reverted');
  notify(label + ' confirmed.');
  return hash;
}

function parseInput(id) {
  const value = el(id).value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(value) || Number(value) <= 0) throw new Error('Enter a valid token amount');
  return parseUnits(value, tokenDecimals);
}

async function wrapAndDelegate(event) {
  event.preventDefault();
  if (!contractsReady || !account) return notify('Connect a wallet to the deployed governance contracts.', true);
  try {
    const value = parseInput('wrap-amount');
    const [balance, allowance] = await Promise.all([
      publicClient.readContract({ address: config.token.address, abi: tokenAbi, functionName: 'balanceOf', args: [account] }),
      publicClient.readContract({ address: config.token.address, abi: tokenAbi, functionName: 'allowance', args: [account, config.governance.votes] }),
    ]);
    if (balance < value) throw new Error('Amount exceeds your $AFTERHOURS balance');
    if (allowance < value) await sendContract('Approve wrapper', { address: config.token.address, abi: tokenAbi, functionName: 'approve', args: [config.governance.votes, value] });
    await sendContract('Wrap $AFTERHOURS', { address: config.governance.votes, abi: votesAbi, functionName: 'depositFor', args: [account, value] });
    const delegatee = await publicClient.readContract({ address: config.governance.votes, abi: votesAbi, functionName: 'delegates', args: [account] });
    if (delegatee.toLowerCase() !== account.toLowerCase()) await delegateSelf();
    el('wrap-amount').value = '';
    await refreshGovernance();
  } catch (error) {
    notify(error?.shortMessage || error?.message || 'Wrap failed.', true);
  }
}

async function unwrap(event) {
  event.preventDefault();
  if (!contractsReady || !account) return notify('Connect a wallet to the deployed governance contracts.', true);
  try {
    const value = parseInput('unwrap-amount');
    const wrapped = await publicClient.readContract({ address: config.governance.votes, abi: votesAbi, functionName: 'balanceOf', args: [account] });
    if (wrapped < value) throw new Error('Amount exceeds your vAFTERHOURS balance');
    await sendContract('Unwrap vAFTERHOURS', { address: config.governance.votes, abi: votesAbi, functionName: 'withdrawTo', args: [account, value] });
    el('unwrap-amount').value = '';
    await refreshGovernance();
  } catch (error) {
    notify(error?.shortMessage || error?.message || 'Unwrap failed.', true);
  }
}

async function delegateSelf() {
  if (!contractsReady || !account) return notify('Connect a wallet to the deployed governance contracts.', true);
  try {
    await sendContract('Delegate voting power', { address: config.governance.votes, abi: votesAbi, functionName: 'delegate', args: [account] });
    await refreshGovernance();
  } catch (error) {
    notify(error?.shortMessage || error?.message || 'Delegation failed.', true);
  }
}

async function loadProposals() {
  const list = el('proposal-list');
  list.replaceChildren();
  try {
    const logs = await publicClient.getLogs({
      address: config.governance.governor,
      event: proposalCreatedEvent,
      fromBlock: BigInt(config.governance.deploymentBlock || 0),
      toBlock: 'latest',
    });
    setText('proposal-count', logs.length);
    if (!logs.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = 'No proposals have been created.';
      list.append(empty);
      return;
    }
    const proposals = await Promise.all(logs.slice(-12).reverse().map(async log => ({
      ...log.args,
      state: Number(await publicClient.readContract({ address: config.governance.governor, abi: governorAbi, functionName: 'state', args: [log.args.proposalId] })),
      voted: await publicClient.readContract({ address: config.governance.governor, abi: governorAbi, functionName: 'hasVoted', args: [log.args.proposalId, account] }),
    })));
    for (const proposal of proposals) renderProposal(proposal, list);
  } catch (error) {
    setText('proposal-count', '—');
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = error?.shortMessage || 'Proposal history could not be loaded from this RPC.';
    list.append(empty);
  }
}

function renderProposal(proposal, list) {
  const article = document.createElement('article');
  article.className = 'proposal-card';
  const firstLine = (proposal.description || 'Untitled proposal').split('\n').find(Boolean) || 'Untitled proposal';
  const title = firstLine.replace(/^#+\s*/, '').slice(0, 140);
  const meta = document.createElement('div');
  meta.className = 'proposal-meta';
  const state = document.createElement('span');
  state.textContent = stateLabels[proposal.state] || 'Unknown';
  const id = document.createElement('span');
  id.textContent = '#' + proposal.proposalId.toString().slice(0, 8) + '…';
  meta.append(state, id);
  const heading = document.createElement('h3');
  heading.textContent = title;
  const byline = document.createElement('p');
  byline.textContent = `Proposed by ${short(proposal.proposer)}${proposal.voted ? ' · Your vote is recorded' : ''}`;
  article.append(meta, heading, byline);
  if (proposal.state === 1 && !proposal.voted) {
    const actions = document.createElement('div');
    actions.className = 'vote-actions';
    for (const [label, support] of [['Against', 0], ['For', 1], ['Abstain', 2]]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', () => castVote(proposal.proposalId, support, label));
      actions.append(button);
    }
    article.append(actions);
  }
  if (proposal.state === 4 || proposal.state === 5) {
    const actions = document.createElement('div');
    actions.className = 'vote-actions';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = proposal.state === 4 ? 'Queue through Timelock' : 'Execute proposal';
    button.addEventListener('click', () => finalizeProposal(proposal));
    actions.append(button);
    article.append(actions);
  }
  list.append(article);
}

async function castVote(proposalId, support, label) {
  try {
    await sendContract(`Vote ${label}`, { address: config.governance.governor, abi: governorAbi, functionName: 'castVoteWithReason', args: [proposalId, support, ''] });
    await loadProposals();
  } catch (error) {
    notify(error?.shortMessage || error?.message || 'Vote failed.', true);
  }
}

async function createProposal(event) {
  event.preventDefault();
  if (!contractsReady || !account) return notify('Connect a wallet to the deployed governance contracts.', true);
  try {
    const target = el('proposal-target').value.trim();
    const calldata = el('proposal-calldata').value.trim();
    const description = el('proposal-description').value.trim();
    const value = el('proposal-value').value.trim();
    if (!isAddress(target)) throw new Error('Enter a valid target contract address');
    if (!isHex(calldata) || calldata.length % 2 !== 0) throw new Error('Enter valid encoded function calldata');
    if (!description) throw new Error('Enter a proposal title and rationale');
    if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error('Enter a valid ETH value');
    await sendContract('Create proposal', {
      address: config.governance.governor,
      abi: governorAbi,
      functionName: 'propose',
      args: [[getAddress(target)], [parseEther(value)], [calldata], description],
    });
    event.currentTarget.reset();
    el('proposal-value').value = '0';
    await loadProposals();
  } catch (error) {
    notify(error?.shortMessage || error?.message || 'Proposal creation failed.', true);
  }
}

async function finalizeProposal(proposal) {
  const descriptionHash = keccak256(toBytes(proposal.description));
  const queueing = proposal.state === 4;
  try {
    await sendContract(queueing ? 'Queue proposal' : 'Execute proposal', {
      address: config.governance.governor,
      abi: governorAbi,
      functionName: queueing ? 'queue' : 'execute',
      args: [proposal.targets, proposal.values, proposal.calldatas, descriptionHash],
      ...(queueing ? {} : { value: proposal.values.reduce((total, item) => total + item, 0n) }),
    });
    await loadProposals();
  } catch (error) {
    notify(error?.shortMessage || error?.message || (queueing ? 'Queue failed.' : 'Execution failed.'), true);
  }
}

async function claimCreatorFees() {
  if (!contractsReady || !account) return notify('Connect a wallet to the deployed governance contracts.', true);
  try {
    await sendContract('Claim creator fees', { address: config.governance.treasury, abi: treasuryAbi, functionName: 'claimCreatorFees' });
    await refreshGovernance();
  } catch (error) {
    notify(error?.shortMessage || error?.message || 'Creator-fee claim failed.', true);
  }
}

function setupNavigation() {
  const menu = el('menu-toggle');
  const nav = el('site-nav');
  const closeNavigation = () => {
    nav.classList.remove('open');
    menu.setAttribute('aria-expanded', 'false');
    menu.setAttribute('aria-label', 'Open navigation');
  };
  menu.addEventListener('click', () => {
    const open = !nav.classList.contains('open');
    nav.classList.toggle('open', open);
    menu.setAttribute('aria-expanded', String(open));
    menu.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  });
  nav.querySelectorAll('a').forEach(link => link.addEventListener('click', closeNavigation));
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !nav.classList.contains('open')) return;
    closeNavigation();
    menu.focus();
  });
  window.addEventListener('resize', () => {
    if (window.innerWidth > 1040 && nav.classList.contains('open')) closeNavigation();
  });
  if ('IntersectionObserver' in window) {
    const links = [...nav.querySelectorAll('a')].filter(link => link.hash);
    const observer = new IntersectionObserver(entries => {
      const visible = entries.filter(item => item.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (visible) links.forEach(link => link.classList.toggle('active', visible.target.id !== 'overview' && link.hash === '#' + visible.target.id));
    }, { rootMargin: '-25% 0px -60% 0px', threshold: [0, .1, .3] });
    [document.querySelector('#overview'), ...links.map(link => document.querySelector(link.hash))].filter(Boolean).forEach(section => observer.observe(section));
  }
}

function appendChatMessage(role, content) {
  const message = document.createElement('div');
  message.className = 'chat-message chat-message-' + role;
  const speaker = document.createElement('span');
  speaker.textContent = role === 'user' ? 'You' : 'Afterhours';
  const body = document.createElement('p');
  body.textContent = content;
  message.append(speaker, body);
  const history = el('chat-history');
  history.append(message);
  history.scrollTop = history.scrollHeight;
}

function restoreChat() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(chatStorageKey) || '[]');
    if (!Array.isArray(stored)) return;
    for (const turn of stored.slice(-20)) {
      if (!turn || !['user', 'assistant'].includes(turn.role) ||
        typeof turn.content !== 'string' || !turn.content.trim() || turn.content.length > 1600) return;
      chatTurns.push(turn);
      appendChatMessage(turn.role === 'user' ? 'user' : 'agent', turn.content);
    }
  } catch { /* A browser may deny session storage; the current tab can still chat. */ }
}

function saveChat() {
  try { sessionStorage.setItem(chatStorageKey, JSON.stringify(chatTurns)); }
  catch { /* The chat still works for this page load. */ }
}

function setChatBusy(busy) {
  chatBusy = busy;
  el('chat-question').disabled = busy;
  el('chat-send').disabled = busy;
  el('chat-clear').disabled = busy;
  el('chat-send').textContent = busy ? 'Thinking…' : 'Ask';
  document.querySelectorAll('[data-chat-question]').forEach(button => { button.disabled = busy; });
}

async function askAgent(question) {
  const message = question.trim();
  if (chatBusy || !message || message.length > 500) return;
  const priorTurns = chatTurns.slice(-10);
  appendChatMessage('user', message);
  el('chat-question').value = '';
  const status = el('chat-status');
  status.classList.remove('error');
  status.textContent = 'Reading public agent data…';
  setChatBusy(true);
  try {
    const response = await fetch('/chat.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history: priorTurns }),
      signal: AbortSignal.timeout(20000),
    });
    const result = await response.json();
    if (!response.ok || typeof result.answer !== 'string') {
      throw new Error(result.error || 'The agent could not answer. Try again shortly.');
    }
    appendChatMessage('agent', result.answer);
    chatTurns.push({ role: 'user', content: message }, { role: 'assistant', content: result.answer });
    if (chatTurns.length > 20) chatTurns.splice(0, chatTurns.length - 20);
    saveChat();
    status.textContent = 'AI answer based on public agent data and this conversation.';
  } catch (error) {
    el('chat-question').value = message;
    status.classList.add('error');
    status.textContent = error.name === 'TimeoutError'
      ? 'The agent took too long. Try again shortly.'
      : error.message || 'The agent could not answer. Try again shortly.';
  } finally {
    setChatBusy(false);
    el('chat-question').focus();
  }
}

function setupEvents() {
  el('connect-wallet').addEventListener('click', connectWallet);
  el('wrap-form').addEventListener('submit', wrapAndDelegate);
  el('unwrap-form').addEventListener('submit', unwrap);
  el('proposal-form').addEventListener('submit', createProposal);
  el('delegate-button').addEventListener('click', delegateSelf);
  el('claim-fees-button').addEventListener('click', claimCreatorFees);
  el('refresh-governance').addEventListener('click', refreshGovernance);
  el('chat-form').addEventListener('submit', event => {
    event.preventDefault();
    void askAgent(el('chat-question').value);
  });
  document.querySelectorAll('[data-chat-question]').forEach(button => {
    button.addEventListener('click', () => void askAgent(button.dataset.chatQuestion));
  });
  el('chat-clear').addEventListener('click', () => {
    chatTurns.length = 0;
    try { sessionStorage.removeItem(chatStorageKey); } catch { /* No stored conversation to clear. */ }
    el('chat-history').replaceChildren();
    appendChatMessage('agent', 'What would you like to know about the agent?');
    el('chat-status').textContent = 'Conversation cleared.';
    el('chat-status').classList.remove('error');
    el('chat-question').focus();
  });
  window.ethereum?.on?.('accountsChanged', async accounts => {
    account = accounts?.[0] ? getAddress(accounts[0]) : null;
    const chainHex = account ? await window.ethereum.request({ method: 'eth_chainId' }) : null;
    updateWalletButton(chainHex ? Number.parseInt(chainHex, 16) : null);
    if (account && contractsReady) refreshGovernance();
  });
  window.ethereum?.on?.('chainChanged', () => {
    account = null;
    contractsReady = false;
    toggleGovernanceControls(false);
    updateWalletButton(null);
  });
}

setupNavigation();
const [configuration] = await Promise.allSettled([loadConfig(), refreshAgent()]);
if (configuration.status === 'rejected') notify(configuration.reason?.message || 'DAO configuration unavailable.', true);
setupEvents();
restoreChat();
setInterval(refreshAgent, 10000);
