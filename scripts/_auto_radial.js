/* 验收 ⑩ 课表弧形菜单：长按左下角 FAB → 弧形菜单展开。
 * 用法：node scripts/_auto_radial.js
 */
const path = require('path');
const automator = require(path.join(__dirname, 'wx-upload', 'node_modules', 'miniprogram-automator'));
const WS = process.env.WXIDE_WS || 'ws://127.0.0.1:9420';

async function main() {
  const mp = await automator.connect({ wsEndpoint: WS });
  const shot = 'C:/Users/PC/WorkBuddy/LZXQ-WorkBuddy/.wb_tmp/shots/';
  try {
    await mp.reLaunch('/pages/timetable/index');
    await new Promise(r => setTimeout(r, 3000));
    const page = await mp.currentPage();
    console.log('page =', page.path);
    const fab = await page.$('.fab-menu-btn');
    if (!fab) { console.log('.fab-menu-btn 未找到（可能该身份没有课表入口）'); return; }
    const off = await fab.offset(); const size = await fab.size();
    console.log('FAB => top=' + off.top + ' left=' + off.left + ' ' + size.width + 'x' + size.height);
    await mp.screenshot({ path: shot + 'radial_before.png' });

    const p = fab.longpress();
    await new Promise(r => setTimeout(r, 380));
    console.log('fmShow =', await page.data('fmShow'));
    console.log('fmX/fmY =', await page.data('fmX'), await page.data('fmY'));
    console.log('fmItems =', JSON.stringify(await page.data('fmItems')));
    const rm = await page.$('radial-menu');
    console.log('radial-menu 节点 =', rm ? '在' : '不在');
    await mp.screenshot({ path: shot + 'radial_open.png' });
    console.log('长按后截图 ->', shot + 'radial_open.png');
    await p.catch(() => {});
  } finally {
    await mp.disconnect().catch(() => {});
  }
}
main().catch(e => { console.error('ERR:', e.message); process.exit(1); });
