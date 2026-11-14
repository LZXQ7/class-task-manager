/* 验证「搜索栏随滚动收窄成图标」：进页面 → 截图 → 滚动 → 再截图。
 * 用法：node scripts/_auto_search.js <pagePath> <prefix>
 */
const path = require('path');
const automator = require(path.join(__dirname, 'wx-upload', 'node_modules', 'miniprogram-automator'));
const WS = process.env.WXIDE_WS || 'ws://127.0.0.1:9420';

async function main() {
  const target = process.argv[2] || 'pages/roster/index';
  const prefix = process.argv[3] || 'C:/Users/PC/WorkBuddy/LZXQ-WorkBuddy/.wb_tmp/shots/search';
  const mp = await automator.connect({ wsEndpoint: WS });
  try {
    await mp.reLaunch('/' + target);
    await new Promise(r => setTimeout(r, 2600));
    const page = await mp.currentPage();
    console.log('page =', page.path);
    const bar = await page.$('.mb-bar');
    const search = await page.$('.mb-search');
    const input = await page.$('.mb-search-input');
    const m = async (el, name) => {
      if (!el) { console.log(name, '未找到'); return; }
      const s = await el.size(); const o = await el.offset();
      console.log(`${name} => top=${o.top} left=${o.left} ${s.width}x${s.height}`);
    };
    await m(bar, '展开 .mb-bar');
    await m(search, '展开 .mb-search');
    await m(input, '展开 .mb-search-input');
    await mp.screenshot({ path: prefix + '_expand.png' });

    await mp.pageScrollTo(400);
    await new Promise(r => setTimeout(r, 900));
    await m(bar, '折叠 .mb-bar');
    await m(search, '折叠 .mb-search');
    await m(input, '折叠 .mb-search-input');
    await mp.screenshot({ path: prefix + '_collapse.png' });
    console.log('截图完成');
  } finally {
    await mp.disconnect().catch(() => {});
  }
}
main().catch(e => { console.error('ERR:', e.message); process.exit(1); });
