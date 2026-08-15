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
// and US 10Y Treasury yield & 10Y-2Y spread via FRED's public CSV export.
const LEADING_INDICATOR_SOURCES = {
  us: () => fetchNaverIndices({ market: 'worldstock', symbols: '.DJI,.IXIC,.INX,.SOX' }),
  usStocks: () =>
    fetchNaverIndices({
      market: 'worldstock',
      type: 'stock',
      symbols: 'NVDA.O,GOOGL.O,MSFT.O,AAPL.O,AMZN.O,TSLA.O',
    }),
  vix: () => fetchNaverIndices({ market: 'worldstock', symbols: '.VIX' }),
  usdKrw: fetchUsdKrw,
  yield10y: () => fetchFredSeries('DGS10'),
  spread10y2y: () => fetchFredSeries('T10Y2Y'),
  usFedRate: fetchUsFedRate,
  krBaseRate: () => fetchEcosSeries('722Y001', ['0101000']),
  bsi: () => fetchEcosSeries('512Y014', ['99988', 'BA']),
  ccsi: () => fetchEcosSeries('511Y002', ['FME']),
  creditSpread: fetchCreditSpread,
  kospiFlow: () => fetchInvestorNetBuying(''),
  kosdaqFlow: () => fetchInvestorNetBuying('02'),
  bdi: fetchBalticDryIndex,
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

  let usKrSpread = null;
  if (values.usFedRate && values.krBaseRate) {
    const value = values.usFedRate.upper.value - values.krBaseRate.value;
    usKrSpread = { value, direction: directionOf(value) };
  }

  const payload = {
    us: values.us || [],
    usStocks: values.usStocks || [],
    vix: (values.vix && values.vix[0]) || null,
    usdKrw: values.usdKrw,
    usTreasury: { yield10y: values.yield10y, spread10y2y: values.spread10y2y },
    rates: {
      usFedRate: values.usFedRate,
      krBaseRate: values.krBaseRate,
      usKrSpread,
      creditSpread: values.creditSpread,
    },
    sentiment: {
      bsi: values.bsi,
      ccsi: values.ccsi,
    },
    investorFlow: {
      kospi: values.kospiFlow,
      kosdaq: values.kosdaqFlow,
    },
    bdi: values.bdi,
    fundFlow: values.fundFlow,
    commodities: values.commodities || [],
    updatedAt: new Date().toISOString(),
  };

  payload.signalScore = computeSignalScore(payload);

  res.json(payload);
});

function directionOf(change) {
  if (change === null || Number.isNaN(change)) return 'EVEN';
  if (change > 0) return 'RISING';
  if (change < 0) return 'FALLING';
  return 'EVEN';
}

function averageDirection(directions) {
  let up = 0;
  let down = 0;
  directions.forEach((d) => {
    if (d === 'RISING') up += 1;
    else if (d === 'FALLING') down += 1;
  });
  if (up > down) return 'RISING';
  if (down > up) return 'FALLING';
  return 'EVEN';
}

// A lightweight, transparent "how many leading indicators point which way"
// gauge — NOT a prediction model. Each signal contributes +1 (bullish), -1
// (bearish), or 0 (flat/unavailable) toward KOSPI; "invert" is used where a
// falling value is conventionally the bullish read (e.g. VIX, credit spread).
function computeSignalScore(payload) {
  const signals = [];

  const addSignal = (label, direction, { invert = false } = {}) => {
    if (!direction) return;
    let impact = direction === 'RISING' ? 1 : direction === 'FALLING' ? -1 : 0;
    if (invert) impact *= -1;
    signals.push({ label, direction, impact });
  };

  if (payload.us.length) addSignal('미국 증시', averageDirection(payload.us.map((d) => d.direction)));
  if (payload.usStocks.length)
    addSignal('미국 빅테크', averageDirection(payload.usStocks.map((d) => d.direction)));
  if (payload.vix) addSignal('VIX (공포지수)', payload.vix.direction, { invert: true });
  if (payload.usdKrw) addSignal('원/달러 환율', payload.usdKrw.direction, { invert: true });
  if (payload.usTreasury.yield10y)
    addSignal('美 국채 10년물 금리', payload.usTreasury.yield10y.direction, { invert: true });
  if (payload.usTreasury.spread10y2y)
    addSignal('美 장단기 금리차', payload.usTreasury.spread10y2y.direction);
  if (payload.rates.creditSpread) addSignal('신용스프레드', payload.rates.creditSpread.direction, { invert: true });
  if (payload.rates.usFedRate) addSignal('미국 기준금리', payload.rates.usFedRate.upper.direction, { invert: true });
  if (payload.rates.krBaseRate) addSignal('한국 기준금리', payload.rates.krBaseRate.direction, { invert: true });
  if (payload.sentiment.bsi) addSignal('BSI 업황전망', payload.sentiment.bsi.direction);
  if (payload.sentiment.ccsi) addSignal('CCSI 소비자심리', payload.sentiment.ccsi.direction);
  if (payload.investorFlow.kospi) {
    addSignal('코스피 외국인 순매수', payload.investorFlow.kospi.foreign.direction);
    addSignal('코스피 기관 순매수', payload.investorFlow.kospi.institution.direction);
  }
  if (payload.investorFlow.kosdaq) {
    addSignal('코스닥 외국인 순매수', payload.investorFlow.kosdaq.foreign.direction);
    addSignal('코스닥 기관 순매수', payload.investorFlow.kosdaq.institution.direction);
  }
  if (payload.bdi) addSignal('BDI (발틱운임지수)', payload.bdi.direction);
  if (payload.fundFlow && payload.fundFlow.deposits) addSignal('고객예탁금', payload.fundFlow.deposits.direction);

  const score = signals.reduce((sum, s) => sum + s.impact, 0);
  const bullishCount = signals.filter((s) => s.impact > 0).length;
  const bearishCount = signals.filter((s) => s.impact < 0).length;
  const neutralCount = signals.length - bullishCount - bearishCount;

  let label = 'NEUTRAL';
  if (score >= 5) label = 'FAVORABLE';
  else if (score <= -5) label = 'UNFAVORABLE';

  return {
    score,
    maxScore: signals.length,
    label,
    bullishCount,
    bearishCount,
    neutralCount,
    signals,
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

// The Fed's policy rate is a target range, not a single number; Korean
// financial media typically quote both the upper and lower bound.
async function fetchUsFedRate() {
  const [upper, lower] = await Promise.all([fetchFredSeries('DFEDTARU'), fetchFredSeries('DFEDTARL')]);
  if (!upper || !lower) return null;
  return { upper, lower };
}

function ecosPeriod(monthsAgo) {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - monthsAgo);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit' })
    .format(d)
    .replace('-', '');
}

// Bank of Korea's ECOS statistics API. The public "sample" key needs no
// registration but caps results at 10 rows, so we request a short (6mo)
// window rather than paging.
async function fetchEcosSeries(statCode, itemCodes) {
  const start = ecosPeriod(6);
  const end = ecosPeriod(0);
  const itemPath = itemCodes.join('/');
  const url = `https://ecos.bok.or.kr/api/StatisticSearch/sample/json/kr/1/10/${statCode}/M/${start}/${end}/${itemPath}`;

  const upstream = await fetchWithRetry(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const data = await upstream.json();
  const rows = (data.StatisticSearch && data.StatisticSearch.row) || [];

  const parsed = rows
    .map((r) => ({ period: r.TIME, value: Number(r.DATA_VALUE) }))
    .filter((r) => r.period && !Number.isNaN(r.value))
    .sort((a, b) => (a.period < b.period ? 1 : -1));

  const [latest, previous] = parsed;
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

// Naver's interestDetail page uses the same per-digit <span> markup as the FX
// page; fetches 국고채(3년)/회사채(3년) and returns the credit spread.
async function fetchNaverRate(marketindexCd) {
  const upstream = await fetchWithRetry(
    `https://finance.naver.com/marketindex/interestDetail.naver?marketindexCd=${marketindexCd}`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  );

  const buffer = Buffer.from(await upstream.arrayBuffer());
  const html = iconv.decode(buffer, 'euc-kr');
  const $ = cheerio.load(html);

  const priceEl = $('.no_today').children('em').first();
  const value = Number(readDigitSpans(priceEl));
  if (Number.isNaN(value)) return null;

  const direction = priceEl.hasClass('no_up') ? 'RISING' : priceEl.hasClass('no_down') ? 'FALLING' : 'EVEN';
  const changeEms = $('.no_exday').children('em');
  const rawChange = Number(readDigitSpans(changeEms.eq(0)));

  return {
    value,
    change: direction === 'FALLING' ? -rawChange : rawChange,
    direction,
    date: $('.exchange_info .date').first().text().trim(),
  };
}

async function fetchCreditSpread() {
  const [govt, corp] = await Promise.all([fetchNaverRate('IRR_GOVT03Y'), fetchNaverRate('IRR_CORP03Y')]);
  if (!govt || !corp) return null;

  const value = corp.value - govt.value;
  const change = corp.change - govt.change;

  return {
    value,
    change,
    direction: directionOf(change),
    govt3y: govt.value,
    corp3y: corp.value,
    date: govt.date,
  };
}

// Naver's "일자별 순매수" (daily net buying) widget for the whole KOSPI/KOSDAQ
// market. sosok='' is KOSPI, sosok='02' is KOSDAQ. bizdate must be a real date
// (today's KST date works; the page just returns the most recent trading days).
async function fetchInvestorNetBuying(sosok) {
  const bizdate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date()).replace(/-/g, '');
  const upstream = await fetchWithRetry(
    `https://finance.naver.com/sise/investorDealTrendDay.naver?bizdate=${bizdate}&sosok=${sosok}`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  );

  const buffer = Buffer.from(await upstream.arrayBuffer());
  const html = iconv.decode(buffer, 'euc-kr');
  const $ = cheerio.load(html);

  const row = $('td.date2').first().closest('tr');
  if (!row.length) return null;

  const cells = row.find('td');
  // Column order: 날짜, 개인, 외국인, 기관계, ...기관 세부..., 기타법인
  const parseCell = (i) => {
    const text = cells.eq(i).text().trim().replace(/,/g, '');
    return Number(text);
  };

  const foreign = parseCell(2);
  const institution = parseCell(3);
  if (Number.isNaN(foreign) || Number.isNaN(institution)) return null;

  return {
    date: cells.eq(0).text().trim(),
    foreign: { value: foreign, direction: directionOf(foreign) },
    institution: { value: institution, direction: directionOf(institution) },
  };
}

// Trading Economics' single-commodity pages (unlike the /commodities table)
// embed a "related instruments" table where change/%change are pre-signed.
async function fetchBalticDryIndex() {
  const upstream = await fetchWithRetry('https://tradingeconomics.com/commodity/baltic', {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  const html = await upstream.text();
  const $ = cheerio.load(html);

  const row = $('tr[data-symbol="BDIY:IND"]').first();
  if (!row.length) return null;

  const price = row.find('#p').first().text().trim();
  const change = row.find('#nch').first().text().trim();
  const changeRatio = row.find('#pch').first().text().trim().replace('%', '');
  const changeValue = Number(change);

  return {
    price,
    change,
    changeRatio,
    direction: directionOf(changeValue),
    date: row.find('#date').first().text().trim(),
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
