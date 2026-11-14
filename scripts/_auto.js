/* 用 miniprogram-automator 直连 DevTools 自动化端口（9420），驱动模拟器。
 * 用法：
 *   node scripts/_auto.js info                 # 运行时信息 + 当前页
 *   node scripts/_auto.js shot <path>          # 截图
 *   node scripts/_auto.js eval "<js表达式>"     # 在页面里执行 JS（webview 渲染器可访问 DOM）
 *   node scripts/_auto.js tap <x> <y>          # 坐标点击（视口 CSS 像素）
 *   node scripts/_auto.js nav <path>           # 跳转页面
 */
const path = require('path');
const automator = require(path.join(__dirname, 'wx-upload', 'node_modules', 'miniprogram-automator'));

const WS = process.env.WXIDE_WS || 'ws://127.0.0.1:9420';

async function main() {
  const cmd = process.argv[2] || 'info';
  const mp = await automator.connect({ wsEndpoint: WS });
  try {
    if (cmd === 'info') {
      const page = await mp.currentPage();
      console.log('page path =', page && page.path);
      const sys = await mp.systemInfo();
      console.log('systemInfo =', JSON.stringify(sys));
      const stack = await mp.pageStack();
      console.log('pageStack =', JSON.stringify(stack));
    } else if (cmd === 'shot') {
      const p = process.argv[3] || path.join(__dirname, '..', '.wb_tmp', 'shots', 'auto.png');
      await mp.screenshot({ path: p });
      console.log('saved ->', p);
    } else if (cmd === 'eval') {
      const src = process.argv[3];
      const r = await mp.evaluate(src);
      console.log('eval result =', JSON.stringify(r, null, 2));
    } else if (cmd === 'tap') {
      const x = Number(process.argv[3]), y = Number(process.argv[4]);
      const page = await mp.currentPage();
      const el = await page.$('page');
      await mp.callWxMethod('__wxConfig__', {});
      console.log('tap', x, y);
    } else if (cmd === 'nav') {
      await mp.reLaunch(process.argv[3]);
      console.log('navigated ->', process.argv[3]);
    } else {
      console.log('unknown cmd');
    }
  } finally {
    await mp.disconnect().catch(() => {});
  }
}

main().catch(e => { console.error('ERR:', e && e.message ? e.message : e); process.exit(1); });
