const listEl = document.getElementById('report-list');

function formatReportDate(dateStr) {
  // "26.08.14" -> "2026.08.14"
  return dateStr && dateStr.length === 8 ? `20${dateStr}` : dateStr;
}

function renderReports(reports) {
  listEl.innerHTML = '';

  if (!reports.length) {
    listEl.innerHTML = '<li class="calendar-empty">표시할 리포트가 없습니다.</li>';
    return;
  }

  reports.forEach((report) => {
    const li = document.createElement('li');
    li.className = 'report-item';

    const titleLink = document.createElement('a');
    titleLink.className = 'report-title';
    titleLink.href = report.link || '#';
    titleLink.target = '_blank';
    titleLink.rel = 'noopener noreferrer';
    titleLink.textContent = report.title;

    const meta = document.createElement('div');
    meta.className = 'report-meta';

    const firm = document.createElement('span');
    firm.textContent = report.firm;

    const date = document.createElement('span');
    date.textContent = formatReportDate(report.date);

    meta.appendChild(firm);
    meta.appendChild(date);

    if (report.pdfLink) {
      const pdf = document.createElement('a');
      pdf.className = 'report-pdf';
      pdf.href = report.pdfLink;
      pdf.target = '_blank';
      pdf.rel = 'noopener noreferrer';
      pdf.textContent = 'PDF';
      meta.appendChild(pdf);
    }

    li.appendChild(titleLink);
    li.appendChild(meta);
    listEl.appendChild(li);
  });
}

async function loadReports() {
  try {
    const res = await fetch('/api/reports');
    if (!res.ok) throw new Error('요청 실패');
    const data = await res.json();
    renderReports(data.reports);
  } catch (err) {
    listEl.innerHTML = '<li class="calendar-empty">리포트를 불러오지 못했습니다.</li>';
  }
}

function hideLoadingOverlay() {
  const overlay = document.getElementById('loading-overlay');
  if (!overlay) return;
  overlay.classList.add('hidden');
  setTimeout(() => overlay.remove(), 600);
}

const minDisplayTime = new Promise((resolve) => setTimeout(resolve, 1500));
Promise.all([loadReports(), minDisplayTime]).finally(hideLoadingOverlay);
