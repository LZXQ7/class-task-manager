/* 量页面元素的盒子（offset + size），用来定位空白块。
 * 用法：node scripts/_auto_measure.js <sel1> <sel2> ...
 */
const path = require('path');
const automator = require(path.join(__dirname, 'wx-upload', 'node_modules', 'miniprogram-automator'));
const WS = process.env.WXIDE_WS || 'ws://127.0.0.1:9420';

async function main() {
  const sels = process.argv.slice(2);
  const mp = await automator.connect({ wsEndpoint: WS });
  try {
    const page = await mp.currentPage();
    console.log('page =', page.path);
    for (const sel of sels) {
      try {
        const el = await page.$(sel);
        if (!el) { console.log(`${sel} => (未找到)`); continue; }
        const off = await el.offset();
        const size = await el.size();
        console.log(`${sel} => top=${off.top} left=${off.left} w=${size.width} h=${size.height} bottom=${off.top + size.height}`);
      } catch (e) {
        console.log(`${sel} => ERR ${e.message}`);
      }
    }
  } finally {
    await mp.disconnect().catch(() => {});
  }
}
main().catch(e => { console.error('ERR:', e.message); process.exit(1); });
