/* 验证小程序选择器引擎支不支持属性选择器（决定 ①/② 的量矩形方案）。
 */
const path = require('path');
const automator = require(path.join(__dirname, 'wx-upload', 'node_modules', 'miniprogram-automator'));
const WS = process.env.WXIDE_WS || 'ws://127.0.0.1:9420';

async function main() {
  const mp = await automator.connect({ wsEndpoint: WS });
  try {
    await mp.reLaunch('/pages/roster/index');
    await new Promise(r => setTimeout(r, 2600));
    const page = await mp.currentPage();
    const rows = await page.$$('.mb-row');
    console.log('.mb-row 数量 =', rows.length);
    if (rows.length) {
      const r0 = await rows[0].attribute('data-id');
      console.log('第 1 行的 data-id =', r0);
      const byAttr = await page.$('.mb-row[data-id="' + r0 + '"]');
      console.log('属性选择器 .mb-row[data-id="' + r0 + '"] =>', byAttr ? '命中' : '未命中');
      const byClass = await page.$('.mb-row');
      console.log('类选择器 .mb-row =>', byClass ? '命中' : '未命中');
      const first = rows[0];
      const off = await first.offset(); const size = await first.size();
      console.log('第 1 行矩形 =', JSON.stringify({ top: off.top, left: off.left, w: size.width, h: size.height }));
    }
  } finally {
    await mp.disconnect().catch(() => {});
  }
}
main().catch(e => { console.error('ERR:', e.message); process.exit(1); });
