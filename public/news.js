const REFRESH_INTERVAL_MS = 120000;

function renderNews(listEl, items, emptyText) {
  listEl.innerHTML = '';

  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'news-item news-empty';
    li.textContent = emptyText;
    listEl.appendChild(li);
    return;
  }

  items.forEach((item) => {
    const li = document.createElement('li');
    li.className = 'news-item';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'news-toggle';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.textContent = item.title;

    const detail = document.createElement('div');
    detail.className = 'news-detail';
    detail.hidden = true;

    const summary = document.createElement('p');
    summary.className = 'news-summary';
    summary.textContent = item.summary;

    const meta = document.createElement('span');
    meta.className = 'news-meta';
    meta.textContent = [item.press, item.time].filter(Boolean).join(' · ');

    const link = document.createElement('a');
    link.className = 'news-link';
    link.href = item.link;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = '원문 보기';

    if (item.summary) detail.appendChild(summary);
    detail.appendChild(meta);
    detail.appendChild(link);

    toggle.addEventListener('click', () => {
      const isOpen = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!isOpen));
      detail.hidden = isOpen;
      li.classList.toggle('open', !isOpen);
    });

    li.appendChild(toggle);
    li.appendChild(detail);
    listEl.appendChild(li);
  });
}

// Wires up one news section: fetch/render function, its section-collapse
// toggle button, and returns the loader so it can be called on refresh/interval.
function setupNewsSection({ apiUrl, listId, toggleId, emptyText, errorText }) {
  const listEl = document.getElementById(listId);
  const toggleEl = document.getElementById(toggleId);

  toggleEl.addEventListener('click', () => {
    const isOpen = toggleEl.getAttribute('aria-expanded') === 'true';
    toggleEl.setAttribute('aria-expanded', String(!isOpen));
    toggleEl.textContent = isOpen ? '펼치기' : '접기';
    listEl.hidden = isOpen;
  });

  return async function load() {
    try {
      const res = await fetch(apiUrl);
      if (!res.ok) throw new Error('요청 실패');
      const data = await res.json();
      renderNews(listEl, data.news, emptyText);
    } catch (err) {
      renderNews(listEl, [], errorText);
    }
  };
}

const loadNyNews = setupNewsSection({
  apiUrl: '/api/ny-news',
  listId: 'ny-news-list',
  toggleId: 'news-section-toggle',
  emptyText: '표시할 뉴욕증시 뉴스가 없습니다.',
  errorText: '뉴욕증시 뉴스를 불러오지 못했습니다.',
});

// 국내뉴스 has two sub-lists (거시경제/미시경제) sharing one section toggle
// and one API call, so it doesn't fit the single-list setupNewsSection shape.
function setupKrNewsSection() {
  const bodyEl = document.getElementById('kr-news-body');
  const toggleEl = document.getElementById('kr-news-section-toggle');
  const macroListEl = document.getElementById('kr-news-macro-list');
  const microListEl = document.getElementById('kr-news-micro-list');

  toggleEl.addEventListener('click', () => {
    const isOpen = toggleEl.getAttribute('aria-expanded') === 'true';
    toggleEl.setAttribute('aria-expanded', String(!isOpen));
    toggleEl.textContent = isOpen ? '펼치기' : '접기';
    bodyEl.hidden = isOpen;
  });

  return async function load() {
    try {
      const res = await fetch('/api/kr-news');
      if (!res.ok) throw new Error('요청 실패');
      const data = await res.json();
      renderNews(macroListEl, data.macro, '표시할 거시경제 뉴스가 없습니다.');
      renderNews(microListEl, data.micro, '표시할 미시경제 뉴스가 없습니다.');
    } catch (err) {
      renderNews(macroListEl, [], '거시경제 뉴스를 불러오지 못했습니다.');
      renderNews(microListEl, [], '미시경제 뉴스를 불러오지 못했습니다.');
    }
  };
}

const loadKrNews = setupKrNewsSection();

function hideLoadingOverlay() {
  const overlay = document.getElementById('loading-overlay');
  if (!overlay) return;
  overlay.classList.add('hidden');
  setTimeout(() => overlay.remove(), 600);
}

const initialLoad = Promise.all([loadNyNews(), loadKrNews()]);
const minDisplayTime = new Promise((resolve) => setTimeout(resolve, 1500));
Promise.all([initialLoad, minDisplayTime]).finally(hideLoadingOverlay);

setInterval(loadNyNews, REFRESH_INTERVAL_MS);
setInterval(loadKrNews, REFRESH_INTERVAL_MS);
