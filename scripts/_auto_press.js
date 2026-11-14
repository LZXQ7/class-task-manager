/* 长按卡片并在「按住」状态下截图，验证按压反馈 + 圆角是否变形。
 * 用法：node scripts/_auto_press.js <selector> <shotPath>
 */
const path = require('path');
const automator = require(path.join(__dirname, 'wx-upload', 'node_modules', 'miniprogram-automator'));
const WS = process.env.WXIDE_WS || 'ws://127.0.0.1:9420';

async function main() {
  const sel = process.argv[2] || '.hero';
  const shot = process.argv[3];
  const mp = await automator.connect({ wsEndpoint: WS });
  try {
    const page = await mp.currentPage();
    const el = await page.$(sel);
    if (!el) { console.log(`${sel} 未找到`); return; }
    const size = await el.size();
    const off = await el.offset();
    console.log(`${sel} => top=${off.top} left=${off.left} ${size.width}x${size.height}`);
    console.log('class =', await el.attribute('class'));
    // 不 await：按住不放，中途截图
    const holdMs = Number(process.argv[4] || 220);
    const p = el.longpress();
    await new Promise(r => setTimeout(r, holdMs));
    console.log('按住态 class =', await el.attribute('class'));
    if (shot) {
      await mp.screenshot({ path: shot });
      console.log('按住态截图 ->', shot);
    }
    await p.catch(() => {});
    await new Promise(r => setTimeout(r, 350));
    if (shot) {
      const shot2 = shot.replace(/\.png$/, '_release.png');
      await mp.screenshot({ path: shot2 });
      console.log('松手后截图 ->', shot2);
    }
  } finally {
    await mp.disconnect().catch(() => {});
  }
}
main().catch(e => { console.error('ERR:', e.message); process.exit(1); });
