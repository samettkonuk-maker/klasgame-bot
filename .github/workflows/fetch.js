/**
 * Klasgame GB kuru toplayÄ±cÄ± â€” GitHub Actions'ta GERÃ‡EK tarayÄ±cÄ±yla Ã§alÄ±ÅŸÄ±r.
 *
 * Klasgame sunucu isteklerine Cloudflare doÄŸrulamasÄ± ("Just a moment") gÃ¶steriyor;
 * gerÃ§ek bir tarayÄ±cÄ± bu doÄŸrulamayÄ± kendisi Ã§Ã¶zdÃ¼ÄŸÃ¼ iÃ§in sayfa normal aÃ§Ä±lÄ±r.
 *
 * DAKÄ°KADA BÄ°R: GitHub'Ä±n zamanlayÄ±cÄ±sÄ± en sÄ±k 5 dakikada bir tetikleyebiliyor ve
 * yoÄŸunlukta gecikiyor. Bu yÃ¼zden TEK Ã§alÄ±ÅŸtÄ±rma iÃ§inde dÃ¶ngÃ¼ kuruyoruz: tarayÄ±cÄ± bir
 * kez aÃ§Ä±lÄ±r, sonra LOOP_COUNT kez LOOP_SECONDS aralÄ±kla sayfa yenilenip veri gÃ¶nderilir.
 * BÃ¶ylece hem gerÃ§ek dakikalÄ±k tazelik olur hem de her turda kurulum maliyeti Ã¶denmez.
 *
 * Ortam deÄŸiÅŸkenleri (GitHub â†’ Settings â†’ Secrets/Variables):
 *   SITE_URL      â†’ https://ko4merc.com                (secret)
 *   INGEST_KEY    â†’ Ayarlar'daki "TarayÄ±cÄ± eklentisi anahtarÄ±"  (secret)
 *   LOOP_COUNT    â†’ kaÃ§ tur (varsayÄ±lan 55)            (variable)
 *   LOOP_SECONDS  â†’ turlar arasÄ± saniye (varsayÄ±lan 60)(variable)
 *   HUB_URL / SELL_URL â†’ baÅŸka Ã¼rÃ¼n takip edeceksen    (variable)
 */
const { chromium } = require('playwright');

const SITE = (process.env.SITE_URL || '').replace(/\/+$/, '');
const KEY = process.env.INGEST_KEY || '';
const HUB = process.env.HUB_URL || 'https://www.klasgame.com/mmorpg-oyunlar/ko4fun/ko4fun-immortal-goldbar';
const SELL = process.env.SELL_URL
    || 'https://www.klasgame.com/satis-yap/mmorpg-oyunlar/ko4fun/ko4fun-immortal-goldbar/ko4fun-nemesis-10m';
const LOOP_COUNT = Math.max(1, parseInt(process.env.LOOP_COUNT || '55', 10));
const LOOP_SECONDS = Math.max(20, parseInt(process.env.LOOP_SECONDS || '60', 10));

if (!SITE || !KEY) {
    console.error('SITE_URL ve INGEST_KEY tanÄ±mlÄ± deÄŸil (GitHub Secrets).');
    process.exit(1);
}

const bekle = (ms) => new Promise((r) => setTimeout(r, ms));

/** Cloudflare doÄŸrulamasÄ± geÃ§ene kadar bekle. */
async function ac(page, url, yenile = false) {
    if (yenile) {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
    } else {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    }

    for (let i = 0; i < 30; i++) {
        const html = await page.content();
        if (!/Just a moment|cdn-cgi\/challenge-platform/i.test(html)) {
            return;
        }
        await page.waitForTimeout(2000);
    }

    throw new Error('Cloudflare doÄŸrulamasÄ± 60 saniyede geÃ§ilemedi: ' + url);
}

/** Kategori sayfasÄ±ndaki Ã¼rÃ¼n kartlarÄ±: fiyat, stok, "BÄ°ZE SAT" durumu. */
function hubOku() {
    const out = {};

    document.querySelectorAll('a[href*="/satis-yap/"]').forEach((a) => {
        const href = a.getAttribute('href') || '';
        const m = href.match(/satis-yap\/([^"?#]+)/);
        if (!m) return;

        const path = 'satis-yap/' + m[1].replace(/\/+$/, '');
        if (href.indexOf('?') !== -1 && !/BÄ°ZE SAT|BIZE SAT/i.test(a.textContent || '')) return;

        const blocked = /alÄ±ÅŸ aktif gÃ¶rÃ¼nmÃ¼yor/i.test(a.getAttribute('onclick') || '');
        const rec = out[path] || (out[path] = { sell_path: path });
        rec.sell_open = !blocked;

        let card = a.closest('.product-row, .product-column, li, tr, div');
        for (let i = 0; i < 6 && card; i++) {
            const basket = card.querySelector('a[data-price][data-id]');
            if (basket) {
                rec.sell_price = parseFloat(basket.getAttribute('data-price'));
                rec.klas_id = parseInt(basket.getAttribute('data-id'), 10);
                rec.stock = !!card.querySelector('.stock-on, .stock-in-icon');
                break;
            }
            card = card.parentElement;
        }
    });

    return out;
}

/** "Bize sat" sayfasÄ±ndaki listeden ALIÅ fiyatlarÄ±. */
function alisOku() {
    const buy = {};

    document.querySelectorAll('select[name="product_id"] option').forEach((o) => {
        const id = parseInt(o.value, 10);
        const num = o.getAttribute('data-pricenum');
        if (id && num) buy[id] = parseFloat(num);
    });

    return buy;
}

/** Bir tur: iki sayfayÄ± oku, siteye gÃ¶nder. */
async function tur(hubPage, sellPage, ilk) {
    await ac(hubPage, HUB, !ilk);
    const hub = await hubPage.evaluate(hubOku);

    await ac(sellPage, SELL, !ilk);
    const buy = await sellPage.evaluate(alisOku);

    const rows = Object.values(hub).map((r) => {
        if (r.klas_id && buy[r.klas_id] !== undefined) r.buy_price = buy[r.klas_id];
        return r;
    });

    if (!rows.length) {
        throw new Error('Sayfada Ã¼rÃ¼n bulunamadÄ± (klasgame yapÄ±sÄ± deÄŸiÅŸmiÅŸ olabilir).');
    }

    const res = await fetch(SITE + '/api/gb-rate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ key: KEY, products: rows }),
    });

    const text = await res.text();

    if (!res.ok) {
        throw new Error('Site reddetti: HTTP ' + res.status + ' ' + text);
    }

    return text;
}

(async () => {
    const browser = await chromium.launch({ args: ['--disable-blink-features=AutomationControlled'] });
    const ctx = await browser.newContext({
        locale: 'tr-TR',
        timezoneId: 'Europe/Istanbul',
        viewport: { width: 1366, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    });

    const hubPage = await ctx.newPage();
    const sellPage = await ctx.newPage();

    let basarili = 0;
    let hatali = 0;

    for (let i = 1; i <= LOOP_COUNT; i++) {
        const t0 = Date.now();

        try {
            const cevap = await tur(hubPage, sellPage, i === 1);
            basarili++;
            console.log(`[${i}/${LOOP_COUNT}] âœ“ ${cevap}`);
        } catch (e) {
            hatali++;
            console.error(`[${i}/${LOOP_COUNT}] âœ— ${e.message}`);

            // Sayfa/oturum bozulduysa bir sonraki tur baÅŸtan aÃ§sÄ±n.
            try { await hubPage.goto('about:blank'); await sellPage.goto('about:blank'); } catch (_) {}
        }

        if (i < LOOP_COUNT) {
            const gecen = Date.now() - t0;
            await bekle(Math.max(1000, LOOP_SECONDS * 1000 - gecen));
        }
    }

    await browser.close();

    console.log(`Bitti: ${basarili} baÅŸarÄ±lÄ±, ${hatali} hatalÄ± tur.`);

    // HiÃ§bir tur tutmadÄ±ysa iÅŸ kÄ±rmÄ±zÄ± olsun ki bildirim gelsin.
    if (basarili === 0) process.exit(1);
})();
