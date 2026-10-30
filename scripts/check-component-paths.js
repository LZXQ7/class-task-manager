/**
 * 静态校验：usingComponents 组件路径是否真实存在
 * 历史坑（v0.7.19）：把 spring-scroll 组件包进 home/duty/mine 三页时，
 * 路径误写成 "../spring-scroll/index"（从 pages/<page>/ 出发会指向 pages/spring-scroll/），
 * 开发者工具报「模拟器启动失败：未找到组件」。
 * 正确相对路径应为 "../../components/spring-scroll/index"。
 */
const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..', 'miniprogram');
const problems = [];

function checkJson(jsonFile, sink) {
  const out = sink || problems;
  const dir = path.dirname(jsonFile);
  const raw = fs.readFileSync(jsonFile, 'utf8');
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    out.push(`${jsonFile}: JSON 解析失败`);
    return;
  }
  const comps = cfg.usingComponents || {};
  Object.entries(comps).forEach(([name, rel]) => {
    // 插件、绝对路径或自定义协议暂不处理
    if (!rel.startsWith('.')) return;
    const resolved = path.resolve(dir, rel);
    const missing = ['.json', '.js', '.wxml'].map((ext) => resolved + ext).filter((p) => !fs.existsSync(p));
    if (missing.length) {
      out.push(`${jsonFile}: 组件 "${name}": "${rel}" 路径解析失败（缺 ${missing.map((p) => path.basename(p)).join('/')}）`);
    }
  });
}

/**
 * ⚠️ 2026-10-28 补盲区：原实现只扫 pages/<一级>/index.json，
 * 三级页 pages/notice/publish/index.json **从未被检查** —— 它沿用了首页（二级）的
 * "../../components/..." 相对路径，少一层 ../，开发者工具直接编译失败
 * （Couldn't found the '../../components/app-icon/index.json'），而门禁却全绿。
 * 现在 pages 递归到底。
 */
function collectJsonFiles(dir, recursive) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => {
    if (!d.isDirectory()) return;
    const p = path.join(dir, d.name);
    const jf = path.join(p, 'index.json');
    if (fs.existsSync(jf)) out.push(jf);
    // 子目录里的子页面（pages/notice/publish/…）同样要扫
    if (recursive) out.push(...collectJsonFiles(p, true));
  });
  return out;
}

// 项目自有组件名（用于②：wxml 用了却没在 json 注册的校验）
const OWN_COMPONENTS = fs.existsSync(path.join(R, 'components'))
  ? fs.readdirSync(path.join(R, 'components'), { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name)
  : [];

/** ② wxml 里用了项目自有组件，却没在该页 json 注册 → 开发者工具静默不渲染/报错 */
function checkWxmlTags(jsonFile, sink) {
  const dir = path.dirname(jsonFile);
  const wxml = path.join(dir, 'index.wxml');
  if (!fs.existsSync(wxml)) return;
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(jsonFile, 'utf8')); } catch (e) { return; }
  const registered = Object.keys(cfg.usingComponents || {});
  const src = fs.readFileSync(wxml, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  OWN_COMPONENTS.forEach((name) => {
    if (registered.indexOf(name) >= 0) return;
    // 形如 <app-icon ...> 或 </app-icon>
    if (new RegExp('<' + name + '[\\s/>]').test(src)) {
      sink.push(`${jsonFile}: wxml 使用了 <${name}>，但 usingComponents 未注册（组件不会渲染）`);
    }
  });
}

['pages', 'components', 'custom-tab-bar'].forEach((base) => {
  collectJsonFiles(path.join(R, base), base === 'pages').forEach((jsonFile) => {
    checkJson(jsonFile);
    if (base === 'pages') checkWxmlTags(jsonFile, problems);
  });
});

/* 自证：坏路径必须被抓，好路径不得误报 */
{
  const tmpDir = path.join(__dirname, '..', '.workbuddy', 'check-component-paths-tmp');
  const goodDir = path.join(tmpDir, 'good');
  const badDir = path.join(tmpDir, 'bad');
  [goodDir, badDir].forEach((d) => {
    // 清目录只是善后：宿主给 fs.rmSync 套了「安全删除」垫片（走回收站二进制，
    // 超时抛 ETIMEDOUT），那是环境问题，不能让它判死门禁。
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {}
    fs.mkdirSync(d, { recursive: true });
  });

  // 好样本：pages/good/index.json 指向真实组件
  const realComp = path.join(tmpDir, 'real-comp');
  fs.mkdirSync(realComp, { recursive: true });
  ['index.json', 'index.js', 'index.wxml'].forEach((f) => fs.writeFileSync(path.join(realComp, f), '{}'));
  fs.writeFileSync(
    path.join(goodDir, 'index.json'),
    JSON.stringify({ usingComponents: { 'real-comp': '../real-comp/index' } })
  );

  // 坏样本：pages/bad/index.json 指向不存在的兄弟目录
  fs.writeFileSync(
    path.join(badDir, 'index.json'),
    JSON.stringify({ usingComponents: { 'fake-comp': '../fake-comp/index' } })
  );

  const goodErrs = [];
  checkJson(path.join(goodDir, 'index.json'), goodErrs);
  if (goodErrs.length) problems.push('check-component-paths 自证失败：合法路径被误报 → ' + goodErrs[0]);

  const badErrs = [];
  checkJson(path.join(badDir, 'index.json'), badErrs);
  if (!badErrs.length) problems.push('check-component-paths 自证失败：错误路径 ../fake-comp/index 未被捕获');

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
}

if (problems.length) {
  console.error('FAIL · 组件路径校验未通过');
  problems.forEach((p) => console.error('  - ' + p));
  process.exit(1);
}
console.log('OK · usingComponents 组件路径全部真实存在（含双向自证）');
