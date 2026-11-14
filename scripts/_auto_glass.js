const path = require('path');
const automator = require(path.join(__dirname, 'wx-upload', 'node_modules', 'miniprogram-automator'));
const OUT = 'C:/Users/PC/WorkBuddy/LZXQ-WorkBuddy/.wb_tmp/shots';

async function main() {
  const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
  try {
    await mp.reLaunch('/pages/home/index');
    await new Promise(r => setTimeout(r, 3200));
    for (let i = 1; i <= 3; i++) {
      await mp.screenshot({ path: OUT + '/nav_g' + i + '.png' });
      await new Promise(r => setTimeout(r, 1200));
    }
    // 滚动，让内容穿过固定导航栏 ⇒ 玻璃显形
    await mp.callWxMethod('pageScrollTo', { scrollTop: 260, duration: 0 });
    await new Promise(r => setTimeout(r, 1200));
    for (let i = 1; i <= 2; i++) {
      await mp.screenshot({ path: OUT + '/nav_s' + i + '.png' });
      await new Promise(r => setTimeout(r, 1200));
    }
    console.log('静态 3 帧 + 滚动 2 帧已截');
  } finally {
    await mp.disconnect().catch(() => {});
  }
}
main().catch(e => { console.error('ERR:', e.message); process.exit(1); });
