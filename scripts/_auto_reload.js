/* 重新编译并刷新当前页 + 截图（真机验收用）。
 * 用法：node scripts/_auto_reload.js <shotPath>
 */
const path = require('path');
const automator = require(path.join(__dirname, 'wx-upload', 'node_modules', 'miniprogram-automator'));
const WS = process.env.WXIDE_WS || 'ws://127.0.0.1:9420';

async function main() {
  const shot = process.argv[2];
  const target = process.argv[3] || 'pages/home/index';
  const mp = await automator.connect({ wsEndpoint: WS });
  try {
    await mp.reLaunch('/' + target);
    await new Promise(r => setTimeout(r, 2500));
    const page = await mp.currentPage();
    console.log('page =', page && page.path);
    if (shot) {
      await mp.screenshot({ path: shot });
      console.log('saved ->', shot);
    }
  } finally {
    await mp.disconnect().catch(() => {});
  }
}
main().catch(e => { console.error('ERR:', e.message); process.exit(1); });
