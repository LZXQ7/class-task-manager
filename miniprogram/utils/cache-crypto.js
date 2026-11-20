/**
 * 本地缓存加密（v1.0.8.76）：纯 JS AES-128-CTR，**零第三方依赖**（不构建 npm、不增包体）。
 * --------------------------------------------------------------------------------
 * 为什么 CTR：
 *   · 流式、无需 padding，密文长度 = 明文长度（便于 Storage 容量估算）；
 *   · 加解密同一函数（XOR keystream），代码量最小，出错面最小；
 *   · nonce 每次随机、随密文一起存，同一明文两次加密结果不同。
 *
 * 密钥来源：**auth.login 下发的 cacheKey**（HMAC(服务端 secret, openid) 前 16 字节 hex），
 *   前端只存内存（app.globalData.cacheKey），绝不落 Storage。密钥拿不到时调用方跳过 Storage，
 *   不影响功能（只是失去跨重启缓存）。
 *
 * ⚠️ 安全边界（如实说明）：这是「防直接翻 Storage 看明文」级别的保护。若攻击者能同时
 *    逆向小程序包并控制用户设备，仍可从内存/网络取到密钥——前端加密的固有限制，不是实现缺陷。
 *    真正的密钥保密靠服务端 HMAC secret 不下发。
 *
 * ⚠️ 本文件必须是纯函数、无 wx / getApp 依赖 —— 门禁在 vm 沙盒里直接 new Function 加载它做测试向量。
 */

/* AES S-box（256 字节，标准表） */
const S = [
  0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
  0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
  0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
  0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
  0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
  0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
  0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
  0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
  0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
  0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
  0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
  0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
  0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
  0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
  0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
  0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16
];

/* AES 逆 S-box（解密不需要 CTR，但导出给测试向量校验 AES 核心用不到，省略） */
const RCON = [0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36];

function xtime(a) {
  return ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;
}

/** AES-128 密钥扩展：16 bytes → 11 个 round key（176 bytes） */
function expandKey(key) {
  const w = new Uint8Array(176);
  w.set(key, 0);
  let bytes = 16;
  let rcon = 0;
  const t = new Uint8Array(4);
  while (bytes < 176) {
    for (let i = 0; i < 4; i += 1) t[i] = w[bytes - 4 + i];
    if (bytes % 16 === 0) {
      const tmp = t[0];
      t[0] = (S[t[1]] ^ RCON[rcon]) & 0xff;
      t[1] = S[t[2]];
      t[2] = S[t[3]];
      t[3] = S[tmp];
      rcon += 1;
    }
    for (let i = 0; i < 4; i += 1) {
      w[bytes] = (w[bytes - 16] ^ t[i]) & 0xff;
      bytes += 1;
    }
  }
  return w;
}

/** AES-128 单块加密（16 bytes → 16 bytes），标准 10 轮 */
function encryptBlock(block, w) {
  const s = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) s[i] = block[i] ^ w[i];  // AddRoundKey 0

  for (let round = 1; round <= 10; round += 1) {
    /* SubBytes */
    for (let i = 0; i < 16; i += 1) s[i] = S[s[i]];
    /* ShiftRows：状态按列存 s[r + 4c]，行 r 左移 r 列 */
    let t = s[1]; s[1] = s[5]; s[5] = s[9]; s[9] = s[13]; s[13] = t;
    t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t;
    t = s[15]; s[15] = s[11]; s[11] = s[7]; s[7] = s[3]; s[3] = t;
    /* MixColumns（最后一轮不做） */
    if (round !== 10) {
      for (let c = 0; c < 4; c += 1) {
        const i = c * 4;
        const a0 = s[i], a1 = s[i+1], a2 = s[i+2], a3 = s[i+3];
        const all = a0 ^ a1 ^ a2 ^ a3;
        s[i]   = (a0 ^ all ^ xtime(a0 ^ a1)) & 0xff;
        s[i+1] = (a1 ^ all ^ xtime(a1 ^ a2)) & 0xff;
        s[i+2] = (a2 ^ all ^ xtime(a2 ^ a3)) & 0xff;
        s[i+3] = (a3 ^ all ^ xtime(a3 ^ a0)) & 0xff;
      }
    }
    /* AddRoundKey */
    for (let i = 0; i < 16; i += 1) s[i] = (s[i] ^ w[round * 16 + i]) & 0xff;
  }
  return s;
}

/** hex → Uint8Array；非法/长度不对返回 null */
function keyBytes(hex) {
  if (typeof hex !== 'string' || hex.length !== 32 || !/^[0-9a-fA-F]{32}$/.test(hex)) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Uint8Array ↔ 二进制字符串（Storage 只能存可序列化值，这里存 hex 更简单可靠） */
function toHex(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 1) s += ('0' + u8[i].toString(16)).slice(-2);
  return s;
}
function fromHex(hex) {
  if (typeof hex !== 'string' || hex.length % 2) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const b = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (isNaN(b)) return null;
    out[i] = b;
  }
  return out;
}

/**
 * 对外 API：
 *   encrypt(plainText, keyHex, nonceHex) → { nonce, ct }（均为 hex）
 *   decrypt(nonceHex, ctHex, keyHex)     → plainText（UTF-8）
 * 采用 UTF-8 编解码：小程序环境有 TextEncoder/TextDecoder；沙盒无则退化用 encodeURIComponent 方案。
 */
function utf8Encode(str) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
  // 退化：用 encodeURIComponent + unescape 生成 Latin1 字节
  const s = unescape(encodeURIComponent(str));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}
function utf8Decode(u8) {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(u8);
  let s = '';
  for (let i = 0; i < u8.length; i += 1) s += String.fromCharCode(u8[i]);
  return decodeURIComponent(escape(s));
}

/** 生成 12 字节随机 nonce 的 hex（24 字符）；无 wx.getRandomValues 时用 Math.random 兜底 */
function randomNonceHex() {
  const n = new Uint8Array(12);
  const cryptoObj = (typeof wx !== 'undefined' && wx && wx.getRandomValues)
    ? wx
    : ((typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto : null);
  if (cryptoObj && cryptoObj.getRandomValues) cryptoObj.getRandomValues(n);
  else for (let i = 0; i < 12; i += 1) n[i] = Math.floor(Math.random() * 256);
  return toHex(n);
}

/** 加密：明文字符串 → { nonce, ct } */
function encrypt(text, keyHex, nonceHex) {
  const key = keyBytes(keyHex);
  const plain = utf8Encode(String(text));
  if (!key) return null;
  const nonce = nonceHex && /^[0-9a-fA-F]{24}$/.test(nonceHex) ? nonceHex : randomNonceHex();
  const nb = fromHex(nonce);
  const w = expandKey(key);
  const out = new Uint8Array(plain.length);
  const counter = new Uint8Array(16);
  counter.set(nb, 0);
  for (let off = 0; off < plain.length; off += 16) {
    /* 4 字节块序号（大端）写进 counter[12..15] */
    const idx = off / 16;
    counter[12] = (idx >>> 24) & 0xff;
    counter[13] = (idx >>> 16) & 0xff;
    counter[14] = (idx >>> 8) & 0xff;
    counter[15] = idx & 0xff;
    const ks = encryptBlock(counter, w);
    const n = Math.min(16, plain.length - off);
    for (let i = 0; i < n; i += 1) out[off + i] = plain[off + i] ^ ks[i];
  }
  return { nonce, ct: toHex(out) };
}

/** 解密：nonce + 密文 hex → 明文字符串；失败返回 null */
function decrypt(nonceHex, ctHex, keyHex) {
  const key = keyBytes(keyHex);
  const nb = fromHex(nonceHex);
  const ct = fromHex(ctHex);
  if (!key || !nb || nb.length !== 12 || !ct) return null;
  const w = expandKey(key);
  const out = new Uint8Array(ct.length);
  const counter = new Uint8Array(16);
  counter.set(nb, 0);
  for (let off = 0; off < ct.length; off += 16) {
    const idx = off / 16;
    counter[12] = (idx >>> 24) & 0xff;
    counter[13] = (idx >>> 16) & 0xff;
    counter[14] = (idx >>> 8) & 0xff;
    counter[15] = idx & 0xff;
    const ks = encryptBlock(counter, w);
    const n = Math.min(16, ct.length - off);
    for (let i = 0; i < n; i += 1) out[off + i] = ct[off + i] ^ ks[i];
  }
  try { return utf8Decode(out); } catch (e) { return null; }
}

module.exports = {
  encrypt, decrypt, randomNonceHex, keyBytes,
  /* 导出底层供门禁用标准测试向量校验 AES 核心正确性 */
  _expandKey: expandKey, _encryptBlock: encryptBlock, _toHex: toHex, _fromHex: fromHex
};
