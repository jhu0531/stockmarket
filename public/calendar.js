const TYPE_LABEL = {
  IPO_SUBSCRIBE: '공모청약',
  IPO_LIST: '신규상장',
  RATE_KR: '금통위',
  RATE_US: 'FOMC',
  HOLIDAY: '휴장일',
};

const TYPE_CLASS = {
  IPO_SUBSCRIBE: 'dot-ipo',
  IPO_LIST: 'dot-ipo',
  RATE_KR: 'dot-rate',
  RATE_US: 'dot-rate',
  HOLIDAY: 'dot-holiday',
};

const WEEKDAY_KR = ['일', '월', '화', '수', '목', '금', '토'];

function formatDateLabel(dateStr) {
  const d = new Date(`${dateStr}T00:00:00+09:00`);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const weekday = WEEKDAY_KR[d.getDay()];
  return `${month}/${day} (${weekday})`;
}

const listEl = document.getElementById('calendar-list');

function renderCalendar(events) {
  listEl.innerHTML = '';

  if (!events.length) {
    listEl.innerHTML = '<li class="calendar-empty">표시할 예정 일정이 없습니다.</li>';
    return;
  }

  let currentDate = null;
  events.forEach((event) => {
    if (event.date !== currentDate) {
      currentDate = event.date;
      const dateHeader = document.createElement('li');
      dateHeader.className = 'calendar-date-header';
      dateHeader.textContent = formatDateLabel(event.date);
      listEl.appendChild(dateHeader);
    }

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
    listEl.appendChild(li);
  });
}

async function loadCalendar() {
  try {
    const res = await fetch('/api/calendar');
    if (!res.ok) throw new Error('요청 실패');
    const data = await res.json();
    renderCalendar(data.events);
  } catch (err) {
    listEl.innerHTML = '<li class="calendar-empty">일정을 불러오지 못했습니다.</li>';
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
