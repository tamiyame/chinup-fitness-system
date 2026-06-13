// IG 1:1 圖卡生成器：將 product-showcase.html 各章節重排為 1080×1080 卡片並輸出 JPEG。
const puppeteer = require('puppeteer-core');
const { execSync } = require('child_process');

const IG_CSS = `
/* ── IG 1:1 卡片模式（螢幕注入）── */
body{counter-reset:card;background:#e2e8f0}
.wrap{max-width:100%;height:100%;margin:0;padding:0;display:flex;flex-direction:column}
header.hero, section{width:1080px;height:1080px;overflow:hidden;padding:64px 72px 96px;position:relative;counter-increment:card;box-sizing:border-box}
section{background:#fff}
section.spec{background:var(--sky-900);padding:64px 72px 96px}
.wrap{justify-content:center}

/* 標題區（字級全面放大以利 IG 手機瀏覽） */
.sec-no{font-size:19px;letter-spacing:.22em}
h2{font-size:45px;line-height:1.32}
.sec-head{max-width:100%;margin-bottom:10px}
.sec-head p{font-size:23px;line-height:1.6;margin-top:14px}

/* 主內容：手機略縮固定左欄、要點右欄加寬 */
.cols, .cols.r{grid-template-columns:380px 1fr;gap:40px;align-items:center;min-height:0}
.cols.r .phone-col{order:0}
.phone-col>div{transform:scale(.98);transform-origin:top center}
.phone-cap{font-size:15px;margin-top:12px}
.feature-list{gap:22px}
.feature-list li{font-size:23px;line-height:1.55;gap:16px}
.feature-list li::before{width:32px;height:32px;font-size:19px;border-radius:9px;margin-top:3px}

/* 流程與角色階梯 */
.step{padding:16px 24px 16px 30px}
.step::before{width:38px;height:38px;font-size:18px;top:18px}
.step b{font-size:22px;margin-bottom:5px}
.step p{font-size:19px;line-height:1.5}
.ladder{gap:16px}
.ladder .lv{font-size:22px;padding:20px 22px;gap:16px}
.ladder .lv b{font-size:23px}
.ladder .lv .dotz{width:54px;height:54px;font-size:25px;border-radius:15px}
.ladder .lv .tiny{font-size:17px}

/* footer 品牌＋頁碼 */
section::before{content:'CHINUP PERFORMANCE';position:absolute;left:72px;bottom:42px;font-size:16px;font-weight:800;letter-spacing:.18em;color:var(--ink-mute)}
section::after{content:counter(card,decimal-leading-zero) ' / 17';position:absolute;right:72px;bottom:42px;font-size:16px;font-weight:800;letter-spacing:.12em;color:var(--ink-mute)}
section.spec::before, section.spec::after{color:#7dd3fc}

/* 封面 */
.hero{display:flex;align-items:center}
.hero .wrap{justify-content:center}
.hero .kicker{font-size:17px;align-self:flex-start}
.hero h1{font-size:60px}
.hero p.lead{font-size:25px;margin-top:22px;max-width:100%;line-height:1.6}
.hero .stats{margin-top:42px;display:grid;grid-template-columns:1fr 1fr;gap:16px}
.hero .stat{padding:20px 28px}
.hero .stat b{font-size:32px}
.hero .stat span{font-size:18px}
.swipe{margin-top:40px;font-size:20px;font-weight:700;color:#fff;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.35);border-radius:999px;padding:14px 30px;display:inline-block;align-self:flex-start}

/* 技術規格＋聲明 */
.spec .sec-head{margin-bottom:0}
.spec-grid{grid-template-columns:1fr;gap:22px;margin-top:34px}
.spec .card{padding:30px 34px;font-size:22px;line-height:1.7}
.spec .card b{font-size:25px}
.disclaimer{padding:30px 0 0;text-align:left;font-size:16px;color:#bae6fdaa;line-height:1.6}
`;

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1080, deviceScaleFactor: 2 });
  await page.goto('file:///Users/ryansheu/projects/chinup-fitness-system/docs/product-showcase.html',
    { waitUntil: 'networkidle0', timeout: 60000 });

  await page.evaluate((css) => {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    // 聲明移入最後一張（技術規格）卡片
    const spec = document.querySelector('.spec .wrap');
    const disc = document.querySelector('.disclaimer');
    if (spec && disc) spec.appendChild(disc);
    // 封面加輪播提示
    const hero = document.querySelector('.hero .wrap');
    const hint = document.createElement('div');
    hint.className = 'swipe';
    hint.textContent = '往左滑動，看完整 14 大功能 →';
    hero.appendChild(hint);
    return document.fonts.ready;
  }, IG_CSS);
  await new Promise(r => setTimeout(r, 400));

  const cards = await page.$$('header.hero, section');
  console.log('cards:', cards.length);
  for (let i = 0; i < cards.length; i++) {
    const n = String(i + 1).padStart(2, '0');
    const png = `/tmp/pdfgen/card-${n}.png`;
    await cards[i].screenshot({ path: png });
    execSync(`sips -z 1080 1080 -s format jpeg -s formatOptions 92 "${png}" --out "/Users/ryansheu/projects/chinup-fitness-system/docs/ig/card-${n}.jpg" >/dev/null`);
  }
  await browser.close();
  console.log('done');
})().catch(e => { console.error(e.message); process.exit(1); });
