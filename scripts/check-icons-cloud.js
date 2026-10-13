/**
 * 校验：utils/icons.js 中登记的 cloud:// 路径，是否与云存储 icons/ 目录实际文件一一对应
 * 依赖：scripts/.icons-storage-list.txt（由 queryStorage list 结果写入，每行一个 Key）
 */
const fs = require('fs');
const path = require('path');
const icons = require(path.join(__dirname, '..', 'miniprogram', 'utils/icons.js'));

const local = new Set();
Object.keys(icons.ICONS).forEach((k) => {
  Object.keys(icons.ICONS[k]).forEach((v) => {
    const c = icons.ICONS[k][v].cloud;
    if (c) local.add(c.replace(/^cloud:\/\/[^/]+\//, ''));
  });
});

const listFile = path.join(__dirname, '.icons-storage-list.txt');
if (!fs.existsSync(listFile)) {
  console.log('云端清单文件不存在: scripts/.icons-storage-list.txt');
  console.log('本地登记路径数:', local.size);
  process.exit(0);
}
const remote = new Set(fs.readFileSync(listFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean));

const missing = [...local].filter((p) => !remote.has(p));
const extra = [...remote].filter((p) => !local.has(p));
console.log('本地登记:', local.size, '| 云端实际:', remote.size);
console.log('云端缺失:', missing.length ? missing : 'none');
console.log('云端多余:', extra.length ? extra : 'none');
