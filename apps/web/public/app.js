const labels = {
  "Equity.US.AAPL/USD": { name: "Apple equity", ticker: "AAPL", kind: "Underlying stock" },
  "Crypto.AAPLX/USD": { name: "Apple xStock", ticker: "AAPLX", kind: "Tokenized market" },
  "Crypto.AAPLON/USD": { name: "Apple Ondo", ticker: "AAPLON", kind: "Tokenized market" },
};

const $ = id => document.getElementById(id);
const usd = value => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value);
const bps = value => `${value >= 0 ? "+" : ""}${value.toFixed(1)} bps`;
const time = value => new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value));

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderMarkets(rows, sample) {
  const container = $("markets");
  container.replaceChildren();
  for (const row of rows) {
    const info = labels[row.symbol] || { name: row.symbol, ticker: row.symbol, kind: "Market" };
    const article = el("article", "market-card");
    const heading = el("div", "market-card-heading");
    heading.append(el("span", "market-kind", info.kind), el("span", "market-ticker", info.ticker));
    article.append(heading, el("h3", "market-name", info.name));
    article.append(el("div", "market-price", row.price ? usd(row.price.priceUsd) : "Unavailable"));
    const foot = el("div", "market-foot");
    foot.append(el("span", row.issues.length ? "quality warning" : "quality good", sample ? "Illustrative value" : row.issues.length ? "Needs review" : "Feed checks passed"));
    foot.append(el("span", "market-update", sample ? "Example only" : row.price ? `Updated ${time(row.price.feedUpdatedAtMs)}` : "No update"));
    article.append(foot);
    if (row.issues.length) article.append(el("p", "market-issues", row.issues.join(" · ").replaceAll("_", " ").toLowerCase()));
    container.append(article);
  }
}

function renderBasis(readings) {
  const container = $("basis");
  container.replaceChildren();
  if (!readings.length) {
    container.append(el("p", "empty-state", "Two available feeds are needed to calculate a spread."));
    return;
  }
  for (const reading of readings) {
    const row = el("div", "basis-row");
    const top = el("div", "basis-top");
    top.append(el("span", "basis-pair", `${labels[reading.baseSymbol]?.ticker || reading.baseSymbol} / ${labels[reading.comparisonSymbol]?.ticker || reading.comparisonSymbol}`));
    top.append(el("strong", "basis-value", bps(reading.basisBps)));
    const track = el("div", "basis-track");
    const bar = el("span", `basis-bar ${reading.basisBps < 0 ? "negative" : "positive"}`);
    bar.style.width = `${Math.min(Math.abs(reading.basisBps) / 500 * 100, 100)}%`;
    track.append(bar);
    row.append(top, track);
    container.append(row);
  }
}

function renderSignals(signals) {
  const container = $("signals");
  container.replaceChildren();
  if (!signals.length) {
    container.append(el("p", "empty-state", "No token market is at least 50 bps below the equity reference in this reading."));
    return;
  }
  for (const signal of signals) {
    const row = el("div", "signal-row");
    const head = el("div", "signal-head");
    head.append(el("strong", "signal-name", labels[signal.buySymbol]?.name || signal.buySymbol));
    head.append(el("span", "signal-discount", `${signal.discountBps.toFixed(1)} bps below AAPL`));
    row.append(head, el("p", "signal-warning", "Price dislocation · Trade unavailable"));
    container.append(row);
  }
}

async function refresh() {
  const button = $("refresh-button");
  button.disabled = true;
  $("header-state").textContent = "Reading market data";
  try {
    const response = await fetch("/api/markets", { signal: AbortSignal.timeout(12_000), cache: "no-store" });
    if (!response.ok) throw new Error(`Market service returned ${response.status}`);
    const { mode, state, scan } = await response.json();
    const sample = mode === "sample";
    $("data-mode").textContent = sample ? "Illustrative sample data" : "Pyth Pro data";
    $("source-note").textContent = sample
      ? "No Pyth Pro key is configured. Prices below are examples for the hackathon demo, not current market prices."
      : "Prices were requested from Pyth Pro. Check each feed's update time and quality before drawing conclusions.";
    $("header-state").textContent = sample ? "Sample mode" : "Live feed read";
    const good = state.markets.filter(market => market.price && market.issues.length === 0).length;
    $("market-checks").textContent = sample ? "No live checks in sample mode" : `${good} of ${state.markets.length} feeds passed`;
    $("updated-at").textContent = `${sample ? "Sample rendered" : "Read"} at ${time(state.observedAtMs)}`;
    renderMarkets(state.markets, sample);
    renderBasis(state.basis);
    renderSignals(scan.signals);
  } catch (error) {
    $("header-state").textContent = "Market data unavailable";
    $("data-mode").textContent = "Unable to load feeds";
    $("source-note").textContent = "Check the local web server and its Pyth Pro configuration, then refresh.";
    $("market-checks").textContent = "Read failed";
    $("updated-at").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

$("refresh-button").addEventListener("click", refresh);
refresh();
setInterval(refresh, 15_000);

async function loadDao() {
  try {
    const response = await fetch("/api/dao", { signal: AbortSignal.timeout(12_000), cache: "no-store" });
    if (!response.ok) throw new Error(`DAO service returned ${response.status}`);
    const status = await response.json();
    $("dao-verification").textContent = status.verified ? "Verified on mainnet" : "Account mismatch — review needed";
    $("dao-verification").className = status.verified ? "verified" : "warning";
    $("dao-slot").textContent = `Finalized at Solana slot ${status.finalizedSlot}`;
  } catch {
    $("dao-verification").textContent = "Verification unavailable";
    $("dao-verification").className = "warning";
    $("dao-slot").textContent = "The Realm link remains available. Try again when the RPC responds.";
  }
}

loadDao();
setInterval(loadDao, 60_000);
