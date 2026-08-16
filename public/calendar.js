const TYPE_LABEL = {
  IPO_SUBSCRIBE: '공모청약',
  IPO_LIST: '신규상장',
  RATE_KR: '금통위',
  RATE_US: 'FOMC',
  HOLIDAY: '휴장일',
  GOV: '정부일정',
};

const TYPE_CLASS = {
  IPO_SUBSCRIBE: 'dot-ipo',
  IPO_LIST: 'dot-ipo',
  RATE_KR: 'dot-rate',
  RATE_US: 'dot-rate',
  HOLIDAY: 'dot-holiday',
  GOV: 'dot-gov',
};

const WEEKDAY_KR = ['일', '월', '화', '수', '목', '금', '토'];

function todayLocalDateString() {
  // KST-safe "today" string, independent of the browser's own timezone.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
}

const today = todayLocalDateString();
let [viewYear, viewMonth] = today.split('-').map(Number); // viewMonth is 1-12
let selectedDate = today;
let eventsByDate = new Map();

const gridEl = document.getElementById('calendar-grid');
const titleEl = document.getElementById('cal-title');
const detailListEl = document.getElementById('calendar-day-list');
const detailTitleEl = document.getElementById('calendar-day-title');

function pad2(n) {
  return String(n).padStart(2, '0');
}

function renderDayDetail(dateStr) {
  selectedDate = dateStr;
  const [, m, d] = dateStr.split('-').map(Number);
  const weekday = WEEKDAY_KR[new Date(`${dateStr}T00:00:00+09:00`).getDay()];
  detailTitleEl.textContent = `${m}/${d} (${weekday})${dateStr === today ? ' · 오늘' : ''}`;

  const events = eventsByDate.get(dateStr) || [];
  detailListEl.innerHTML = '';

  if (!events.length) {
    detailListEl.innerHTML = '<li class="calendar-empty">이 날짜에는 표시할 일정이 없습니다.</li>';
    return;
  }

  events.forEach((event) => {
    const li = document.createElement('li');
    li.className = 'calendar-item';

    const dot = document.createElement('span');
    dot.className = `legend-dot ${TYPE_CLASS[event.type] || ''}`;

    const body = document.createElement('div');
    body.className = 'calendar-item-body';

    const titleRow = document.createElement('div');
    titleRow.className = 'calendar-item-title';
    const badge = document.createElement('span');
    badge.className = 'calendar-badge';
    badge.textContent = TYPE_LABEL[event.type] || event.type;
    titleRow.appendChild(badge);

    if (event.link) {
      const link = document.createElement('a');
      link.href = event.link.startsWith('http') ? event.link : `https://finance.naver.com${event.link}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = event.title;
      titleRow.appendChild(link);
    } else {
      const span = document.createElement('span');
      span.textContent = event.title;
      titleRow.appendChild(span);
    }

    body.appendChild(titleRow);

    if (event.detail) {
      const detail = document.createElement('p');
      detail.className = 'calendar-item-detail';
      detail.textContent = event.detail;
      body.appendChild(detail);
    }

    li.appendChild(dot);
    li.appendChild(body);
    detailListEl.appendChild(li);
  });
}

function renderMonthGrid() {
  titleEl.textContent = `${viewYear}년 ${viewMonth}월`;
  gridEl.innerHTML = '';

  WEEKDAY_KR.forEach((wd) => {
    const cell = document.createElement('div');
    cell.className = 'calendar-weekday';
    cell.textContent = wd;
    gridEl.appendChild(cell);
  });

  const firstOfMonth = new Date(Date.UTC(viewYear, viewMonth - 1, 1));
  const startWeekday = firstOfMonth.getUTCDay();
  const daysInMonth = new Date(Date.UTC(viewYear, viewMonth, 0)).getUTCDate();

  for (let i = 0; i < startWeekday; i += 1) {
    const spacer = document.createElement('div');
    spacer.className = 'calendar-cell calendar-cell-empty';
    gridEl.appendChild(spacer);
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const dateStr = `${viewYear}-${pad2(viewMonth)}-${pad2(day)}`;
    const events = eventsByDate.get(dateStr) || [];

    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'calendar-cell';
    if (dateStr === today) cell.classList.add('is-today');
    if (dateStr === selectedDate) cell.classList.add('is-selected');

    const num = document.createElement('span');
    num.className = 'calendar-cell-num';
    num.textContent = String(day);
    cell.appendChild(num);

    if (events.length) {
      const dots = document.createElement('span');
      dots.className = 'calendar-cell-dots';
      events.slice(0, 4).forEach((event) => {
        const dot = document.createElement('span');
        dot.className = `calendar-cell-dot ${TYPE_CLASS[event.type] || ''}`;
        dots.appendChild(dot);
      });
      cell.appendChild(dots);
    }

    cell.addEventListener('click', () => {
      renderDayDetail(dateStr);
      renderMonthGrid();
    });

    gridEl.appendChild(cell);
  }
}

document.getElementById('cal-prev').addEventListener('click', () => {
  viewMonth -= 1;
  if (viewMonth < 1) {
    viewMonth = 12;
    viewYear -= 1;
  }
  renderMonthGrid();
});

document.getElementById('cal-next').addEventListener('click', () => {
  viewMonth += 1;
  if (viewMonth > 12) {
    viewMonth = 1;
    viewYear += 1;
  }
  renderMonthGrid();
});

async function loadCalendar() {
  try {
    const res = await fetch('/api/calendar');
    if (!res.ok) throw new Error('요청 실패');
    const data = await res.json();

    eventsByDate = new Map();
    data.events.forEach((event) => {
      if (!eventsByDate.has(event.date)) eventsByDate.set(event.date, []);
      eventsByDate.get(event.date).push(event);
    });

    renderMonthGrid();
    renderDayDetail(selectedDate);
  } catch (err) {
    gridEl.innerHTML = '<div class="calendar-empty">일정을 불러오지 못했습니다.</div>';
  }
}

function hideLoadingOverlay() {
  const overlay = document.getElementById('loading-overlay');
  if (!overlay) return;
  overlay.classList.add('hidden');
  setTimeout(() => overlay.remove(), 600);
}

const minDisplayTime = new Promise((resolve) => setTimeout(resolve, 1500));
Promise.all([loadCalendar(), minDisplayTime]).finally(hideLoadingOverlay);
