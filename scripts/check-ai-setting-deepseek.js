/**
 * 门禁：我的 → AI 排班设置弹层「仅 DeepSeek + 接入引导 + 密钥在模型上」（2026-11-21）
 *
 * 守什么：
 *  ① 入口仍受 canSchedule（有 AI 排班权限）控制，不能裸奔给所有人；
 *  ② 弹层内展示 DeepSeek 接入方式四步引导（开放平台/充值/API Keys/填入密钥）；
 *  ③ 仅 DeepSeek：不再有智谱 GLM / 通义千问预设，不再有接口地址输入框；
 *  ④ 顺序：密钥字段在模型字段之前（wxml 文本位置断言）；
 *  ⑤ 前端固定走 DeepSeek：save/test/models 都传 AI_DEFAULTS（baseUrl 空=官方默认），
 *     不再引用 aiBaseUrl / onAiPreset（防历史自定义地址残留）。
 *
 * 承重方式：真实源码静态断言 + 内存变异自证。
 * 跑法：node scripts/check-ai-setting-deepseek.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const FILES = {
  wxml: 'miniprogram/pages/mine/index.wxml',
  js: 'miniprogram/pages/mine/index.js',
  wxss: 'miniprogram/pages/mine/index.wxss'
};
const S = {};
for (const k of Object.keys(FILES)) S[k] = fs.readFileSync(path.join(ROOT, FILES[k]), 'utf8');

function has(s, x) { return String(s).indexOf(x) >= 0; }

function audit(X) {
  const bad = [];
  const need = (name, cond) => { if (!cond) bad.push(name); };
  const W = X.wxml, J = X.js, C = X.wxss;

  /* ① 权限入口：AI 排班设置行仍挂 wx:if=canSchedule */
  const aiRow = /wx:if="\{\{canSchedule\}\}"[^>]*bindtap="onMoreAi"/.exec(W);
  need('entryCanSchedule', !!aiRow);

  /* ② 接入方式引导四步 */
  need('guideBlock', has(W, 'class="an-guide"') && has(W, '如何获取密钥'));
  need('guidePlatform', has(W, 'platform.deepseek.com') && has(W, '注册并登录'));
  need('guideRecharge', has(W, '「充值」页充值'));
  need('guideApiKey', has(W, '「API Keys」') && has(W, '创建 API key'));
  need('guidePaste', has(W, '粘贴到下方「密钥」'));

  /* ③ 仅 DeepSeek：无多预设、无接口地址输入 */
  need('noGLM', !has(W, '智谱') && !has(J, 'glm-4-flash'));
  need('noQwen', !has(W, '千问') && !has(J, 'qwen-turbo'));
  need('noBaseUrlInput', !has(W, 'value="{{aiBaseUrl}}"') && !has(W, 'onAiBaseUrl'));
  need('noPresetChips', !has(W, 'onAiPreset') && !has(W, 'an-preset'));
  need('defaultsDeepSeek', has(J, "const AI_DEFAULTS = { provider: 'deepseek', baseUrl: '' };"));

  /* ④ 顺序：密钥 label 文本位置 < 模型 label 位置 */
  const keyLabel = W.indexOf('>密钥</text>');
  const modelLabel = W.indexOf('>模型（可留空=默认 deepseek-chat）</text>');
  need('keyBeforeModel', keyLabel > 0 && modelLabel > 0 && keyLabel < modelLabel);

  /* ⑤ 三处调用都用默认常量 */
  need('saveUsesDefault', /aiSettingSave\(p/.test(J) && (J.match(/baseUrl: AI_DEFAULTS\.baseUrl/g) || []).length >= 3);
  need('providerPinned', (J.match(/provider: AI_DEFAULTS\.provider/g) || []).length >= 2);
  need('noAiBaseUrl', !has(J, 'this.data.aiBaseUrl') && !has(J, 'aiBaseUrl:'));

  /* ⑥ 模型下拉：picker 承载、列表保留可重选、不再下方铺开、默认项保底 */
  need('modelIsPicker', has(W, 'mode="selector"') && has(W, 'range="{{aiModelOptions}}"') && has(W, 'bindchange="onPickModel"'));
  need('noInlineModelList', !has(W, 'wx:for="{{aiModels}}"') && !has(W, 'an-models-scroll'));
  need('pickByIndex', has(J, 'Number(e.detail.value)') && has(J, 'aiModelIndex: idx, aiModel: opts[idx]'));
  need('listKept', !/aiModel:\s*m,\s*aiModels:\s*\[\]/.test(J) && has(J, "aiModelOptions: ['deepseek-chat']"));
  need('optionsComputed', has(J, '_setModelOptions(models)') && has(J, "['deepseek-chat'].concat(list)"));
  need('pickerCss', has(C, '.an-model-picker {') && has(C, '.an-model-pick-arrow'));

  /* 样式：引导块有定义，且文字色走令牌（深色可读） */
  need('guideCss', has(C, '.an-guide {') && has(C, '.an-guide-tx') && has(C, 'color: var(--text-2)'));
  return bad;
}

const MUTANTS = [
  { key: 'entryCanSchedule', file: 'wxml', from: 'wx:if="{{canSchedule}}" class="mn-row" hover-class="tap-hover" hover-start-time="0" hover-stay-time="60" bindtap="onMoreAi"', to: 'class="mn-row" hover-class="tap-hover" hover-start-time="0" hover-stay-time="60" bindtap="onMoreAi"' },
  { key: 'guideBlock', file: 'wxml', from: 'class="an-guide"', to: 'class="an-guide-x"' },
  { key: 'guidePlatform', file: 'wxml', from: 'platform.deepseek.com', to: 'platform.example.com' },
  { key: 'defaultsDeepSeek', file: 'js', from: "const AI_DEFAULTS = { provider: 'deepseek', baseUrl: '' };", to: "const AI_DEFAULTS = { provider: 'glm', baseUrl: '' };" },
  { key: 'noGLM', file: 'js', from: "const AI_DEFAULTS = { provider: 'deepseek', baseUrl: '' };", to: "const AI_DEFAULTS = { provider: 'deepseek', baseUrl: '' };\nconst LEGACY = 'glm-4-flash';" },
  { key: 'noAiBaseUrl', file: 'js', from: 'baseUrl: AI_DEFAULTS.baseUrl,', to: 'baseUrl: this.data.aiBaseUrl,' },
  { key: 'modelIsPicker', file: 'wxml', from: 'range="{{aiModelOptions}}"', to: 'range="{{aiModels}}"' },
  { key: 'pickByIndex', file: 'js', from: 'aiModelIndex: idx, aiModel: opts[idx]', to: 'aiModelIndex: idx, aiModel: e.currentTarget.dataset.m' },
  { key: 'listKept', file: 'js', from: "aiModelOptions: ['deepseek-chat']", to: "aiModelOptions: ['glm-4-flash']" },
  { key: 'guideCss', file: 'wxss', from: '.an-guide {', to: '.an-guide-x {' }
];

(async function main() {
  const real = audit(S);
  if (real.length) {
    console.log('✗ 主线源码未通过：' + real.length + ' 项');
    real.forEach((k) => console.log('  ✗ ' + k));
    process.exit(1);
  }
  console.log('✓ 主线源码审计通过');

  let caught = 0;
  for (const mu of MUTANTS) {
    const src = S[mu.file];
    if (!has(src, mu.from)) {
      console.log('  ✗ 变异锚点失效（判据已漂移）: ' + mu.key);
      process.exit(1);
    }
    const X = Object.assign({}, S, { [mu.file]: src.split(mu.from).join(mu.to) });
    const bad = audit(X);
    if (!bad.length) {
      console.log('  ✗ 变异未被抓到: ' + mu.key + '（注入的坏样本未触发任何判据）');
      process.exit(1);
    }
    caught++;
    console.log('  ✓ 变异 ' + mu.key + ' → 抓到 ' + bad.slice(0, 3).join(','));
  }
  console.log('✓ 变异自证 ' + caught + '/' + MUTANTS.length + ' 全部抓到');
})().catch((e) => { console.error('门禁自身异常：', e && e.stack); process.exit(1); });
