const SIGNAL_LABEL = {
  FAVORABLE: '우호',
  UNFAVORABLE: '비우호',
};

const KOSPI_DIRECTION_LABEL = {
  RISING: '▲ 상승',
  FALLING: '▼ 하락',
  EVEN: '- 보합',
};

const summaryCard = document.getElementById('stats-summary-card');
const summaryLabelEl = document.getElementById('stats-summary-label');
const summaryDetailEl = document.getElementById('stats-summary-detail');
const tableBodyEl = document.getElementById('stats-table-body');

function formatDate(dateStr) {
  const [, month, day] = dateStr.split('-');
  return `${month}/${day}`;
}

function renderSummary(summary) {
  summaryCard.classList.remove('up', 'down', 'flat');

  if (!summary || summary.total === 0) {
    summaryCard.classList.add('flat');
    summaryLabelEl.textContent = '아직 데이터 없음';
    summaryDetailEl.textContent = '내일부터 하루 1건씩 이력이 쌓입니다.';
    return;
  }

  const accuracy = summary.accuracy.toFixed(1);
  summaryCard.classList.add(summary.accuracy >= 50 ? 'up' : 'down');
  summaryLabelEl.textContent = `적중률 ${accuracy}%`;
  summaryDetailEl.textContent = `총 ${summary.total}건 중 ${summary.correct}건 적중`;
}

function renderTable(rows) {
  tableBodyEl.innerHTML = '';

  if (!rows.length) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="5" class="stats-empty">표시할 이력이 없습니다.</td>';
    tableBodyEl.appendChild(tr);
    return;
  }

  rows.forEach((row) => {
    const tr = document.createElement('tr');

    const dateTd = document.createElement('td');
    dateTd.textContent = formatDate(row.date);

    const labelTd = document.createElement('td');
    labelTd.textContent = SIGNAL_LABEL[row.signalLabel] || row.signalLabel;
    labelTd.className = row.signalLabel === 'FAVORABLE' ? 'up' : 'down';

    const scoreTd = document.createElement('td');
    scoreTd.textContent = row.signalScore > 0 ? `+${row.signalScore}` : String(row.signalScore);

    const kospiTd = document.createElement('td');
    kospiTd.textContent = row.kospiDirection ? KOSPI_DIRECTION_LABEL[row.kospiDirection] || row.kospiDirection : '집계중';

    const correctTd = document.createElement('td');
    if (row.correct === null || row.correct === undefined) {
      correctTd.textContent = '-';
      correctTd.className = 'flat';
    } else {
      correctTd.textContent = row.correct ? '적중' : '불일치';
      correctTd.className = row.correct ? 'up' : 'down';
    }

    tr.appendChild(dateTd);
    tr.appendChild(labelTd);
    tr.appendChild(scoreTd);
    tr.appendChild(kospiTd);
    tr.appendChild(correctTd);
    tableBodyEl.appendChild(tr);
  });
}

async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    if (!res.ok) throw new Error('요청 실패');
    const data = await res.json();
    renderSummary(data.summary);
    renderTable(data.rows);
  } catch (err) {
    summaryCard.classList.remove('up', 'down');
    summaryCard.classList.add('flat');
    summaryLabelEl.textContent = '불러오지 못했습니다';
    summaryDetailEl.textContent = '잠시 후 다시 시도해주세요.';
    tableBodyEl.innerHTML = '<tr><td colspan="5" class="stats-empty">불러오지 못했습니다.</td></tr>';
  }
}

function hideLoadingOverlay() {
  const overlay = document.getElementById('loading-overlay');
  if (!overlay) return;
  overlay.classList.add('hidden');
  setTimeout(() => overlay.remove(), 600);
}

const minDisplayTime = new Promise((resolve) => setTimeout(resolve, 1500));
Promise.all([loadStats(), minDisplayTime]).finally(hideLoadingOverlay);
