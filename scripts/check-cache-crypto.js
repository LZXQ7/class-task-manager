#!/usr/bin/env node
/**
 * 离线自检：本地缓存加密（v1.0.8.76，2026-11-20）
 * --------------------------------------------------------------------------------
 * 用户口径：「敏感数据在本地保留要加密」。确认策略：
 *   ① 密钥服务端下发（auth.login 的 HMAC(secret,openid)），前端只存内存、不落 Storage
 *   ② 算法自带纯 JS AES-128-CTR（FIPS-197 标准向量校验），零依赖
 *   ③ Storage 只存密文 {n,c,t}；密钥缺失时跳过 Storage（宁可没缓存也不写明文）
 *   ④ 升级前的明文残留 {t,v} 读到即删，绝不复活成可用缓存
 *
 * 用法：node scripts/check-cache-crypto.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const CRYPTO = read('miniprogram/utils/cache-crypto.js');
const CACHE = read('miniprogram/utils/req-cache.js');
const AUTH = read('cloudfunctions/auth/index.js');
const APP = read('miniprogram/app.js');

let failed = 0;
function check(cond, msg) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) failed += 1;
}

/* 沙盒加载 cache-crypto（纯函数、无 wx 依赖） */
function loadCrypto(src) {
  const sb = { module: { exports: {} }, exports: {}, console: { error() {} },
    Math, parseInt, isNaN, unescape, escape, Uint8Array, String };
  vm.runInNewContext(src, sb, { filename: 'cache-crypto.js' });
  return sb.module.exports;
}
const C = loadCrypto(CRYPTO);

console.log('── ① AES 核心正确性（NIST/FIPS-197 标准向量）');
const key = C._fromHex('000102030405060708090a0b0c0d0e0f');
const pt = C._fromHex('00112233445566778899aabbccddeeff');
const ct = C._toHex(C._encryptBlock(pt, C._expandKey(key)));
check(ct === '69c4e0d86a7b0430d8cdb78070b4c55a', 'AES-128 单块向量匹配 FIPS-197');
const KEY = '0123456789abcdef0123456789abcdef';
const NONCE = '000000000000000000000000';
const enc = C.encrypt('班费余额 ¥123.45 · 示例成员01（姓名/学号敏感）', KEY, NONCE);
check(!!enc && typeof enc.nonce === 'string' && typeof enc.ct === 'string', 'encrypt 返回 {nonce, ct}');
check(C.decrypt(enc.nonce, enc.ct, KEY) === '班费余额 ¥123.45 · 示例成员01（姓名/学号敏感）', 'CTR 往返（含中文/金额/姓名）无损');
check(C.encrypt('x', KEY, NONCE).ct !== C.encrypt('x', KEY, '000000000000000000000001').ct,
  '不同 nonce 同明文密文不同（防重放/模式分析）');
check(C.decrypt(enc.nonce, enc.ct, 'ffffffffffffffffffffffffffffffff') === null
  || C.decrypt(enc.nonce, enc.ct, 'ffffffffffffffffffffffffffffffff') !== '班费余额 ¥123.45 · 示例成员01（姓名/学号敏感）',
  '错误密钥解不出原文');

console.log('\n── ② 服务端下发密钥');
check(/crypto\.createHmac\('sha256'/.test(AUTH) && /\.update\(String\(ctx\.openid/.test(AUTH),
  'auth.login 用 HMAC-SHA256(openid) 派生 cacheKey');
check(/CACHE_KEY_SECRET/.test(AUTH), 'HMAC secret 走环境变量 CACHE_KEY_SECRET（可配）');
check(/cacheKey\s*,/.test(AUTH), 'login 返回体带 cacheKey');
check(/digest\('hex'\)\.slice\(0,\s*32\)/.test(AUTH), '取前 32 hex = 16 bytes = AES-128 密钥长度');
check(/g\.cacheKey\s*=\s*\(r && r\.cacheKey\)/.test(APP), 'app.js 把 cacheKey 存 globalData（内存）');
check(!/setStorageSync\([^)]*cacheKey/i.test(APP), 'app.js 不把 cacheKey 写 Storage（锁和钥匙不放一起）');

console.log('\n── ③ Storage 只存密文 / 密钥缺失跳过 / 旧明文清除');
check(/require\('\.\/cache-crypto'\)/.test(CACHE) || /require\("\.\/cache-crypto"\)/.test(CACHE), 'req-cache 引入加密模块');
check(/const ck = cacheKeyOf\(\)/.test(CACHE), 'Storage 读写前取内存密钥');
check(/crypto\.encrypt\(plain, ck\)/.test(CACHE) && /wx\.setStorageSync\(key, \{ n: enc\.nonce, c: enc\.ct, t: rec\.t \}\)/.test(CACHE),
  '写入 Storage 的是密文 {n,c,t}，不是明文 rec');
check(/if \(!isCipher \|\| !ck \|\| !crypto\).*wx\.removeStorageSync\(key\)/.test(CACHE),
  '读到旧明文格式 {t,v} 或密钥缺失 ⇒ 删除并当未命中（不裸奔、不复活旧明文）');
check(/const plain = crypto\.decrypt\(raw\.n, raw\.c, ck\)/.test(CACHE), '读取时解密密文');
check(/if \(memSlot\) memSlot\[key\] = rec;.*\/\/ 回填内存/.test(CACHE), '明文只在内存回填，Storage 全程密文');

/* 真跑 req-cache：模拟 app.globalData 有/无 cacheKey 两种情形 */
function loadCacheSandbox(withKey) {
  const store = {};
  const sb = { module: { exports: {} }, exports: {}, console: { error() {} },
    Date, Number, String, Object, Array, JSON, isNaN, parseInt, unescape, escape, Math,
    require: (p) => {
      if (p === './cache-crypto') { const m = { exports: {} }; vm.runInNewContext(CRYPTO, sb, { filename: 'c.js' }); m.exports = sb.module.exports; return m.exports; }
      return null;
    },
    getApp: () => ({ globalData: { profile: { id: 1 }, viewClassId: 0, cacheKey: withKey ? KEY : '' } }),
    wx: {
      getStorageSync: k => (k in store ? store[k] : ''),
      setStorageSync: (k, v) => { store[k] = v; },
      removeStorageSync: k => { delete store[k]; },
      getStorageInfoSync: () => ({ keys: Object.keys(store) })
    }
  };
  vm.runInNewContext(CACHE, sb, { filename: 'req-cache.js' });
  return { api: sb.module.exports, store };
}

const withKey = loadCacheSandbox(true);
const k = withKey.api.makeKey('fee', 'getSummary', { type: 'class' });
withKey.api.write(k, { balance: '123.45', name: '示例成员01' });
const stored = withKey.store[k];
check(!!stored && typeof stored.n === 'string' && typeof stored.c === 'string'
  && JSON.stringify(stored).indexOf('示例成员01') < 0,
  'Storage 中无姓名明文（密文 + 裸元数据）');
const got = withKey.api.read(k, 120000);
check(got && got.name === '示例成员01' && got.balance === '123.45', '有密钥时能解密读回');

const noKey = loadCacheSandbox(false);
const k2 = noKey.api.makeKey('fee', 'getSummary', { type: 'class' });
noKey.api.write(k2, { name: '示例成员01' });
check(Object.keys(noKey.store).length === 0, '密钥缺失时不写 Storage（绝不落明文）');

/* 旧明文残留：直接塞一条 {t,v} 进 Storage，读时应删除且返回 null */
const legacy = loadCacheSandbox(true);
const lk = legacy.api.makeKey('fee', 'getSummary', { type: 'class' });
legacy.store[lk] = { t: Date.now(), v: { name: '旧明文' } };
check(legacy.api.read(lk, 120000) === null && Object.keys(legacy.store).length === 0,
  '升级前明文残留读到即删、不当缓存用');

console.log('\n── ④ 变异自证');
const MUTS = [
  { name: 'AES S-box 改坏（标准向量失配）', src: CRYPTO.replace('0x63,0x7c,0x77,0x7b', '0x00,0x7c,0x77,0x7b'),
    probe: (s) => { const cc = loadCrypto(s); const kk = cc._fromHex('000102030405060708090a0b0c0d0e0f'); const pp = cc._fromHex('00112233445566778899aabbccddeeff'); return cc._toHex(cc._encryptBlock(pp, cc._expandKey(kk))) === '69c4e0d86a7b0430d8cdb78070b4c55a'; } },
  { name: 'CTR 块序号不递增（多块密文错乱）', src: CRYPTO.replace('counter[15] = idx & 0xff;', 'counter[15] = 0;'),
    probe: (s) => { const cc = loadCrypto(s); const e = cc.encrypt('一段足够长的中文文本内容超过一个AES块的长度需要两个块才能装下', KEY, NONCE); return cc.decrypt(e.nonce, e.ct, KEY) === '一段足够长的中文文本内容超过一个AES块的长度需要两个块才能装下'; } },
  { name: 'Storage 写回明文 rec（不加密）', src: CACHE.replace("wx.setStorageSync(key, { n: enc.nonce, c: enc.ct, t: rec.t });", "wx.setStorageSync(key, rec);"),
    probe: (s) => /wx\.setStorageSync\(key, \{ n: enc\.nonce, c: enc\.ct/.test(s) },
  { name: '密钥缺失仍写 Storage', src: CACHE.replace('if (ck && crypto) {', 'if (true) {'),
    probe: (s) => /if \(ck && crypto\)/.test(s) }
];
MUTS.forEach((m) => {
  if (m.src === CRYPTO || m.src === CACHE) { check(false, '变异「' + m.name + '」锚点失配'); return; }
  check(m.probe(m.src) === false, '变异被抓：' + m.name);
});

console.log('\n' + (failed ? '✗ ' + failed + ' 项未通过' : '✓ 本地缓存加密检查全部通过'));
process.exit(failed ? 1 : 0);
