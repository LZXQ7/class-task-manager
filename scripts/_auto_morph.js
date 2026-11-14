/* 验证「流体形态」：点成员行 → 中途截图（幽灵层在飞）→ 结束截图（面板到位）。
 * 用法：node scripts/_auto_morph.js <rowSelector> <prefix>
 */
const path = require('path');
const automator = require(path.join(__dirname, 'wx-upload', 'node_modules', 'miniprogram-automator'));
const WS = process.env.WXIDE_WS || 'ws://127.0.0.1:9420';

async function main() {
  const sel = process.argv[2] || '.mb-row';
  const prefix = process.argv[3] || 'C:/Users/PC/WorkBuddy/LZXQ-WorkBuddy/.wb_tmp/shots/morph';
  const mp = await automator.connect({ wsEndpoint: WS });
  try {
    await mp.reLaunch('/pages/roster/index');
    await new Promise(r => setTimeout(r, 2600));
    const page = await mp.currentPage();
    console.log('page =', page.path);
    const row = await page.$(sel);
    if (!row) { console.log(sel, '未找到'); return; }
    const off = await row.offset(); const size = await row.size();
    console.log(`${sel} => top=${off.top} left=${off.left} ${size.width}x${size.height}`);
    const t = row.tap();
    await new Promise(r => setTimeout(r, 330));
    await mp.screenshot({ path: prefix + '_mid.png' });
    console.log('中途截图 ->', prefix + '_mid.png');
    await t.catch(() => {});
    await new Promise(r => setTimeout(r, 700));
    await mp.screenshot({ path: prefix + '_end.png' });
    console.log('结束截图 ->', prefix + '_end.png');
  } finally {
    await mp.disconnect().catch(() => {});
  }
}
main().catch(e => { console.error('ERR:', e.message); process.exit(1); });
