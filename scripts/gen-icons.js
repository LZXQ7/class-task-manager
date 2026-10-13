/**
 * SVG 图标生成器（设计系统 2.5：24×24 网格 / 2px 线性描边 / 圆角端点 / 无填充）
 * 产物：
 *   1. miniprogram/assets/icons/*.svg   —— 设计源文件（可上传云存储统一引用）
 *   2. miniprogram/utils/icons.js       —— cloud:// 引用 + base64 内联兜底
 * 用法：node scripts/gen-icons.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'miniprogram', 'assets', 'icons');
const ENV_ID = '<YOUR_ENV_ID>';
const BUCKET = '636c-<YOUR_ENV_ID>-1306168169';

// 图标主体（{C} 为颜色占位符）
const T = {
  home: '<path d="M3.5 10.5 12 4l8.5 6.5"/><path d="M5.5 9.5V19a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9.5"/><path d="M10 20v-5h4v5"/>',
  timetable: '<rect x="3.5" y="4.5" width="17" height="16" rx="2"/><path d="M3.5 9.5h17"/><path d="M8 2.5v4"/><path d="M16 2.5v4"/><path d="M9.2 9.5V20"/><path d="M14.8 9.5V20"/>',
  duty: '<rect x="5" y="4.5" width="14" height="16.5" rx="2"/><path d="M9 4.5V3h6v1.5"/><path d="M9 13.5l2.2 2.2L15.5 11"/>',
  mine: '<circle cx="12" cy="8" r="3.8"/><path d="M4.5 20c.6-3.6 3.7-5 7.5-5s6.9 1.4 7.5 5"/>',
  bell: '<path d="M6.5 16.5v-5.4a5.5 5.5 0 0 1 11 0v5.4l1.6 2.3H4.9z"/><path d="M10 21h4"/>',
  checkCircle: '<circle cx="12" cy="12" r="8.5"/><path d="M8.2 12.4l2.6 2.6 5-5.4"/>',
  check: '<path d="M4.5 12.5l5 5L19.5 7"/>',
  undo: '<path d="M3.5 4.5v6h6"/><path d="M5.2 15.5a8 8 0 1 0 1-8.7L3.5 10.5"/>',
  calendar: '<rect x="3.5" y="4.5" width="17" height="16" rx="2"/><path d="M3.5 9.5h17"/><path d="M8 2.5v4"/><path d="M16 2.5v4"/>',
  calendarCheck: '<rect x="3.5" y="4.5" width="17" height="16" rx="2"/><path d="M3.5 9.5h17"/><path d="M8 2.5v4"/><path d="M16 2.5v4"/><path d="M9 15.5l2 2 4-4.2"/>',
  people: '<circle cx="9" cy="8.5" r="3.5"/><path d="M2.8 19.5c.5-3.2 3.1-4.5 6.2-4.5s5.7 1.3 6.2 4.5"/><circle cx="16.8" cy="9.5" r="2.6"/><path d="M17.5 14.6c2.4.4 3.8 1.7 4.2 3.9"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  arrowRight: '<path d="M9 5.5 15.5 12 9 18.5"/>',
  arrowLeft: '<path d="M15 5.5 8.5 12 15 18.5"/>',
  chevronDown: '<path d="M6.5 9.5 12 15l5.5-5.5"/>',
  chevronUp: '<path d="M6.5 14.5 12 9l5.5 5.5"/>',
  settings: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.6v3"/><path d="M12 18.4v3"/><path d="M4.6 7.8l2.6 1.5"/><path d="M16.8 14.7l2.6 1.5"/><path d="M4.6 16.2l2.6-1.5"/><path d="M16.8 9.3l2.6-1.5"/>',
  logout: '<path d="M14.5 4.5H18a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5h-3.5"/><path d="M10 8.2 6.2 12 10 15.8"/><path d="M6.2 12H15"/>',
  download: '<path d="M12 3.8v10.6"/><path d="M8 10.6 12 14.6l4-4"/><path d="M4.5 18.5h15"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8.4 10.5V7.8a3.6 3.6 0 0 1 7.2 0v2.7"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.6-5.7"/><path d="M19.8 4.5v4.2h-4.2"/>',
  more: '<circle cx="12" cy="5.5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="18.5" r="1.4"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 5.5H6.5a2 2 0 0 0-2 2v9"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>',
  tag: '<path d="M11.2 3.8H5.5a1.7 1.7 0 0 0-1.7 1.7v5.7c0 .45.18.88.5 1.2l7.8 7.8a1.7 1.7 0 0 0 2.4 0l5.7-5.7a1.7 1.7 0 0 0 0-2.4l-7.8-7.8a1.7 1.7 0 0 0-1.2-.5z"/><circle cx="8.4" cy="8.4" r="1.4"/>',
  crown: '<path d="M3.5 8.5 7 12l5-6.5 5 6.5 3.5-3.5"/><path d="M5 12.5 6.5 19h11l1.5-6.5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M15.8 15.8 20.5 20.5"/>',
  close: '<path d="M6 6l12 12"/><path d="M18 6 6 18"/>',
  share: '<path d="M12 14.5V4"/><path d="M8.5 7 12 3.5 15.5 7"/><path d="M5 11.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-7.5"/>',
  mic: '<rect x="9" y="2.8" width="6" height="11.4" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5v3.7"/>',
  play: '<path d="M8 5.2v13.6L19 12z"/>',
  pause: '<path d="M9 5v14"/><path d="M15 5v14"/>',
  photo: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="8.6" cy="9.3" r="1.6"/><path d="M3.5 16.5 9 11.5l4.5 4 3-2.5 4 3.5"/>',
  photoPlus: '<rect x="3.5" y="7" width="14" height="13.5" rx="2"/><circle cx="7.8" cy="11.2" r="1.4"/><path d="M3.5 17.5 8 13.5l3.4 3 2.6-2 3.5 3"/><path d="M18 2.8v6"/><path d="M15 5.8h6"/>',
  scan: '<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8"/><path d="M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8"/><path d="M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16"/><path d="M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><path d="M3.5 12h17"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6.5 7 7.4 19a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7"/>',
  edit: '<path d="M14.5 5.5 18.5 9.5"/><path d="M5 19v-4L15.8 4.2a2.1 2.1 0 0 1 3 3L8 18z"/>',
  warn: '<path d="M12 4 21 19.5H3z"/><path d="M12 10v4"/><path d="M12 16.8v.2"/>',
  swap: '<path d="M7 8.5h13"/><path d="M17 5.5l3 3-3 3"/><path d="M17 15.5H4"/><path d="M7 12.5l-3 3 3 3"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3.2 2"/>',
  emptyBox: '<path d="M4 10 12 6l8 4-8 4z"/><path d="M4 10v7l8 4 8-4v-7"/><path d="M12 14v7"/>',
  cloudOff: '<path d="M7.5 18h9.3a3.7 3.7 0 0 0 .6-7.35A5.5 5.5 0 0 0 6.7 8.9"/><path d="M4 4l16 16"/>',
  searchEmpty: '<circle cx="11" cy="11" r="7"/><path d="M16.2 16.2 21 21"/><path d="M9 9l4 4"/><path d="M13 9l-4 4"/>',
  logo: '<rect x="5" y="9" width="38" height="30" rx="5"/><path d="M5 19h38"/><path d="M15 5v8"/><path d="M33 5v8"/><path d="M16 29l6 6 10-11"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><path d="M12 7.8v.2"/>'
};

// 各图标的颜色变体（key 用于文件名与 icons.js 索引）
const SPECS = [
  ['tab-home', { off: '#C9CDD4', on: '#3370FF' }, 'home'],
  ['tab-timetable', { off: '#C9CDD4', on: '#3370FF' }, 'timetable'],
  ['tab-duty', { off: '#C9CDD4', on: '#3370FF' }, 'duty'],
  ['tab-mine', { off: '#C9CDD4', on: '#3370FF' }, 'mine'],
  ['bell', { orange: '#FF7D00', brand: '#3370FF', gray: '#86909C' }, 'bell'],
  ['check-circle', { green: '#00B42A' }, 'checkCircle'],
  ['check', { white: '#FFFFFF', green: '#00B42A' }, 'check'],
  ['undo', { gray: '#4E5969' }, 'undo'],
  ['calendar', { brand: '#3370FF', gray: '#86909C' }, 'calendar'],
  ['calendar-check', { brand: '#3370FF', gray: '#86909C' }, 'calendarCheck'],
  ['people', { brand: '#3370FF', gray: '#86909C' }, 'people'],
  ['plus', { white: '#FFFFFF', brand: '#3370FF' }, 'plus'],
  ['arrow-right', { light: '#C9CDD4', gray: '#86909C' }, 'arrowRight'],
  ['arrow-left', { gray: '#4E5969', white: '#FFFFFF' }, 'arrowLeft'],
  ['chevron-down', { gray: '#86909C', brand: '#3370FF' }, 'chevronDown'],
  ['chevron-up', { gray: '#86909C' }, 'chevronUp'],
  ['settings', { gray: '#86909C', brand: '#3370FF' }, 'settings'],
  ['logout', { red: '#F53F3F', gray: '#86909C' }, 'logout'],
  ['download', { brand: '#3370FF', gray: '#86909C', white: '#FFFFFF' }, 'download'],
  ['lock', { brand: '#3370FF', gray: '#86909C' }, 'lock'],
  ['refresh', { gray: '#86909C', brand: '#3370FF' }, 'refresh'],
  ['more', { gray: '#86909C' }, 'more'],
  ['copy', { gray: '#86909C', brand: '#3370FF' }, 'copy'],
  ['grid', { gray: '#86909C', brand: '#3370FF' }, 'grid'],
  ['tag', { gray: '#86909C', brand: '#3370FF' }, 'tag'],
  ['crown', { orange: '#FF7D00' }, 'crown'],
  ['search', { gray: '#86909C' }, 'search'],
  ['close', { gray: '#86909C' }, 'close'],
  ['share', { brand: '#3370FF', gray: '#86909C', white: '#FFFFFF' }, 'share'],
  ['mic', { brand: '#3370FF', white: '#FFFFFF' }, 'mic'],
  ['play', { brand: '#3370FF', white: '#FFFFFF' }, 'play'],
  ['pause', { brand: '#3370FF', white: '#FFFFFF' }, 'pause'],
  ['photo', { gray: '#86909C' }, 'photo'],
  ['photo-plus', { gray: '#C9CDD4' }, 'photoPlus'],
  ['scan', { brand: '#3370FF', white: '#FFFFFF' }, 'scan'],
  ['trash', { red: '#F53F3F' }, 'trash'],
  ['edit', { gray: '#86909C', brand: '#3370FF' }, 'edit'],
  ['warn', { orange: '#FF7D00', red: '#F53F3F' }, 'warn'],
  ['swap', { brand: '#3370FF' }, 'swap'],
  ['clock', { orange: '#FF7D00' }, 'clock'],
  ['empty-box', { line: '#DDE1E8' }, 'emptyBox'],
  ['cloud-off', { line: '#DDE1E8' }, 'cloudOff'],
  ['search-empty', { line: '#DDE1E8' }, 'searchEmpty'],
  ['logo', { brand: '#3370FF' }, 'logo'],
  ['info', { brand: '#3370FF', red: '#F53F3F', orange: '#FF7D00' }, 'info']
];

function svgBody(inner, color, size, sw) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const UTIL_DIR = path.join(ROOT, 'miniprogram', 'utils');
fs.mkdirSync(UTIL_DIR, { recursive: true });
const ICONS = {};
for (const [name, colors, key] of SPECS) {
  const body = T[key];
  if (!body) throw new Error('missing body: ' + key);
  const isLogo = key === 'logo';
  ICONS[name] = {};
  for (const [ck, hex] of Object.entries(colors)) {
    const file = `${name}-${ck}.svg`;
    const content = svgBody(body, hex, isLogo ? 48 : 24, isLogo ? 2.6 : 2);
    fs.writeFileSync(path.join(OUT_DIR, file), content, 'utf8');
    const cloud = `cloud://${ENV_ID}.${BUCKET}/icons/${file}`;
    const data = 'data:image/svg+xml;base64,' + Buffer.from(content, 'utf8').toString('base64');
    ICONS[name][ck] = { cloud, data };
  }
}

// 生成 utils/icons.js
const js = `/**
 * 图标统一引用（由 scripts/gen-icons.js 生成，请勿手改）
 * - cloud: 云存储 cloud:// 文件 ID（统一引用，设计稿 SVG 源已上传 icons/ 目录）
 * - data:  base64 内联兜底（云存储不可达时自动降级，<app-icon> 组件处理）
 */
const ICONS = ${JSON.stringify(ICONS, null, 2)};

function get(name, variant) {
  const item = ICONS[name];
  if (!item) return null;
  const v = variant && item[variant] ? variant : Object.keys(item)[0];
  return item[v];
}

module.exports = { ICONS, get };
`;
fs.writeFileSync(path.join(ROOT, 'miniprogram', 'utils', 'icons.js'), js, 'utf8');

let count = 0;
Object.keys(ICONS).forEach(k => { count += Object.keys(ICONS[k]).length; });
console.log('generated', count, 'svg icons ->', OUT_DIR);
