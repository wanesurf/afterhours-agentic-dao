export function nextCycleDelay(status, pollMinutes, now = Date.now()) {
  const interval = pollMinutes * 60_000;
  const latest = Math.max(...[status.lastStartedAt, status.lastCompletedAt]
    .map(value => Date.parse(value))
    .filter(Number.isFinite), 0);
  return latest ? Math.min(interval, Math.max(0, latest + interval - now)) : 0;
}
