import { watchAuthState, loginWithGoogle, logout, getIdToken } from './firebase-init.js';

const authStatusEl = document.getElementById('auth-status');
const loginBtn = document.getElementById('login-btn');
const logoutBtn = document.getElementById('logout-btn');
const contentEl = document.getElementById('valuation-content');
const loginRequiredEl = document.getElementById('valuation-login-required');
const listEl = document.getElementById('valuation-list');

loginBtn.addEventListener('click', () => {
  loginWithGoogle().catch((err) => alert('로그인에 실패했습니다: ' + err.message));
});

logoutBtn.addEventListener('click', () => {
  logout();
});

function hideLoadingOverlay() {
  const overlay = document.getElementById('loading-overlay');
  if (!overlay) return;
  overlay.classList.add('hidden');
  setTimeout(() => overlay.remove(), 600);
}

const initialAuth = new Promise((resolveInitialAuth) => {
  watchAuthState((user) => {
    if (user) {
      authStatusEl.textContent = `${user.displayName || user.email}님으로 로그인됨`;
      loginBtn.hidden = true;
      logoutBtn.hidden = false;
      contentEl.hidden = false;
      loginRequiredEl.hidden = true;
      loadValuations();
    } else {
      authStatusEl.textContent = '로그인이 필요합니다.';
      loginBtn.hidden = false;
      logoutBtn.hidden = true;
      contentEl.hidden = true;
      loginRequiredEl.hidden = false;
    }
    resolveInitialAuth();
  });
});

async function loadValuations() {
  const token = await getIdToken();
  try {
    const res = await fetch('/api/watchlist', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error('요청 실패');
    const data = await res.json();
    renderValuations(data.items || []);
  } catch (err) {
    listEl.innerHTML = '<li class="calendar-empty">적정주가를 불러오지 못했습니다.</li>';
  }
}

const VERDICT_LABEL = { UNDERVALUED: '저평가', OVERVALUED: '고평가', FAIR: '적정' };
const VERDICT_CLASS = { UNDERVALUED: 'up', OVERVALUED: 'down', FAIR: 'flat' };

function renderValuations(items) {
  listEl.innerHTML = '';

  if (!items.length) {
    listEl.innerHTML =
      '<li class="calendar-empty">관심종목이 없습니다. <a href="/watchlist.html">관심종목</a>에서 먼저 추가해주세요.</li>';
    return;
  }

  items.forEach((item) => {
    const li = document.createElement('li');
    li.className = 'valuation-card';

    const name = document.createElement('p');
    name.className = 'valuation-name';
    name.textContent = item.name || item.code;
    li.appendChild(name);

    if (item.error || !item.fairValue) {
      const empty = document.createElement('p');
      empty.className = 'valuation-empty';
      empty.textContent = '적정주가를 계산할 데이터가 없습니다 (적자기업이거나 실적 데이터 없음).';
      li.appendChild(empty);
      listEl.appendChild(li);
      return;
    }

    const current = document.createElement('p');
    current.className = 'valuation-current';
    current.innerHTML = `<span class="valuation-label">현재가</span><span class="valuation-value">${
      item.currentPrice !== null ? item.currentPrice.toLocaleString() + '원' : '-'
    }</span>`;
    li.appendChild(current);

    li.appendChild(renderFairValueBlock('확정 실적 기준', item.fairValue.confirmed));
    if (item.fairValue.consensus) {
      li.appendChild(renderFairValueBlock('컨센서스(추정) 기준', item.fairValue.consensus));
    }

    listEl.appendChild(li);
  });
}

function renderFairValueBlock(title, fv) {
  const block = document.createElement('div');
  block.className = 'valuation-block';

  const heading = document.createElement('p');
  heading.className = 'valuation-block-title';
  heading.textContent = title;
  block.appendChild(heading);

  const row = document.createElement('div');
  row.className = 'valuation-row';
  row.innerHTML = `<span class="valuation-label">적정주가</span><span class="valuation-value">${fv.fairValue.toLocaleString()}원</span>`;
  block.appendChild(row);

  if (fv.verdict) {
    const badge = document.createElement('span');
    badge.className = `valuation-badge ${VERDICT_CLASS[fv.verdict]}`;
    const sign = fv.gapRatio > 0 ? '+' : '';
    badge.textContent = `${VERDICT_LABEL[fv.verdict]} (${sign}${fv.gapRatio.toFixed(1)}%)`;
    block.appendChild(badge);
  }

  const meta = document.createElement('p');
  meta.className = 'valuation-meta';
  meta.textContent = `${fv.period} 기준 · EPS ${fv.eps.toLocaleString()}원${
    fv.roe !== null ? ` · ROE ${fv.roe}%` : ''
  }${fv.bps !== null ? ` · BPS ${fv.bps.toLocaleString()}원` : ''}`;
  block.appendChild(meta);

  return block;
}

const minDisplayTime = new Promise((resolve) => setTimeout(resolve, 1500));
Promise.all([initialAuth, minDisplayTime]).finally(hideLoadingOverlay);
