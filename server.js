const express = require('express');
const path = require('path');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');

const app = express();
const PORT = process.env.PORT || 3000;

const NY_KEYWORDS = ['뉴욕증시', '다우지수', '나스닥', 'S&P', '월가', '뉴욕 증시'];
const KR_KEYWORDS = ['코스피', '코스닥', '국내증시', '증시', '거래소'];

app.use(express.static(path.join(__dirname, 'public')));

const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Upstream finance/data APIs occasionally return transient 5xx errors; retry
// a few times with a short backoff before giving up.
async function fetchWithRetry(url, options, attempts = RETRY_ATTEMPTS) {
  let lastErr;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;
      lastErr = new Error(`Upstream responded with ${res.status}`);
    } catch (err) {
      lastErr = err;
    }

    if (attempt < attempts) await sleep(RETRY_DELAY_MS * attempt);
  }

  throw lastErr;
}

async function fetchNaverIndices({ market, symbols, type = 'index' }) {
  const upstream = await fetchWithRetry(
    `https://polling.finance.naver.com/api/realtime/${market}/${type}/${symbols}`,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Referer: 'https://finance.naver.com/',
      },
    }
  );

  const data = await upstream.json();

  return data.datas.map((item) => ({
    code: item.itemCode || item.reutersCode,
    name: item.stockName || item.indexName,
    price: item.closePrice,
    change: item.compareToPreviousClosePrice,
    changeRatio: item.fluctuationsRatio,
    direction: item.compareToPreviousPrice.name, // RISING, FALLING, EVEN
    marketStatus: item.marketStatus,
    tradedAt: item.localTradedAt,
  }));
}

// Proxy for Naver Finance polling API (no CORS headers, so browser can't call it directly)
app.get('/api/indices', async (req, res) => {
  try {
    const indices = await fetchNaverIndices({ market: 'domestic', symbols: 'KOSPI,KOSDAQ' });
    res.json({ indices, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Failed to fetch indices:', err.message);
    res.status(502).json({ error: 'Failed to fetch index data' });
  }
});

// US indices (Dow, Nasdaq, S&P 500, Philadelphia Semiconductor) via Naver, USD/KRW
// and 증시자금동향 (customer deposits / margin balance) scraped from Naver Finance,
// US 10Y Treasury yield & 10Y-2Y spread via FRED's public CSV export, and OECD's
// Composite Leading Indicator (Korea) / Business Confidence Indicator (China).
const LEADING_INDICATOR_SOURCES = {
  us: () => fetchNaverIndices({ market: 'worldstock', symbols: '.DJI,.IXIC,.INX,.SOX' }),
  usStocks: () =>
    fetchNaverIndices({
      market: 'worldstock',
      type: 'stock',
      symbols: 'NVDA.O,GOOGL.O,MSFT.O,AAPL.O,AMZN.O,TSLA.O',
    }),
  oecdCli: () =>
    fetchOecdSeries(
      'https://sdmx.oecd.org/public/rest/data/OECD.SDD.STES,DSD_STES@DF_CLI,4.1/KOR.M.LI...AA...H?format=csv'
    ),
  chinaBci: () =>
    fetchOecdSeries(
      'https://sdmx.oecd.org/public/rest/data/OECD.SDD.STES,DSD_STES@DF_BTS,4.0/CHN.M........?format=csv'
    ),
  usdKrw: fetchUsdKrw,
  yield10y: () => fetchFredSeries('DGS10'),
  spread10y2y: () => fetchFredSeries('T10Y2Y'),
  fundFlow: fetchFundFlow,
  commodities: fetchCommodities,
};

// Each source is fetched from a different, independently flaky upstream, so a
// single failure (e.g. a rate limit) shouldn't blank out the whole response.
app.get('/api/leading-indicators', async (req, res) => {
  const keys = Object.keys(LEADING_INDICATOR_SOURCES);
  const results = await Promise.allSettled(keys.map((key) => LEADING_INDICATOR_SOURCES[key]()));

  const values = {};
  results.forEach((result, i) => {
    const key = keys[i];
    if (result.status === 'fulfilled') {
      values[key] = result.value;
    } else {
      console.error(`Failed to fetch leading indicator "${key}":`, result.reason.message);
      values[key] = null;
    }
  });

  res.json({
    us: values.us || [],
    usStocks: values.usStocks || [],
    oecdCli: values.oecdCli,
    chinaBci: values.chinaBci,
    usdKrw: values.usdKrw,
    usTreasury: { yield10y: values.yield10y, spread10y2y: values.spread10y2y },
    fundFlow: values.fundFlow,
    commodities: values.commodities || [],
    updatedAt: new Date().toISOString(),
  });
});

function directionOf(change) {
  if (change === null || Number.isNaN(change)) return 'EVEN';
  if (change > 0) return 'RISING';
  if (change < 0) return 'FALLING';
  return 'EVEN';
}

// Generic reader for OECD's SDMX CSV export: sorts rows by TIME_PERIOD and
// returns the latest observation plus its change from the prior period.
async function fetchOecdSeries(url) {
  const upstream = await fetchWithRetry(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });

  const csv = await upstream.text();
  const rows = csv
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => line.split(','))
    .map((cols) => ({ period: cols[10], value: Number(cols[11]) }))
    .filter((row) => row.period && !Number.isNaN(row.value))
    .sort((a, b) => (a.period < b.period ? 1 : -1));

  const [latest, previous] = rows;
  if (!latest) return null;

  const change = previous ? latest.value - previous.value : null;

  return {
    period: latest.period,
    value: latest.value,
    previousPeriod: previous ? previous.period : null,
    previousValue: previous ? previous.value : null,
    change,
    direction: directionOf(change),
  };
}

// FRED's fredgraph.csv export needs no API key. Returns the latest observation
// plus its change from the prior available observation.
async function fetchFredSeries(seriesId) {
  const upstream = await fetchWithRetry(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });

  const csv = await upstream.text();
  const rows = csv
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => line.split(','))
    .map((cols) => ({ date: cols[0], value: Number(cols[1]) }))
    .filter((row) => row.date && !Number.isNaN(row.value));

  const latest = rows[rows.length - 1];
  const previous = rows[rows.length - 2];
  if (!latest) return null;

  const change = previous ? latest.value - previous.value : null;

  return {
    date: latest.date,
    value: latest.value,
    previousDate: previous ? previous.date : null,
    previousValue: previous ? previous.value : null,
    change,
    direction: directionOf(change),
  };
}

// Naver's exchangeDetail page renders the price/change as one <span> per digit;
// concatenating the element's text (and stripping whitespace) reassembles it.
function readDigitSpans($el) {
  return $el
    .text()
    .replace(/\s+/g, '');
}

async function fetchUsdKrw() {
  const upstream = await fetchWithRetry(
    'https://finance.naver.com/marketindex/exchangeDetail.naver?marketindexCd=FX_USDKRW',
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  );

  const buffer = Buffer.from(await upstream.arrayBuffer());
  const html = iconv.decode(buffer, 'euc-kr');
  const $ = cheerio.load(html);

  const priceEl = $('.no_today').children('em').first();
  const price = readDigitSpans(priceEl);
  const direction = priceEl.hasClass('no_up') ? 'RISING' : priceEl.hasClass('no_down') ? 'FALLING' : 'EVEN';

  const changeEms = $('.no_exday').children('em');
  const rawChange = readDigitSpans(changeEms.eq(0));
  const changeRatioText = readDigitSpans(changeEms.eq(1)); // e.g. "(+0.26%)"
  const ratioMatch = changeRatioText.match(/\(([+-]?)([\d.]+)%\)/);

  if (!price) return null;

  return {
    code: 'USDKRW',
    name: '원/달러',
    price,
    change: direction === 'FALLING' ? `-${rawChange}` : rawChange,
    changeRatio: ratioMatch ? (ratioMatch[1] === '-' ? `-${ratioMatch[2]}` : ratioMatch[2]) : '0',
    direction,
    tradedAt: $('.exchange_info .date').first().text().trim(),
  };
}

// Trading Economics symbol -> Korean label, in the display order requested.
const COMMODITY_CONFIG = [
  { symbol: 'CL1:COM', code: 'CRUDE', name: '원유 (WTI)' },
  { symbol: 'CO1:COM', code: 'BRENT', name: '브렌트유' },
  { symbol: 'NG1:COM', code: 'NATGAS', name: '천연가스' },
  { symbol: 'XB1:COM', code: 'GASOLINE', name: '가솔린' },
  { symbol: 'XAL1:COM', code: 'COAL', name: '석탄' },
  { symbol: 'MOB:COM', code: 'NAPHTHA', name: '나프타' },
  { symbol: 'PNL:COM', code: 'PROPANE', name: '프로판' },
  { symbol: 'UXA:COM', code: 'URANIUM', name: '우라늄' },
  { symbol: 'XAUUSD:CUR', code: 'GOLD', name: '금' },
  { symbol: 'XAGUSD:CUR', code: 'SILVER', name: '은' },
  { symbol: 'HG1:COM', code: 'COPPER', name: '구리' },
  { symbol: 'JBP:COM', code: 'STEEL', name: '강철' },
  { symbol: 'LC:COM', code: 'LITHIUM', name: '리튬' },
  { symbol: 'SCO:COM', code: 'IRONORE', name: '철광석' },
  { symbol: 'XPTUSD:CUR', code: 'PLATINUM', name: '백금' },
  { symbol: 'LMAHDS03:COM', code: 'ALUMINUM', name: '알루미늄' },
];

// Scrapes Trading Economics' commodities table. Rows carry a data-value
// attribute on the change/%change cells with the true signed number, so we
// read that instead of the (unsigned) display text.
async function fetchCommodities() {
  const upstream = await fetchWithRetry('https://tradingeconomics.com/commodities', {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  const html = await upstream.text();
  const $ = cheerio.load(html);

  const rowsBySymbol = {};
  $('tr[data-symbol]').each((_, el) => {
    const row = $(el);
    const symbol = row.attr('data-symbol');

    const price = row.find('#p').first().text().trim();
    const nchEl = row.find('#nch').first();
    // A few rows (e.g. Lithium) render data-value with thousands separators.
    const changeValue = Number((nchEl.attr('data-value') || '').replace(/,/g, ''));
    const changeText = nchEl.clone().children('span').remove().end().text().trim();
    const changeRatioValue = Number((row.find('#pch').first().attr('data-value') || '').replace(/,/g, ''));

    rowsBySymbol[symbol] = {
      price,
      change: changeValue < 0 ? `-${changeText}` : changeText,
      changeRatio: Number.isNaN(changeRatioValue) ? '0' : changeRatioValue.toFixed(2),
      direction: directionOf(changeValue),
      unit: row.find('td.datatable-item-first div').first().text().trim(),
      date: row.find('#date').first().text().trim(),
    };
  });

  return COMMODITY_CONFIG.map(({ symbol, code, name }) => {
    const row = rowsBySymbol[symbol];
    if (!row) return { code, name, price: null };
    return { code, name, ...row };
  });
}

// Scrapes Naver's "증시자금동향" table for the latest 고객예탁금 (investor
// deposits) and 신용잔고 (margin loan balance), both in 억원 (100M KRW).
async function fetchFundFlow() {
  const upstream = await fetchWithRetry('https://finance.naver.com/sise/sise_deposit.naver', {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });

  const buffer = Buffer.from(await upstream.arrayBuffer());
  const html = iconv.decode(buffer, 'euc-kr');
  const $ = cheerio.load(html);

  const row = $('table.type_1 tr')
    .filter((_, el) => $(el).find('td.date').length > 0)
    .first();

  if (!row.length) return null;

  const cells = row.find('td');
  const cellAt = (i) => {
    const el = cells.eq(i);
    const value = el.text().trim();
    const direction = el.hasClass('rate_up') ? 'RISING' : el.hasClass('rate_down') ? 'FALLING' : 'EVEN';
    return { value, direction };
  };

  const depositValue = cellAt(1);
  const depositChange = cellAt(2);
  const marginValue = cellAt(3);
  const marginChange = cellAt(4);

  const signed = (cell) => (cell.direction === 'FALLING' ? `-${cell.value}` : cell.value);

  return {
    date: cells.eq(0).text().trim(),
    deposits: { value: depositValue.value, change: signed(depositChange), direction: depositValue.direction },
    marginBalance: { value: marginValue.value, change: signed(marginChange), direction: marginValue.direction },
  };
}

// Scrapes a Naver Finance news list page (mode=LSS3D) and optionally filters
// by keyword. Shared by the NY-market and domestic-market news endpoints.
async function scrapeNaverNews(sectionId3, keywords, limit) {
  const upstream = await fetchWithRetry(
    `https://finance.naver.com/news/news_list.naver?mode=LSS3D&section_id=101&section_id2=258&section_id3=${sectionId3}`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  );

  const buffer = Buffer.from(await upstream.arrayBuffer());
  const html = iconv.decode(buffer, 'euc-kr');
  const $ = cheerio.load(html);

  const items = [];
  $('.realtimeNewsList .articleSubject').each((_, el) => {
    const link = $(el).find('a').first();
    const title = link.attr('title') || link.text().trim();
    const href = link.attr('href');
    const summaryEl = $(el).next('.articleSummary');
    const summary = summaryEl.clone().children('span').remove().end().text().trim();
    const press = summaryEl.find('.press').text().trim();
    const time = summaryEl.find('.wdate').text().trim();

    if (!title || !href) return;

    items.push({
      title,
      summary,
      press,
      time,
      link: `https://finance.naver.com${href}`,
    });
  });

  const filtered = keywords
    ? items.filter((item) => keywords.some((kw) => item.title.includes(kw) || item.summary.includes(kw)))
    : items;

  return filtered.slice(0, limit);
}

// "해외증시" news list, filtered for NY-market wrap-ups
app.get('/api/ny-news', async (req, res) => {
  try {
    const news = await scrapeNaverNews(403, NY_KEYWORDS, 3);
    res.json({ news, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Failed to fetch NY market news:', err.message);
    res.status(502).json({ error: 'Failed to fetch NY market news' });
  }
});

// "시황.전망" news list, filtered for KOSPI/KOSDAQ domestic-market coverage
app.get('/api/kr-news', async (req, res) => {
  try {
    const news = await scrapeNaverNews(401, KR_KEYWORDS, 3);
    res.json({ news, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Failed to fetch domestic market news:', err.message);
    res.status(502).json({ error: 'Failed to fetch domestic market news' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
