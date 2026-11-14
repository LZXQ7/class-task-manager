/* 统计页面上的可点元素与按压反馈覆盖情况。
 * 用法：node scripts/_auto_audit.js <pagePath>
 */
const path = require('path');
const automator = require(path.join(__dirname, 'wx-upload', 'node_modules', 'miniprogram-automator'));
const WS = process.env.WXIDE_WS || 'ws://127.0.0.1:9420';

async function main() {
  const target = process.argv[2] || 'pages/home/index';
  const mp = await automator.connect({ wsEndpoint: WS });
  try {
    await mp.reLaunch('/' + target);
    await new Promise(r => setTimeout(r, 2200));
    const page = await mp.currentPage();
    console.log('page =', page.path);
    for (const sel of ['.pressable', '.press-shrink', '.tap-hover', '.press-dim', '.card', '.tilt-card', '.tg-wrap', '.st-item', '.m-press', '.m-glass', '.m-aura', '.m-stagger']) {
      const els = await page.$$(sel);
      console.log(`${sel} => ${els.length}`);
    }
    // 页面根节点 class（看动效降级类有没有挂上）
    const root = await page.$('.page');
    if (root) console.log('.page class =', await root.attribute('class'));
    const body = await page.$('body');
    if (body) console.log('body class =', await body.attribute('class'));
  } finally {
    await mp.disconnect().catch(() => {});
  }
}
main().catch(e => { console.error('ERR:', e.message); process.exit(1); });
