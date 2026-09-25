// NYSE core session: 9:30 AM–4:00 PM Eastern on trading days.
// Holiday and early-close rules follow https://www.nyse.com/trade/hours-calendars.
const EASTERN = 'America/New_York';
const easternPartsFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: EASTERN, year: 'numeric', month: 'numeric', day: 'numeric',
  hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
});
const openingDateFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: EASTERN, weekday: 'short', month: 'short', day: 'numeric',
});
const earlyCloses = new Set([
  '2026-11-27', '2026-12-24', '2027-11-26',
  '2028-07-03', '2028-11-24',
]);
const holidayCache = new Map();

function partsInEastern(date) {
  return Object.fromEntries(easternPartsFormat.formatToParts(date)
    .filter(part => ['year', 'month', 'day', 'hour', 'minute'].includes(part.type))
    .map(part => [part.type, Number(part.value)]));
}

function easternToUtc(year, month, day, hour, minute = 0) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const atGuess = partsInEastern(new Date(guess));
  const shownAsUtc = Date.UTC(atGuess.year, atGuess.month - 1, atGuess.day,
    atGuess.hour, atGuess.minute);
  return guess + (guess - shownAsUtc);
}

function dayKey(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function nthWeekday(year, month, weekday, nth) {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return 1 + ((weekday - first + 7) % 7) + (nth - 1) * 7;
}

function lastWeekday(year, month, weekday) {
  const last = new Date(Date.UTC(year, month, 0));
  return last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7);
}

function goodFriday(year) {
  // Gregorian computus, followed by the Friday before Easter Sunday.
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k + 7 * 6) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  const friday = new Date(Date.UTC(year, month - 1, day - 2));
  return dayKey(friday.getUTCFullYear(), friday.getUTCMonth() + 1, friday.getUTCDate());
}

function addObservedHoliday(holidays, year, month, day, observeSaturday = true) {
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay();
  if (weekday === 0) date.setUTCDate(day + 1);
  else if (weekday === 6 && observeSaturday) date.setUTCDate(day - 1);
  holidays.add(dayKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()));
}

function holidaysFor(year) {
  if (holidayCache.has(year)) return holidayCache.get(year);
  const dates = new Set([
    dayKey(year, 1, nthWeekday(year, 1, 1, 3)), // Martin Luther King Jr. Day
    dayKey(year, 2, nthWeekday(year, 2, 1, 3)), // Washington's Birthday
    goodFriday(year),
    dayKey(year, 5, lastWeekday(year, 5, 1)), // Memorial Day
    dayKey(year, 9, nthWeekday(year, 9, 1, 1)), // Labor Day
    dayKey(year, 11, nthWeekday(year, 11, 4, 4)), // Thanksgiving
  ]);
  // NYSE does not observe a Friday holiday when New Year's Day falls on Saturday.
  addObservedHoliday(dates, year, 1, 1, false);
  addObservedHoliday(dates, year, 6, 19);
  addObservedHoliday(dates, year, 7, 4);
  addObservedHoliday(dates, year, 12, 25);
  holidayCache.set(year, dates);
  return dates;
}

export function marketClock(now = new Date()) {
  const current = partsInEastern(now);
  const base = Date.UTC(current.year, current.month - 1, current.day);
  for (let offset = 0; offset < 15; offset += 1) {
    const date = new Date(base + offset * 86400000);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    const weekday = date.getUTCDay();
    const key = dayKey(year, month, day);
    if (weekday === 0 || weekday === 6 || holidaysFor(year).has(key)) continue;
    const opensAt = easternToUtc(year, month, day, 9, 30);
    if (offset === 0 && now.getTime() >= opensAt) {
      const closesAt = easternToUtc(year, month, day, earlyCloses.has(key) ? 13 : 16);
      if (now.getTime() < closesAt) return { state: 'open', opensAt };
    }
    if (now.getTime() < opensAt) return { state: 'countdown', opensAt };
  }
  return { state: 'unavailable', opensAt: null };
}

export function countdownParts(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  return { days, clock: [hours, minutes, remainingSeconds]
    .map(value => String(value).padStart(2, '0')).join(':') };
}

function renderMarketClock() {
  const banner = document.querySelector('.market-open-banner');
  if (!banner) return;
  const now = new Date();
  const schedule = marketClock(now);
  const heading = document.getElementById('market-open-heading');
  const date = document.getElementById('market-open-date');
  const state = document.getElementById('market-open-state');
  const days = document.getElementById('market-open-days');
  const clock = document.getElementById('market-open-countdown');
  const timing = banner.querySelector('.market-open-timing');
  const foot = timing.querySelector('small');
  const isOpen = schedule.state === 'open';
  banner.classList.toggle('is-open', isOpen);
  state.hidden = isOpen;
  date.hidden = isOpen;
  timing.hidden = isOpen;
  if (schedule.state === 'unavailable') {
    heading.textContent = 'NYSE opening bell';
    date.textContent = 'Schedule unavailable';
    state.textContent = 'Check the NYSE calendar';
    days.textContent = '';
    clock.textContent = '—';
    return;
  }
  date.textContent = `${openingDateFormat.format(schedule.opensAt)} · 9:30 AM ET`;
  if (schedule.state === 'open') {
    heading.textContent = 'Market is open';
  } else {
    heading.textContent = 'Next market open';
    const remaining = countdownParts(schedule.opensAt - now.getTime());
    state.textContent = 'Time until opening bell';
    days.textContent = remaining.days ? `${remaining.days}d` : '';
    clock.textContent = remaining.clock;
    foot.textContent = 'Scheduled open · 9:30 AM ET';
  }
}

if (typeof document !== 'undefined') {
  renderMarketClock();
  window.setInterval(renderMarketClock, 1000);
}
