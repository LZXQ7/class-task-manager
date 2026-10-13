/**
 * 端到端接口校验：页面 api.xxx( → utils/api.js → 云函数 routes[action]
 * 防止前端调了不存在的 action，或云函数缺少对应路由
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const MP = path.join(ROOT, 'miniprogram');
const CF = path.join(ROOT, 'cloudfunctions');

const apiSrc = fs.readFileSync(path.join(MP, 'utils/api.js'), 'utf8');
const apiKeys = new Set();
let m;
const reApi = /^\s{2}([A-Za-z_$][\w$]*)\s*:\s*C\(/gm;
while ((m = reApi.exec(apiSrc))) apiKeys.add(m[1]);

// 页面用到的 api.xxx
const used = new Map();
function walk(d) {
  fs.readdirSync(d).forEach((n) => {
    const p = path.join(d, n);
    if (fs.statSync(p).isDirectory()) return walk(p);
    if (!/\.(js|wxml)$/.test(n)) return;
    const t = fs.readFileSync(p, 'utf8');
    const re = /\bapi\.([A-Za-z_$][\w$]*)\s*\(/g;
    let r;
    while ((r = re.exec(t))) {
      if (!used.has(r[1])) used.set(r[1], p);
    }
  });
}
walk(MP);

const missApi = [...used.keys()].filter((k) => !apiKeys.has(k));
console.log('api.js 暴露:', apiKeys.size, '| 页面调用:', used.size);
console.log('缺少 api 封装:', missApi.length ? missApi.map((k) => k + ' @ ' + used.get(k)) : 'none');

// api.js → 云函数 action
const pairs = [];
const reC = /^\s{2}([A-Za-z_$][\w$]*)\s*:\s*C\(\s*'([^']+)'\s*,\s*'([^']+)'/gm;
while ((m = reC.exec(apiSrc))) pairs.push({ fn: m[2], action: m[3], key: m[1] });

const missing = [];
pairs.forEach(({ fn, action, key }) => {
  const file = path.join(CF, fn, 'index.js');
  if (!fs.existsSync(file)) { missing.push(`云函数不存在: ${fn} (api.${key})`); return; }
  const s = fs.readFileSync(file, 'utf8');
  if (s.indexOf("'" + action + "'") < 0 && s.indexOf(action + ':') < 0 && s.indexOf('"' + action + '"') < 0) {
    missing.push(`路由缺失: ${fn}.${action} (api.${key})`);
  }
});
console.log('api → 云函数映射:', pairs.length);
console.log('映射问题:', missing.length ? missing : 'none');
