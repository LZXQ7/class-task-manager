const path = require('path');
const automator = require(path.join(__dirname, 'wx-upload', 'node_modules', 'miniprogram-automator'));
const OUT = 'C:/Users/PC/WorkBuddy/LZXQ-WorkBuddy/.wb_tmp/shots';

async function main() {
  const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
  try {
    await mp.reLaunch('/pages/roster/index');
    await new Promise(r => setTimeout(r, 3500));
    const page = await mp.currentPage();

    // ⑧ 成员详情（悬浮卡片）
    const row = await page.$('.mb-row');
    if (!row) { console.log('!! 找不到 .mb-row'); }
    else {
      await row.tap();
      await new Promise(r => setTimeout(r, 900));
      await mp.screenshot({ path: OUT + '/r_detail.png' });
      console.log('详情卡截图 -> r_detail.png');

      // 3D 翻转：点 .fd
      const fd = await page.$('.fd');
      if (!fd) console.log('!! 找不到 .fd');
      else {
        await fd.tap();
        await new Promise(r => setTimeout(r, 700));
        await mp.screenshot({ path: OUT + '/r_flip.png' });
        console.log('翻转后截图 -> r_flip.png');
        const cls = await page.data('mDetailFlipped');
        console.log('mDetailFlipped =', cls);
      }
      // 关闭
      await mp.screenshot({ path: OUT + '/r_before_close.png' });
    }

    // ⑨ 长按确认：请假撤销按钮
    const cancel = await page.$('.lv-cancel');
    if (!cancel) console.log('!! 找不到 .lv-cancel（今天可能没人请假）');
    else {
      const p = cancel.longpress();
      await new Promise(r => setTimeout(r, 320));
      await mp.screenshot({ path: OUT + '/r_hold.png' });
      console.log('长按中截图 -> r_hold.png');
      await p.catch(() => {});
    }
  } finally {
    await mp.disconnect().catch(() => {});
  }
}
main().catch(e => { console.error('ERR:', e.message); process.exit(1); });
