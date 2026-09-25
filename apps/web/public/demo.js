const $ = id => document.getElementById(id);
const node = (tag, text, className) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; };
const usd = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(value);
let record;
async function read(url) { const res = await fetch(url); if (!res.ok) throw new Error('The live source could not be reached. Refresh to try again.'); return res.json(); }
function fact(list, label, value) { const item = node('div'); item.append(node('dt', label), node('dd', value)); list.append(item); }
function threshold(x) { return x.type === 'Disabled' ? 'Disabled' : `${x.percent ?? 'Unknown'}% (${x.type})`; }
async function governance() {
  const target = $('governance');
  try {
    const data = await read('/api/governance'); target.replaceChildren();
    const facts = node('dl', undefined, 'facts');
    fact(facts, 'Community vote threshold', threshold(data.communityVoteThreshold));
    fact(facts, 'Council vote threshold', threshold(data.councilVoteThreshold));
    fact(facts, 'Voting period', `${data.votingSeconds / 3600} hours`);
    fact(facts, 'Execution delay', `${data.holdUpSeconds / 3600} hours`);
    fact(facts, 'Native treasury balance', `${Number(data.nativeTreasury.balanceLamports) / 1e9} SOL`);
    fact(facts, 'Proposal count in this governance', String(data.proposals.length)); target.append(facts);
    target.append(node('p', `Community proposal threshold: ${data.communityProposalWeightRaw} raw voting units. Council threshold: ${data.councilProposalWeightRaw}. These are onchain voting weights, not a website wallet-balance check.`, 'small-note'));
    const wrap = node('div', undefined, 'table-wrap'), table = node('table', undefined, 'proposals'), head = node('tr');
    for (const label of ['Proposal', 'Population', 'State', 'Instructions']) head.append(node('th', label));
    const thead = node('thead'); thead.append(head); table.append(thead); const tbody = node('tbody');
    for (const proposal of data.proposals) {
      const row = node('tr'), cell = node('td'), link = node('a', proposal.name);
      link.href = `https://explorer.solana.com/address/${encodeURIComponent(proposal.address)}`; link.target = '_blank'; link.rel = 'noopener noreferrer'; cell.append(link);
      row.append(cell, node('td', proposal.population), node('td', proposal.state), node('td', `${proposal.executedInstructions} / ${proposal.instructions} executed`)); tbody.append(row);
    }
    table.append(tbody); wrap.append(table); target.append(wrap);
    if (!data.proposals.length) target.append(node('p', 'No proposals found for this governance account.'));
    target.append(node('p', `Finalized Solana reads at slots ${data.finalizedSlots.join(', ')}. Checked ${new Date(data.observedAt).toLocaleString()}. Proposal instructions have not been reviewed or accepted as an execution mandate.`, 'small-note'));
  } catch (error) { target.replaceChildren(node('p', error.message, 'disclosure')); }
}
async function prices() {
  const target = $('prices');
  try {
    const data = await read('/api/markets'); const available = data.state.markets.filter(row => row.price).length;
    const entitlementMissing = data.state.markets.some(row => row.issues.includes('PYTH_FEED_NOT_ENTITLED'));
    $('price-source').textContent = data.mode !== 'live' ? 'Sample data · Pyth key not configured' : entitlementMissing ? 'Pyth Pro · feed access required' : available === 3 ? 'Pyth Pro · live prices' : 'Pyth Pro · data incomplete';
    const list = node('dl', undefined, 'facts');
    for (const row of data.state.markets) {
      const item = node('div'); item.append(node('dt', row.symbol), node('dd', row.price ? usd(row.price.priceUsd) : 'Unavailable'));
      item.append(node('p', row.issues.length ? row.issues.map(issue => issue === 'PYTH_FEED_NOT_ENTITLED' ? 'This key does not have access to this feed.' : issue).join(', ') : 'Quality checks passed', 'small-note')); list.append(item);
    }
    target.replaceChildren(list, node('p', available < 3 ? 'Price comparison is unavailable until all three feeds respond.' : data.scan.signals.length ? `${data.scan.signals.length} price gap(s) above 50 bps. Venue quotes and approved capital are still required.` : 'No qualifying price gap is reported by this read. The system should wait.', 'small-note'));
  } catch(error) { $('price-source').textContent = 'Data unavailable'; target.replaceChildren(node('p', error.message, 'disclosure')); }
}
async function refresh() { $('refresh-evidence').disabled = true; try { await Promise.allSettled([governance(), prices()]); } finally { $('refresh-evidence').disabled = false; } }
$('refresh-evidence').addEventListener('click', refresh);
$('run-rehearsal').addEventListener('click', async () => {
  $('run-rehearsal').disabled = true;
  record = undefined; $('download-record').disabled = true; $('record-json').textContent = 'Running…'; $('record-hash').textContent = '';
  try {
    record = await read(`/api/demo/rehearsal?scenario=${encodeURIComponent($('scenario').value)}`);
    const target = $('rehearsal-result'); target.replaceChildren(node('h3', record.policyDecision === 'PRECHECK_PASS' ? 'Precheck passed. Execution blocked.' : 'Policy rejected this trade.', 'decision-heading'));
    target.append(node('p', 'Synthetic test case · no funds moved', 'small-note')); const list = node('ol', undefined, 'stage-list');
    for (const stage of record.stages) { const li = node('li'), head = node('div', undefined, 'stage-head'); head.append(node('span', stage.name), node('span', stage.status, stage.status.toLowerCase())); li.append(head, node('p', stage.detail)); list.append(li); }
    target.append(list); $('record-hash').textContent = `SHA-256: ${record.recordHash}`; $('record-json').textContent = JSON.stringify(record, null, 2); $('download-record').disabled = false;
  } catch(error) { $('rehearsal-result').replaceChildren(node('p', error.message, 'disclosure')); $('record-json').textContent = 'No record generated.'; }
  finally { $('run-rehearsal').disabled = false; }
});
$('download-record').addEventListener('click', () => {
  if (!record) return; const url = URL.createObjectURL(new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' }));
  const a = node('a'); a.href = url; a.download = `afterhours-${record.scenario}-${record.recordHash.slice(0, 12)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
refresh();
