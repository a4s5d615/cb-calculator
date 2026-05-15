const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');
const path    = require('path');

const app  = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
//  共用 headers（模擬瀏覽器，避免被擋）
// ─────────────────────────────────────────────
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BASE_HEADERS = {
  'User-Agent':      UA,
  'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.5',
  'Accept':          'text/html,application/json,*/*',
};

const http = axios.create({ timeout: 12000, headers: BASE_HEADERS });

// ─────────────────────────────────────────────
//  1. 股票即時/最近成交價 (TWSE mis)
//     TSE 先試，失敗再試 OTC
// ─────────────────────────────────────────────
async function fetchStockPrice(stockCode) {
  for (const market of ['tse', 'otc']) {
    try {
      const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp`
                + `?ex_ch=${market}_${stockCode}.tw&json=1&delay=0`;
      const res = await http.get(url, {
        headers: { ...BASE_HEADERS, Referer: 'https://mis.twse.com.tw/' }
      });
      const item = res.data?.msgArray?.[0];
      if (!item) continue;

      // 盤中用 z，收盤後用 y（前日收盤）
      const price = (item.z && item.z !== '-') ? parseFloat(item.z)
                  : (item.y && item.y !== '-') ? parseFloat(item.y)
                  : null;
      if (!price) continue;

      return {
        market,
        price,
        name:      item.n  || '',
        fullName:  item.nf || item.n || '',
        prevClose: (item.y && item.y !== '-') ? parseFloat(item.y) : null,
        open:      (item.o && item.o !== '-') ? parseFloat(item.o) : null,
        high:      (item.h && item.h !== '-') ? parseFloat(item.h) : null,
        low:       (item.l && item.l !== '-') ? parseFloat(item.l) : null,
      };
    } catch (_) {}
  }
  return null;
}

// TPEX 產業代碼對照表
const TPEX_INDUSTRY_NAMES = {
  '01':'農業科技', '02':'食品工業', '03':'塑膠工業', '04':'纖維紡織',
  '05':'電機機械', '06':'電器電纜', '07':'化學生技醫療', '08':'玻璃陶瓷',
  '09':'造紙工業', '10':'鋼鐵工業', '11':'橡膠工業', '12':'汽車工業',
  '13':'建材營造', '14':'航運業',   '15':'觀光餐旅', '16':'金融保險',
  '17':'貿易百貨', '18':'綜合',     '19':'其他',     '20':'文化創意',
  '21':'運動休閒', '22':'半導體業', '23':'電腦及周邊設備業', '24':'光電業',
  '25':'通信網路業', '26':'電子零組件業', '27':'電子通路業', '28':'資訊服務業',
  '29':'其他電子業', '30':'油電燃氣業', '31':'電動車', '32':'綠能環保',
  '33':'農業科技',
};

// TPEX 產業代碼 → 我們的 key
function mapIndustryCode(code) {
  const n = parseInt(code);
  if (n === 25)              return 'telecom_ai';
  if (n === 22)              return 'semiconductor';
  if ([26, 27, 29].includes(n)) return 'electronics';
  if ([23, 28].includes(n)) return 'computer';
  if (n === 24)              return 'computer';
  if (n === 7)               return 'biotech';
  if ([15, 21].includes(n)) return 'consumer';
  if ([2, 4].includes(n))   return 'consumer';
  if ([3,6,8,9,10,11,12,13,14].includes(n)) return 'traditional';
  return 'other';
}

// ─────────────────────────────────────────────
//  2. 公司資本額 & 產業別
//     TWSE OpenAPI（上市）→ TPEX OpenAPI（上櫃）
// ─────────────────────────────────────────────
async function fetchCompanyInfo(stockCode) {
  // ── TWSE 上市（欄位為中文）──
  try {
    const res = await http.get('https://openapi.twse.com.tw/v1/opendata/t187ap03_L');
    if (Array.isArray(res.data)) {
      const c = res.data.find(r => r['公司代號'] === stockCode);
      if (c) {
        const capRaw = parseFloat((c['實收資本額'] || '0').replace(/,/g, ''));
        const shareCapital = capRaw / 1e8; // 元 → 億
        return {
          shareCapital: parseFloat(shareCapital.toFixed(2)),
          industryText: c['產業別'] || c['類別'] || '',
          industryCode: null,
          companyName:  c['公司簡稱'] || c['公司名稱'] || '',
        };
      }
    }
  } catch (_) {}

  // ── TPEX 上櫃（欄位為英文）──
  try {
    const res = await http.get('https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O');
    if (Array.isArray(res.data)) {
      const c = res.data.find(r => r['SecuritiesCompanyCode'] === stockCode);
      if (c) {
        const capRaw = parseFloat((c['Paidin.Capital.NTDollars'] || '0').replace(/,/g, ''));
        const shareCapital = capRaw / 1e8; // 元 → 億
        return {
          shareCapital:  parseFloat(shareCapital.toFixed(2)),
          industryText:  null,
          industryCode:  c['SecuritiesIndustryCode'] || null,
          companyName:   c['CompanyAbbreviation'] || c['CompanyName'] || '',
        };
      }
    }
  } catch (_) {}

  return null;
}

// ─────────────────────────────────────────────
//  3. 可轉債基本資料 (MOPS ajax_t158sb05)
//     co_id = 4 碼股票代號, cbno = CB 序號字元
// ─────────────────────────────────────────────
async function fetchCBFromMOPS(stockCode, cbSeq) {
  try {
    const params = new URLSearchParams({
      encodeURIComponent: '1',
      step:      '1',
      firstin:   '1',
      off:       '1',
      co_id:     stockCode,
      cbno:      cbSeq,
    });
    const res = await http.post(
      'https://mops.twse.com.tw/mops/web/ajax_t158sb05',
      params.toString(),
      { headers: {
          ...BASE_HEADERS,
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Referer':       'https://mops.twse.com.tw/mops/web/t158sb05',
          'X-Requested-With': 'XMLHttpRequest',
        }
      }
    );

    const $    = cheerio.load(res.data);
    const data = {};

    $('table tr').each((_, row) => {
      const cells = cheerio.load(row)('td');
      if (cells.length < 2) return;
      const label = cells.eq(0).text().trim();
      const val   = cells.eq(1).text().trim();

      if (!data.conversionPrice && /轉換價格|換股價格/.test(label)) {
        const m = val.match(/([\d,]+\.?\d*)\s*元/);
        if (m) data.conversionPrice = parseFloat(m[1].replace(/,/g, ''));
      }
      if (!data.collateral && /擔保|保證/.test(label)) {
        data.collateral     = /無擔保/.test(val) ? 'unsecured' : 'secured';
        data.collateralText = val;
      }
      if (!data.term && /到期日|年期|期間/.test(label)) {
        const ym = val.match(/(\d+)\s*年/);
        if (ym) data.term = parseInt(ym[1]);
        // 若只有到期日，推算年數
        if (!data.term && /\d{3}\/\d{2}\/\d{2}/.test(val)) {
          const [yr, mo, dy] = val.trim().split('/').map(Number);
          const expire = new Date(yr + 1911, mo - 1, dy);
          const now    = new Date();
          data.term    = Math.round((expire - now) / (365.25 * 24 * 3600 * 1000));
        }
      }
      if (!data.issueSize && /發行總額|發行金額|發行面額/.test(label)) {
        const m = val.match(/([\d,]+)/);
        if (m) {
          const raw = parseInt(m[1].replace(/,/g, ''));
          // 通常單位為千元，也可能已是億
          data.issueSize = raw >= 1e8 ? raw / 1e8
                         : raw >= 1e4 ? raw / 1e4  // 千元 → 億
                         : raw;
          data.issueSize = parseFloat(data.issueSize.toFixed(2));
        }
      }
      if (!data.underwriter && /承銷商|輔導機構|主辦承銷/.test(label)) {
        data.underwriter = val.replace(/\s+/g, '');
      }
      if (!data.couponRate && /票面利率|利率/.test(label)) {
        const m = val.match(/([\d.]+)\s*%/);
        if (m) data.couponRate = parseFloat(m[1]);
      }
    });

    return Object.keys(data).length > 0 ? data : null;
  } catch (e) {
    console.error('[MOPS t158sb05]', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────
//  4. 從 TWSE 承銷資訊抓 CB 拍賣詳情（補充用）
//     嘗試解析 TWSE 公告頁，取得承銷商與發行條件
// ─────────────────────────────────────────────
async function fetchCBFromTWSESubscription(cbCode) {
  try {
    const res = await http.get(
      `https://www.twse.com.tw/rwd/zh/subscription/cbPriceAuction?response=json`,
      { headers: { ...BASE_HEADERS, Referer: 'https://www.twse.com.tw/' } }
    );
    const list = res.data?.data || res.data?.stat || [];
    if (!Array.isArray(list)) return null;

    // 在清單中找符合 CB 代號的項目
    for (const row of list) {
      const joined = Array.isArray(row) ? row.join('|') : JSON.stringify(row);
      if (joined.includes(cbCode) || (Array.isArray(row) && row[0] === cbCode)) {
        return { raw: row }; // 回傳原始資料供解析
      }
    }
  } catch (_) {}
  return null;
}

// ─────────────────────────────────────────────
//  產業別對應（TWSE 產業別字串 → 前端 key）
// ─────────────────────────────────────────────
function mapIndustry(s) {
  if (!s) return null;
  if (/通信|網路|通訊/.test(s))                   return 'telecom_ai';
  if (/半導體/.test(s))                           return 'semiconductor';
  if (/電子零組件/.test(s))                       return 'electronics';
  if (/電腦|周邊|資訊|軟體|伺服/.test(s))         return 'computer';
  if (/光電/.test(s))                             return 'computer';
  if (/生技|醫療|製藥|醫材/.test(s))              return 'biotech';
  if (/食品|紡織|運動|消費|觀光|百貨/.test(s))    return 'consumer';
  if (/鋼鐵|水泥|化學|玻璃|橡膠|塑膠|紙|航運|汽車|電機|電纜|油電|建材/.test(s)) return 'traditional';
  if (/其他電子/.test(s))                         return 'electronics';
  return 'other';
}

// 承銷商名稱 → key
function mapUnderwriter(s) {
  if (!s) return null;
  if (/富邦/.test(s))   return 'fubon';
  if (/元大/.test(s))   return 'yuanta';
  if (/凱基/.test(s))   return 'kaigi';
  if (/台新/.test(s))   return 'taishin';
  if (/福邦/.test(s))   return 'fubang';
  if (/群益/.test(s))   return 'qunyi';
  if (/兆豐/.test(s))   return 'zhaofeng';
  if (/復華/.test(s))   return 'fuhua';
  return 'other';
}

// ─────────────────────────────────────────────
//  主 API：GET /api/cb/:cbCode
// ─────────────────────────────────────────────
app.get('/api/cb/:cbCode', async (req, res) => {
  const cbCode   = req.params.cbCode.trim().toUpperCase();
  const stockCode = cbCode.substring(0, 4);
  const cbSeq    = cbCode.substring(4); // e.g. '5' or 'A'

  console.log(`[CB Lookup] code=${cbCode}  stock=${stockCode}  seq=${cbSeq}`);

  // 並行抓取所有資料
  const [stockR, companyR, cbR] = await Promise.allSettled([
    fetchStockPrice(stockCode),
    fetchCompanyInfo(stockCode),
    cbSeq ? fetchCBFromMOPS(stockCode, cbSeq) : Promise.resolve(null),
  ]);

  const stock   = stockR.status   === 'fulfilled' ? stockR.value   : null;
  const company = companyR.status === 'fulfilled' ? companyR.value : null;
  const cb      = cbR.status      === 'fulfilled' ? cbR.value      : null;

  const out = {
    cbCode,
    stockCode,
    cbSeq,
    // 股票資訊
    stockName:       stock?.fullName || stock?.name || company?.companyName || null,
    currentPrice:    stock?.price    || null,
    prevClose:       stock?.prevClose || null,
    market:          stock?.market   || null,
    // CB 資訊
    conversionPrice: cb?.conversionPrice || null,
    collateral:      cb?.collateral      || null,
    collateralText:  cb?.collateralText  || null,
    term:            cb?.term            || null,
    issueSize:       cb?.issueSize       || null,
    couponRate:      cb?.couponRate      || null,
    underwriterKey:  cb?.underwriter ? mapUnderwriter(cb.underwriter) : null,
    underwriterName: cb?.underwriter     || null,
    // 公司資訊（TWSE 和 TPEX 的 産業別 均為數字代碼）
    shareCapital: company?.shareCapital || null,
    industryKey: (() => {
      const code = company?.industryCode || company?.industryText;
      if (!code) return null;
      return /^\d+$/.test(code) ? mapIndustryCode(code) : mapIndustry(code);
    })(),
    industryName: (() => {
      const code = company?.industryCode || company?.industryText;
      if (!code) return null;
      if (/^\d+$/.test(code))
        return TPEX_INDUSTRY_NAMES[code.padStart(2,'0')] || `產業代碼 ${code}`;
      return code;
    })(),
    // 快速查詢連結
    mopsUrl: `https://mops.twse.com.tw/mops/web/t158sb05?co_id=${stockCode}&cbno=${cbSeq}`,
    // 狀態
    sources: {
      stockPrice:  !!stock,
      cbData:      !!cb,
      companyData: !!company,
    },
    fetchedAt: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
  };

  console.log('[Result]', JSON.stringify(out, null, 2));
  res.json(out);
});

// ─────────────────────────────────────────────
//  mopsov IpoQueryFast – 取得競拍補充資料
//  （承銷商名、撥券日等；轉換價格不在此 API）
// ─────────────────────────────────────────────
async function fetchFromMopsov(cbCode) {
  try {
    const res = await http.get(
      'https://mopsov.twse.com.tw/server-java/apiM/ipo/interfaces/IpoQueryFast',
      {
        params: {
          requestBody:   JSON.stringify({ stockNo: cbCode, order: 'desc' }),
          requestHeader: '{}',
        },
        headers: { ...BASE_HEADERS, Referer: 'https://mopsov.twse.com.tw/' },
      }
    );
    const body = res.data?.responseBody;
    if (!body || body.state !== 'ok') return null;
    const allType = body.allType?.[0];
    if (!allType) return null;
    return {
      underwriterName: allType.underWriterName || null,
      grantStockDate:  allType.grantStockDate  || null,
    };
  } catch (_) { return null; }
}

// ─────────────────────────────────────────────
//  近期競拍可轉債清單
//  資料來源：TWSE 競價拍賣公告 + mopsov + TWSE MIS
// ─────────────────────────────────────────────
app.get('/api/upcoming-cb', async (req, res) => {
  try {
    const r = await http.get(
      'https://www.twse.com.tw/rwd/zh/announcement/auction?response=json',
      { headers: { ...BASE_HEADERS, Referer: 'https://www.twse.com.tw/' } }
    );

    const fields = r.data?.fields || [];
    const rows   = r.data?.data   || [];

    // 動態建立欄位名稱 → 索引對照
    const fi = {};
    fields.forEach((name, i) => { fi[name] = i; });

    // 備用硬編碼索引（對應 TWSE 2026 版本）
    const IDX = {
      auctionDate:  fi['開標日期']                    ?? 1,
      name:         fi['證券名稱']                    ?? 2,
      code:         fi['證券代號']                    ?? 3,
      market:       fi['發行市場']                    ?? 4,
      issueType:    fi['發行性質']                    ?? 5,
      biddingStart: fi['投標開始日']                  ?? 7,
      biddingEnd:   fi['投標結束日']                  ?? 8,
      quantity:     fi['競拍數量(張)']                ?? 9,
      minBidPrice:  fi['最低投標價格(元)']            ?? 10,
      underwriter:  fi['主辦券商']                    ?? 16,
      cancelled:    fi['取消競價拍賣(流標或取消)']    ?? 25,
    };

    // 今日（台灣時間，忽略時分秒）
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    now.setHours(0, 0, 0, 0);

    function parseDate(s) {
      if (!s) return null;
      const parts = String(s).split('/').map(Number);
      if (parts.length !== 3 || isNaN(parts[0])) return null;
      const d = new Date(parts[0], parts[1] - 1, parts[2]);
      d.setHours(0, 0, 0, 0);
      return d;
    }

    const cbList = rows
      .filter(row => {
        const issueType = row[IDX.issueType] || '';
        if (!issueType.includes('轉換公司債')) return false;
        const cancelled = String(row[IDX.cancelled] || '').trim();
        if (cancelled) return false;
        const auctionDate = parseDate(row[IDX.auctionDate]);
        return auctionDate && auctionDate >= now;
      })
      .map(row => {
        const cbCode    = String(row[IDX.code] || '').trim();
        const stockCode = cbCode.slice(0, 4);
        const cbSeq     = cbCode.slice(4);
        const issueType = row[IDX.issueType] || '';
        const collateral = issueType.includes('無擔保') ? 'unsecured' : 'secured';

        const biddingStart = parseDate(row[IDX.biddingStart]);
        const biddingEnd   = parseDate(row[IDX.biddingEnd]);
        const auctionDate  = parseDate(row[IDX.auctionDate]);

        let status;
        if (biddingStart && biddingEnd && now >= biddingStart && now <= biddingEnd) {
          status = 'bidding';   // 投標中
        } else if (biddingStart && now < biddingStart) {
          status = 'upcoming';  // 即將開放
        } else {
          status = 'pending';   // 投標截止，等待開標
        }

        return {
          cbCode,
          stockCode,
          cbSeq,
          companyName:  row[IDX.name]         || '',
          market:       row[IDX.market]       || '',
          issueType,
          collateral,
          biddingStart: row[IDX.biddingStart] || '',
          biddingEnd:   row[IDX.biddingEnd]   || '',
          auctionDate:  row[IDX.auctionDate]  || '',
          quantity:     row[IDX.quantity]     || '',
          minBidPrice:  row[IDX.minBidPrice]  || '',
          underwriter:  row[IDX.underwriter]  || '',
          status,
          mopsUrl: `https://mops.twse.com.tw/mops/web/t158sb05?co_id=${stockCode}&cbno=${cbSeq}`,
        };
      })
      .sort((a, b) => {
        const da = parseDate(a.auctionDate);
        const db = parseDate(b.auctionDate);
        if (!da) return 1;
        if (!db) return -1;
        return da - db;
      });

    // ── 並行補強：現股價 + mopsov 資料 ──
    const enriched = await Promise.all(cbList.map(async (cb) => {
      const [stockR, mopsovR] = await Promise.allSettled([
        fetchStockPrice(cb.stockCode),
        fetchFromMopsov(cb.cbCode),
      ]);
      const stock  = stockR.status  === 'fulfilled' ? stockR.value  : null;
      const mopsov = mopsovR.status === 'fulfilled' ? mopsovR.value : null;

      return {
        ...cb,
        stockPrice:     stock?.price    || null,
        stockPrevClose: stock?.prevClose || null,
        stockName:      stock?.fullName || stock?.name || cb.companyName,
        // mopsov 的承銷商名稱（若 TWSE 公告已有則保留）
        underwriter:    cb.underwriter || mopsov?.underwriterName || '',
        grantStockDate: mopsov?.grantStockDate || null,
        // 轉換價格無法從伺服器端 API 取得；請至 MOPS 查詢
        conversionPrice: null,
      };
    }));

    res.json({
      ok: true,
      data: enriched,
      total: enriched.length,
      updatedAt: now.toLocaleDateString('zh-TW'),
    });
  } catch (e) {
    console.error('[upcoming-cb]', e.message);
    res.json({ ok: false, data: [], error: e.message });
  }
});

// ─────────────────────────────────────────────
//  啟動
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║  可轉債競標計算機已啟動               ║');
  console.log(`║  http://localhost:${PORT}              ║`);
  console.log('╚══════════════════════════════════════╝\n');
});
