require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

const app = express();
const PORT = process.env.PORT || 3000;

const NY_KEYWORDS = ['뉴욕증시', '다우지수', '나스닥', 'S&P', '월가', '뉴욕 증시'];
const KR_KEYWORDS = ['코스피', '코스닥', '국내증시', '증시', '거래소'];

// KNU Korean Sentiment Dictionary (군산대 DILAB, github.com/park1200656/KnuSentiLex)
// — ~14,800 general-purpose Korean words scored -2 (very negative) to +2
// (very positive). Used to score news headlines locally, no API calls.
const SENTI_DICT = new Map();
try {
  const raw = fs.readFileSync(path.join(__dirname, 'data', 'knu-senti-word-dict.txt'), 'utf8');
  raw
    .replace(/^﻿/, '')
    .split('\n')
    .forEach((line) => {
      const [word, polarityStr] = line.trim().split('\t');
      const polarity = Number(polarityStr);
      if (!word || word.length < 2 || Number.isNaN(polarity) || polarity === 0) return;
      SENTI_DICT.set(word, polarity);
    });
  console.log(`Loaded ${SENTI_DICT.size} sentiment dictionary entries`);
} catch (err) {
  console.warn('Failed to load sentiment dictionary:', err.message);
}

// KNU is general-purpose and misses most market vocabulary ("급등", "실적",
// "관리종목", ...) — testing against real headlines found zero matches
// without this. Small hand-curated overlay, applied on top of KNU.
const FINANCE_SENTI_WORDS = {
  급등: 2,
  폭등: 2,
  껑충: 1,
  강세: 1,
  반등: 1,
  훈풍: 1,
  호조: 1,
  개선: 1,
  기대: 1,
  순매수: 1,
  사상최대: 2,
  역대급: 2,
  역대최고: 2,
  최고치: 1,
  신고가: 2,
  흑자전환: 2,
  어닝서프라이즈: 2,
  깜짝실적: 2,
  호실적: 1,
  상승세: 1,
  오른: 1,
  올랐다: 1,
  급락: -2,
  폭락: -2,
  약세: -1,
  부진: -1,
  둔화: -1,
  우려: -1,
  부담: -1,
  악화: -2,
  순매도: -1,
  신저가: -2,
  최저치: -1,
  적자전환: -2,
  어닝쇼크: -2,
  관리종목: -2,
  상장폐지: -2,
  급감: -2,
  내렸다: -1,
  하락세: -1,
  후퇴: -1,
};
Object.entries(FINANCE_SENTI_WORDS).forEach(([word, polarity]) => SENTI_DICT.set(word, polarity));

// Sums dictionary word matches found as substrings across the given texts.
// Crude (no tokenization) but dependency-free and fast enough for a handful
// of headlines per request.
function scoreKoreanSentiment(texts) {
  const joined = texts.join(' ');
  let score = 0;
  for (const [word, polarity] of SENTI_DICT) {
    if (joined.includes(word)) score += polarity;
  }
  return { score, direction: directionOf(score) };
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Firestore stores the daily signal-vs-KOSPI history for the 통계 tab. Falls
// back to disabled (rather than crashing) when credentials aren't set.
let db = null;
let auth = null;
if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
  const firebaseApp = initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
  db = getFirestore(firebaseApp);
  auth = getAuth(firebaseApp);
} else {
  console.warn('Firebase credentials not set; /api/stats will be unavailable.');
}

// Verifies the Firebase ID token on the Authorization header (issued by the
// client-side Google sign-in) and attaches the caller's uid to req.
async function requireAuth(req, res, next) {
  if (!auth) return res.status(503).json({ error: 'Login not configured' });

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });

  try {
    const decoded = await auth.verifyIdToken(token);
    req.uid = decoded.uid;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

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
  jobless: () => fetchFredSeries('ICSA'),
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
  krNewsSentiment: async () => {
    const news = await scrapeNaverNews(401, KR_KEYWORDS, 3);
    return scoreKoreanSentiment(news.map((item) => `${item.title} ${item.summary}`));
  },
  nyNewsSentiment: async () => {
    const news = await scrapeNaverNews(403, NY_KEYWORDS, 3);
    return scoreKoreanSentiment(news.map((item) => `${item.title} ${item.summary}`));
  },
};

// Each source is fetched from a different, independently flaky upstream, so a
// single failure (e.g. a rate limit) shouldn't blank out the whole response.
async function buildLeadingIndicatorsPayload() {
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
    jobless: values.jobless,
    fundFlow: values.fundFlow,
    commodities: values.commodities || [],
    newsSentiment: {
      domestic: values.krNewsSentiment,
      foreign: values.nyNewsSentiment,
    },
    updatedAt: new Date().toISOString(),
  };

  payload.signalScore = computeSignalScore(payload);
  return payload;
}

app.get('/api/leading-indicators', async (req, res) => {
  const payload = await buildLeadingIndicatorsPayload();

  // Fire-and-forget backup capture, in case the daily cron trigger missed.
  // KOSPI's open-vs-previous-close direction doesn't change during the day,
  // so this is safe to repeat and never overwrites an already-frozen signal.
  captureSignalHistory(payload.signalScore).catch((err) =>
    console.error('Failed to capture signal history:', err.message)
  );

  res.json(payload);
});

// Dedicated endpoint for the daily GitHub Actions cron trigger, so history is
// recorded even if nobody visits the site that day.
app.get('/api/stats/capture', async (req, res) => {
  try {
    const payload = await buildLeadingIndicatorsPayload();
    await captureSignalHistory(payload.signalScore);
    res.json({ ok: true, date: todayKstDateString(), signalScore: payload.signalScore });
  } catch (err) {
    console.error('Manual signal capture failed:', err.message);
    res.status(502).json({ error: 'Capture failed' });
  }
});

function todayKstDateString() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
}

function isKstWeekend() {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', weekday: 'short' }).format(new Date());
  return weekday === 'Sat' || weekday === 'Sun';
}

function evaluateCorrectness(signalLabel, kospiDirection) {
  if (!kospiDirection || kospiDirection === 'EVEN') return null;
  if (signalLabel === 'FAVORABLE') return kospiDirection === 'RISING';
  return kospiDirection === 'FALLING';
}

// KOSPI's opening print vs the previous close — fixed once the market opens,
// so unlike "current price" this doesn't drift depending on when it's read.
async function fetchKospiOpenDirection() {
  const upstream = await fetchWithRetry(
    'https://polling.finance.naver.com/api/realtime/domestic/index/KOSPI',
    { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://finance.naver.com/' } }
  );
  const data = await upstream.json();
  const item = data.datas[0];
  if (!item) return null;

  const open = Number(item.openPriceRaw);
  const current = Number(item.closePriceRaw);
  const changeFromPrevClose = Number(item.compareToPreviousClosePriceRaw);
  if ([open, current, changeFromPrevClose].some((n) => Number.isNaN(n))) return null;

  const previousClose = current - changeFromPrevClose;
  return directionOf(open - previousClose);
}

// Records one row per KST day (skipping weekends): the morning's signal call
// (frozen once set) plus KOSPI's open-vs-previous-close direction.
async function captureSignalHistory(signalScore) {
  if (!db || !signalScore || !signalScore.maxScore || isKstWeekend()) return;

  const date = todayKstDateString();
  const docRef = db.collection('signalHistory').doc(date);
  const [existing, kospiDirection] = await Promise.all([docRef.get(), fetchKospiOpenDirection()]);

  if (!existing.exists) {
    await docRef.set({
      date,
      signalLabel: signalScore.label,
      signalScore: signalScore.score,
      kospiDirection,
      correct: evaluateCorrectness(signalScore.label, kospiDirection),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return;
  }

  const stored = existing.data();
  await docRef.update({
    kospiDirection,
    correct: evaluateCorrectness(stored.signalLabel, kospiDirection),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

// Returns the recorded signal-vs-KOSPI history for the 통계 tab.
app.get('/api/stats', async (req, res) => {
  if (!db) {
    res.status(503).json({ error: 'Stats storage not configured' });
    return;
  }

  try {
    const snapshot = await db.collection('signalHistory').orderBy('date', 'desc').limit(90).get();
    const rows = snapshot.docs.map((doc) => doc.data());
    const decided = rows.filter((r) => r.correct !== null && r.correct !== undefined);
    const correctCount = decided.filter((r) => r.correct).length;

    res.json({
      rows,
      summary: {
        total: decided.length,
        correct: correctCount,
        accuracy: decided.length ? (correctCount / decided.length) * 100 : null,
      },
    });
  } catch (err) {
    console.error('Failed to fetch stats:', err.message);
    res.status(502).json({ error: 'Failed to fetch stats' });
  }
});

// ── 증시나침반 (업종별 강세/약세) ──

// WICS(와이즈산업분류) 79개 세부업종을 "한국 산업의 생태계" 이미지의 12개
// 광역 카테고리로 묶는 매핑. no 25("기타")는 미분류 종목 1,500여개가
// 뭉쳐있는 잡동사니 버킷이라 어느 카테고리에도 넣지 않고 제외한다.
const INDUSTRY_SECTORS = [
  { id: 'STEEL_NONFERROUS', name: '철강/비철금속', groups: [304, 322] },
  { id: 'AUTO_MACHINERY', name: '자동차/기계', groups: [273, 270, 299, 306, 284] },
  {
    id: 'IT_ELECTRONICS',
    name: '정보기술/가전',
    groups: [278, 282, 307, 267, 287, 293, 292, 327, 269, 294, 338, 283, 298],
  },
  { id: 'ENERGY_MATERIALS', name: '에너지와 소재', groups: [325, 312, 331, 318, 295, 311, 272, 313] },
  { id: 'CONSTRUCTION', name: '건설', groups: [279, 280, 320, 289] },
  { id: 'FINANCE', name: '금융 (은행,증권)', groups: [315, 301, 337, 319, 321, 330, 277] },
  { id: 'CONSUMER_GOODS', name: '음식료/소비재', groups: [275, 266, 271, 303, 268, 274, 309, 297] },
  { id: 'DISTRIBUTION', name: '유통', groups: [334, 308, 332, 264, 328, 302, 265] },
  { id: 'PHARMA_BIO', name: '제약/바이오', groups: [262, 288, 281, 316, 261, 286] },
  { id: 'SERVICES', name: '서비스', groups: [285, 336, 324, 314, 333, 317, 339, 263, 310, 290, 300, 276] },
  { id: 'LOGISTICS', name: '물류', groups: [326, 329, 296, 305] },
  { id: 'SHIPBUILDING_SHIPPING', name: '조선/해운', groups: [291, 323] },
];

const INDUSTRY_GROUP_TO_SECTOR = new Map();
INDUSTRY_SECTORS.forEach((sector) => {
  sector.groups.forEach((no) => INDUSTRY_GROUP_TO_SECTOR.set(no, sector.id));
});

// m.stock.naver.com's own mobile-app API for the "업종" tab: free, no key,
// 20 industries per page across ~79 WICS industries total.
async function fetchIndustryGroups() {
  const pages = await Promise.all(
    [1, 2, 3, 4].map((page) =>
      fetchWithRetry(`https://m.stock.naver.com/api/stocks/industry?page=${page}`, {
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://m.stock.naver.com/' },
      }).then((r) => r.json())
    )
  );

  return pages.flatMap((page) => page.groups || []).filter((g) => g.no !== 25);
}

// Rolls the 79 WICS industries up into the 12 broad sectors, weighting each
// industry's change rate by how many stocks it contains so a 1-stock
// industry can't swing a sector as much as a 150-stock one.
function aggregateIndustrySectors(groups) {
  const bySector = new Map();

  groups.forEach((g) => {
    const sectorId = INDUSTRY_GROUP_TO_SECTOR.get(g.no);
    if (!sectorId) return;
    if (!bySector.has(sectorId)) {
      bySector.set(sectorId, { weightedSum: 0, totalCount: 0, riseCount: 0, fallCount: 0 });
    }
    const bucket = bySector.get(sectorId);
    const count = g.totalCount || 0;
    bucket.weightedSum += Number(g.changeRate) * count;
    bucket.totalCount += count;
    bucket.riseCount += g.riseCount || 0;
    bucket.fallCount += g.fallCount || 0;
  });

  return INDUSTRY_SECTORS.map((sector) => {
    const bucket = bySector.get(sector.id);
    if (!bucket || !bucket.totalCount) {
      return { id: sector.id, name: sector.name, changeRate: null, riseCount: 0, fallCount: 0 };
    }
    return {
      id: sector.id,
      name: sector.name,
      changeRate: bucket.weightedSum / bucket.totalCount,
      riseCount: bucket.riseCount,
      fallCount: bucket.fallCount,
    };
  });
}

function kstQuarterStartDateString() {
  const [y, m] = todayKstDateString().split('-').map(Number);
  const quarterStartMonth = Math.floor((m - 1) / 3) * 3 + 1;
  return `${y}-${String(quarterStartMonth).padStart(2, '0')}-01`;
}

// Captures today's closing sector snapshot once per day so a quarter-to-date
// return can be compounded later. Simple overwrite-on-rerun (unlike the
// prediction gauge's freeze/update split) since this just records a fact,
// not a call that would be lookahead-biased by re-recording it.
async function captureIndustryHistory() {
  if (!db || isKstWeekend()) return;

  const groups = await fetchIndustryGroups();
  const sectors = aggregateIndustrySectors(groups);
  const date = todayKstDateString();

  await db
    .collection('industryHistory')
    .doc(date)
    .set({
      date,
      sectors: Object.fromEntries(sectors.map((s) => [s.id, s.changeRate])),
      updatedAt: FieldValue.serverTimestamp(),
    });
}

// Compounds each sector's daily % change across every captured trading day
// since the current quarter began, so the cumulative figure self-resets
// every Jan/Apr/Jul/Oct without any manual bookkeeping.
async function fetchQuarterCumulative() {
  if (!db) return null;

  const quarterStart = kstQuarterStartDateString();
  const snapshot = await db
    .collection('industryHistory')
    .where('date', '>=', quarterStart)
    .orderBy('date', 'asc')
    .get();

  if (snapshot.empty) return { tradingDays: 0, quarterStart, sectors: {} };

  const cumulative = {};
  INDUSTRY_SECTORS.forEach((s) => {
    cumulative[s.id] = 1;
  });

  snapshot.docs.forEach((doc) => {
    const data = doc.data().sectors || {};
    INDUSTRY_SECTORS.forEach((s) => {
      const rate = data[s.id];
      if (typeof rate === 'number') cumulative[s.id] *= 1 + rate / 100;
    });
  });

  const sectors = {};
  INDUSTRY_SECTORS.forEach((s) => {
    sectors[s.id] = (cumulative[s.id] - 1) * 100;
  });

  return { tradingDays: snapshot.docs.length, quarterStart, sectors };
}

app.get('/api/industry-compass', async (req, res) => {
  try {
    const [groups, quarterCumulative] = await Promise.all([
      fetchIndustryGroups(),
      fetchQuarterCumulative().catch((err) => {
        console.error('Failed to fetch quarter cumulative:', err.message);
        return null;
      }),
    ]);

    res.json({
      sectors: aggregateIndustrySectors(groups),
      quarterCumulative,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Failed to fetch industry compass:', err.message);
    res.status(502).json({ error: 'Failed to fetch industry data' });
  }
});

// Dedicated endpoint for the daily GitHub Actions cron trigger (run shortly
// after KOSPI's close), so quarter-to-date history builds up even if nobody
// visits the site that day.
app.get('/api/industry-compass/capture', async (req, res) => {
  try {
    await captureIndustryHistory();
    res.json({ ok: true, date: todayKstDateString() });
  } catch (err) {
    console.error('Manual industry capture failed:', err.message);
    res.status(502).json({ error: 'Capture failed' });
  }
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
  const oilEntries = payload.commodities.filter((c) => c.code === 'CRUDE' || c.code === 'BRENT');
  if (oilEntries.length) {
    addSignal('국제 유가 (WTI·브렌트)', averageDirection(oilEntries.map((c) => c.direction)), { invert: true });
  }
  const copper = payload.commodities.find((c) => c.code === 'COPPER');
  if (copper) addSignal('구리 (Dr. Copper)', copper.direction);
  const gold = payload.commodities.find((c) => c.code === 'GOLD');
  if (gold) addSignal('금 (안전자산 선호)', gold.direction, { invert: true });
  if (payload.bdi) addSignal('BDI (발틱운임지수)', payload.bdi.direction);
  if (payload.jobless) addSignal('美 신규 실업수당청구건수', payload.jobless.direction, { invert: true });
  if (payload.fundFlow && payload.fundFlow.deposits) addSignal('고객예탁금', payload.fundFlow.deposits.direction);
  if (payload.newsSentiment.domestic) addSignal('국내뉴스 심리', payload.newsSentiment.domestic.direction);
  if (payload.newsSentiment.foreign) addSignal('해외뉴스 심리', payload.newsSentiment.foreign.direction);

  const score = signals.reduce((sum, s) => sum + s.impact, 0);
  const bullishCount = signals.filter((s) => s.impact > 0).length;
  const bearishCount = signals.filter((s) => s.impact < 0).length;
  const neutralCount = signals.length - bullishCount - bearishCount;

  // Two-way call: ties (score === 0) default to UNFAVORABLE so every day
  // gets a definite label to score against the next day's actual result.
  const label = score > 0 ? 'FAVORABLE' : 'UNFAVORABLE';

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

// 국내뉴스: "시황.전망"(401) = 거시경제, "기업.종목분석"(402) = 미시경제.
// Both boards are already domestic-market-scoped, so no keyword filter needed.
app.get('/api/kr-news', async (req, res) => {
  try {
    const [macro, micro] = await Promise.all([
      scrapeNaverNews(401, null, 3),
      scrapeNaverNews(402, null, 3),
    ]);
    res.json({ macro, micro, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Failed to fetch domestic market news:', err.message);
    res.status(502).json({ error: 'Failed to fetch domestic market news' });
  }
});

// Fixed 2026 macro-calendar events. FOMC/BOK dates are the official
// pre-announced schedules; KRX holiday dates are the well-established ones
// (public holiday + KRX's usual year-end closure) — edge cases like a
// substitute-holiday ruling can still shift, so the calendar page disclaims
// "정확한 일정은 한국거래소 공지를 확인하세요".
const MACRO_EVENTS_2026 = [
  { date: '2026-01-15', type: 'RATE_KR', title: '한국은행 금통위 기준금리 결정' },
  { date: '2026-01-01', type: 'HOLIDAY', title: '신정 (증시 휴장)' },
  { date: '2026-01-28', type: 'RATE_US', title: 'FOMC 결과 발표' },
  { date: '2026-02-16', type: 'HOLIDAY', title: '설날 연휴 (증시 휴장)' },
  { date: '2026-02-17', type: 'HOLIDAY', title: '설날 (증시 휴장)' },
  { date: '2026-02-18', type: 'HOLIDAY', title: '설날 연휴 (증시 휴장)' },
  { date: '2026-02-26', type: 'RATE_KR', title: '한국은행 금통위 기준금리 결정' },
  { date: '2026-03-02', type: 'HOLIDAY', title: '삼일절 대체공휴일 (증시 휴장)' },
  { date: '2026-03-18', type: 'RATE_US', title: 'FOMC 결과 발표' },
  { date: '2026-04-10', type: 'RATE_KR', title: '한국은행 금통위 기준금리 결정' },
  { date: '2026-04-29', type: 'RATE_US', title: 'FOMC 결과 발표' },
  { date: '2026-05-05', type: 'HOLIDAY', title: '어린이날 (증시 휴장)' },
  { date: '2026-05-25', type: 'HOLIDAY', title: '부처님오신날 대체공휴일 (증시 휴장, 변동 가능)' },
  { date: '2026-05-28', type: 'RATE_KR', title: '한국은행 금통위 기준금리 결정' },
  { date: '2026-06-17', type: 'RATE_US', title: 'FOMC 결과 발표' },
  { date: '2026-07-16', type: 'RATE_KR', title: '한국은행 금통위 기준금리 결정' },
  { date: '2026-07-29', type: 'RATE_US', title: 'FOMC 결과 발표' },
  { date: '2026-08-17', type: 'HOLIDAY', title: '광복절 대체공휴일 (증시 휴장)' },
  { date: '2026-08-27', type: 'RATE_KR', title: '한국은행 금통위 기준금리 결정' },
  { date: '2026-09-16', type: 'RATE_US', title: 'FOMC 결과 발표' },
  { date: '2026-09-24', type: 'HOLIDAY', title: '추석 연휴 (증시 휴장)' },
  { date: '2026-09-25', type: 'HOLIDAY', title: '추석 (증시 휴장)' },
  { date: '2026-09-26', type: 'HOLIDAY', title: '추석 연휴 (증시 휴장)' },
  { date: '2026-10-05', type: 'HOLIDAY', title: '개천절 대체공휴일 (증시 휴장)' },
  { date: '2026-10-09', type: 'HOLIDAY', title: '한글날 (증시 휴장)' },
  { date: '2026-10-22', type: 'RATE_KR', title: '한국은행 금통위 기준금리 결정' },
  { date: '2026-10-28', type: 'RATE_US', title: 'FOMC 결과 발표' },
  { date: '2026-11-26', type: 'RATE_KR', title: '한국은행 금통위 기준금리 결정' },
  { date: '2026-12-09', type: 'RATE_US', title: 'FOMC 결과 발표' },
  { date: '2026-12-25', type: 'HOLIDAY', title: '성탄절 (증시 휴장)' },
  { date: '2026-12-31', type: 'HOLIDAY', title: '연말 휴장일' },
];

// 대통령실 공개일정 중 경제/기업 관련만 골라낸다. 제목만으로 판단하는
// 거친 필터라 완벽하진 않음. 이 API는 통상 가까운 1~2개월치만 채워져
// 있어서(FOMC처럼 1년 전 공지가 아님) 그만큼만 조회한다.
const GOV_ECONOMY_KEYWORDS = [
  '경제',
  '산업',
  '기업',
  '성장동력',
  '수출',
  '투자',
  '일자리',
  '금융',
  '민생',
  '무역',
  '반도체',
  '점검회의',
  '업무보고',
  '민관합동',
  '정상회담',
  '비즈니스',
];

// 코스피200 선물·옵션 + 개별주식 선물·옵션이 동시에 만료되는 날("콰드러플
// 위칭데이"). 3·6·9·12월의 둘째 목요일이라는 고정 규칙이라 연도만 넣으면
// 계산되고, 손으로 날짜를 입력할 때 생기는 오타 위험이 없다.
function getQuadrupleWitchingDays(year) {
  return [3, 6, 9, 12].map((month) => {
    const firstOfMonth = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    const firstThursday = 1 + ((4 - firstOfMonth + 7) % 7);
    const secondThursday = firstThursday + 7;
    return {
      date: `${year}-${String(month).padStart(2, '0')}-${String(secondThursday).padStart(2, '0')}`,
      type: 'EXPIRY',
      title: '선물옵션 동시만기일 (콰드러플 위칭데이)',
    };
  });
}

const QUADRUPLE_WITCHING_DAYS_2026 = getQuadrupleWitchingDays(2026);

function kstYearMonth(monthOffset) {
  const [y, m] = todayKstDateString().split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + monthOffset, 1));
  return { year: d.getUTCFullYear(), month: String(d.getUTCMonth() + 1).padStart(2, '0') };
}

async function fetchGovSchedule() {
  const months = [0, 1].map((offset) => kstYearMonth(offset));

  const responses = await Promise.all(
    months.map(({ year, month }) =>
      fetchWithRetry(
        `https://www.president.go.kr/ajaxf/frSchedule/getSchedule.do?pSiteNo=2&pYear=${year}&pMonth=${month}`,
        { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.president.go.kr/schedule' } }
      ).then((r) => r.json())
    )
  );

  const events = [];
  responses.forEach((resp) => {
    const list = (resp.data && resp.data.list) || [];
    list.forEach((item) => {
      const subject = item.SUBJECT || '';
      if (!GOV_ECONOMY_KEYWORDS.some((kw) => subject.includes(kw))) return;
      const date = item.SCH_DT ? item.SCH_DT.replace(/\./g, '-') : null;
      if (!date) return;

      events.push({
        date,
        type: 'GOV',
        title: subject.split('/')[0].trim(),
        detail: item.SCH_PLACE || null,
      });
    });
  });

  return events;
}

// Combines the fixed macro calendar with the president's economy-related
// schedule. Best-effort: if the gov schedule fetch fails, the fixed macro
// calendar alone is still returned rather than failing the whole request.
app.get('/api/calendar', async (req, res) => {
  const govResult = await Promise.allSettled([fetchGovSchedule()]);
  const [{ status, value, reason }] = govResult;

  if (status === 'rejected') console.error('Failed to fetch gov schedule:', reason.message);
  const govEvents = status === 'fulfilled' ? value : [];

  const events = [...MACRO_EVENTS_2026, ...QUADRUPLE_WITCHING_DAYS_2026, ...govEvents].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  );

  res.json({ events, updatedAt: new Date().toISOString() });
});

// Naver migrated finance.naver.com/research/* to client-rendered pages with
// no server-side HTML table, so this calls the same mobile-app JSON API
// those pages themselves fetch from (free, no key) instead of scraping HTML.
// "company" is 종목분석 (stock name per row); "industry" is 산업분석 (sector
// name per row instead of a stock).
async function fetchNaverResearch(category, limit = 20) {
  const upstream = await fetchWithRetry(`https://m.stock.naver.com/api/research/${category}`, {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://m.stock.naver.com/' },
  });

  const items = await upstream.json();

  return items.slice(0, limit).map((item) => ({
    label: category === 'company' ? item.itemName : item.category,
    title: item.title,
    firm: item.brokerName,
    date: item.writeDate,
    link: item.endUrl || null,
  }));
}

app.get('/api/reports', async (req, res) => {
  try {
    const [industry, company] = await Promise.all([
      fetchNaverResearch('industry', 20),
      fetchNaverResearch('company', 20),
    ]);
    res.json({ industry, company, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Failed to fetch research reports:', err.message);
    res.status(502).json({ error: 'Failed to fetch research reports' });
  }
});

// ── 관심종목 / 적정주가 ──

// Naver's stock-search autocomplete; free, no key.
async function fetchStockSearch(query) {
  const upstream = await fetchWithRetry(
    `https://ac.stock.naver.com/ac?q=${encodeURIComponent(query)}&target=stock`,
    { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://m.stock.naver.com/' } }
  );
  const data = await upstream.json();

  return (data.items || [])
    .filter((item) => item.category === 'stock')
    .map((item) => ({ code: item.code, name: item.name, market: item.typeName }));
}

// "김정환 적정주가 만능공식" (교재 확인): 적정주가 = (BPS×ROE)/r = EPS×12, r=1/12
// 가정. EPS를 API가 직접 주므로 그 값을 그대로 12배 한다.
function readFinanceValue(financeInfo, title, periodKey) {
  const row = financeInfo.rowList.find((r) => r.title === title);
  const raw = row && row.columns[periodKey] && row.columns[periodKey].value;
  if (!raw) return null;
  const num = Number(String(raw).replace(/,/g, ''));
  return Number.isNaN(num) ? null : num;
}

// 연간 실적 하나만 쓰면 회계연도가 끝날 때까지 최대 9개월 묵은 값을 쓰게
// 된다. 대신 가장 최근 "확정"(컨센서스 아닌) 분기 4개의 EPS를 그대로 합쳐
// TTM(최근 12개월) 실적을 만든다 — 분기 실적이 발표될 때마다 갱신되므로
// 항상 최신 상태를 반영한다. BPS/ROE는 (분기별로 누적이 아니라 그 분기의
// 재무상태표 스냅샷이라) 가장 최근 분기 값을 그대로 쓴다.
function computeTtmFairValue(quarterFinanceInfo) {
  const confirmedQuarters = quarterFinanceInfo.trTitleList.filter((t) => t.isConsensus !== 'Y');
  const last4 = confirmedQuarters.slice(-4);
  if (last4.length < 4) return null;

  const quarterlyEps = last4.map((p) => readFinanceValue(quarterFinanceInfo, 'EPS', p.key));
  if (quarterlyEps.some((v) => v === null)) return null;

  const ttmEps = quarterlyEps.reduce((sum, v) => sum + v, 0);
  if (ttmEps <= 0) return null;

  const latestQuarter = last4[last4.length - 1];

  return {
    period: `TTM ${last4[0].title}~${latestQuarter.title}`,
    eps: ttmEps,
    bps: readFinanceValue(quarterFinanceInfo, 'BPS', latestQuarter.key),
    roe: readFinanceValue(quarterFinanceInfo, 'ROE', latestQuarter.key),
    fairValue: Math.round(ttmEps * 12),
    quarters: last4.map((p, i) => ({
      period: p.title,
      eps: quarterlyEps[i],
      revenue: readFinanceValue(quarterFinanceInfo, '매출액', p.key),
      operatingProfit: readFinanceValue(quarterFinanceInfo, '영업이익', p.key),
    })),
  };
}

// 컨센서스(애널리스트 추정)는 분기별로 조각내 합칠 이유가 없어 연간
// 데이터의 추정 연도를 그대로 사용한다.
function computeConsensusFairValue(annualFinanceInfo) {
  const consensusPeriod = [...annualFinanceInfo.trTitleList].reverse().find((t) => t.isConsensus === 'Y');
  if (!consensusPeriod) return null;

  const eps = readFinanceValue(annualFinanceInfo, 'EPS', consensusPeriod.key);
  if (!eps || eps <= 0) return null;

  return {
    period: consensusPeriod.title,
    eps,
    bps: readFinanceValue(annualFinanceInfo, 'BPS', consensusPeriod.key),
    roe: readFinanceValue(annualFinanceInfo, 'ROE', consensusPeriod.key),
    fairValue: Math.round(eps * 12),
  };
}

async function fetchStockValuation(code) {
  const [priceData, annualData, quarterData] = await Promise.all([
    fetchWithRetry(`https://polling.finance.naver.com/api/realtime/domestic/stock/${code}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://finance.naver.com/' },
    }).then((r) => r.json()),
    fetchWithRetry(`https://m.stock.naver.com/api/stock/${code}/finance/annual`, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://m.stock.naver.com/' },
    }).then((r) => r.json()),
    fetchWithRetry(`https://m.stock.naver.com/api/stock/${code}/finance/quarter`, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://m.stock.naver.com/' },
    }).then((r) => r.json()),
  ]);

  const priceItem = priceData.datas && priceData.datas[0];
  const currentPrice = priceItem ? Number(priceItem.closePriceRaw) : null;

  const confirmed = quarterData.financeInfo ? computeTtmFairValue(quarterData.financeInfo) : null;
  const consensus = annualData.financeInfo ? computeConsensusFairValue(annualData.financeInfo) : null;

  const withVerdict = (fv) => {
    if (!fv || !currentPrice) return fv ? { ...fv, gapRatio: null, verdict: null } : null;
    const gapRatio = ((fv.fairValue - currentPrice) / currentPrice) * 100;
    const verdict = gapRatio > 0 ? 'UNDERVALUED' : gapRatio < 0 ? 'OVERVALUED' : 'FAIR';
    return { ...fv, gapRatio, verdict };
  };

  return {
    code,
    name: priceItem ? priceItem.stockName : null,
    currentPrice,
    change: priceItem ? priceItem.compareToPreviousClosePrice : null,
    changeRatio: priceItem ? priceItem.fluctuationsRatio : null,
    direction: priceItem ? priceItem.compareToPreviousPrice.name : null,
    fairValue: confirmed || consensus ? { confirmed: withVerdict(confirmed), consensus: withVerdict(consensus) } : null,
  };
}

app.get('/api/stock-search', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) return res.json({ results: [] });

  try {
    res.json({ results: await fetchStockSearch(query) });
  } catch (err) {
    console.error('Failed to search stocks:', err.message);
    res.status(502).json({ error: 'Failed to search stocks' });
  }
});

app.get('/api/watchlist', requireAuth, async (req, res) => {
  try {
    const snapshot = await db
      .collection('users')
      .doc(req.uid)
      .collection('watchlist')
      .orderBy('addedAt', 'asc')
      .get();

    const items = await Promise.all(
      snapshot.docs.map(async (doc) => {
        const { code, name, group } = doc.data();
        try {
          const valuation = await fetchStockValuation(code);
          return { ...valuation, group: group || 1 };
        } catch (err) {
          console.error(`Failed to value ${code}:`, err.message);
          return { code, name, group: group || 1, error: true };
        }
      })
    );

    res.json({ items });
  } catch (err) {
    console.error('Failed to fetch watchlist:', err.message);
    res.status(502).json({ error: 'Failed to fetch watchlist' });
  }
});

app.post('/api/watchlist', requireAuth, async (req, res) => {
  const { code, name } = req.body || {};
  const group = Number(req.body && req.body.group) || 1;
  if (!code || !name) return res.status(400).json({ error: 'code and name are required' });
  if (!Number.isInteger(group) || group < 1 || group > 5) {
    return res.status(400).json({ error: 'group must be an integer between 1 and 5' });
  }

  try {
    await db.collection('users').doc(req.uid).collection('watchlist').doc(code).set({
      code,
      name,
      group,
      addedAt: FieldValue.serverTimestamp(),
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to add to watchlist:', err.message);
    res.status(502).json({ error: 'Failed to add to watchlist' });
  }
});

app.patch('/api/watchlist/:code', requireAuth, async (req, res) => {
  const group = Number(req.body && req.body.group);
  if (!Number.isInteger(group) || group < 1 || group > 5) {
    return res.status(400).json({ error: 'group must be an integer between 1 and 5' });
  }

  try {
    await db.collection('users').doc(req.uid).collection('watchlist').doc(req.params.code).update({ group });
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to move watchlist item:', err.message);
    res.status(502).json({ error: 'Failed to move watchlist item' });
  }
});

app.delete('/api/watchlist/:code', requireAuth, async (req, res) => {
  try {
    await db.collection('users').doc(req.uid).collection('watchlist').doc(req.params.code).delete();
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to remove from watchlist:', err.message);
    res.status(502).json({ error: 'Failed to remove from watchlist' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
