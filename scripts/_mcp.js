/* 直连微信开发者工具的 MCP HTTP 端点（绕过 wechatide CLI 的 USERPROFILE 解析 bug）。
 * 用法：
 *   node scripts/_mcp.js list
 *   node scripts/_mcp.js call <toolName> [jsonArgs]
 */
const path = require('path');
const fs = require('fs');

/* IDE 的 MCP 服务端口写在 <User Data>\<hash>\Default\.ide —— 每次重启都会变，
   所以每次都重新读，别写死。 */
function idePort() {
  if (process.env.WXIDE_PORT) return process.env.WXIDE_PORT;
  const base = 'C:/Users/PC/AppData/Local/微信开发者工具/User Data';
  try {
    for (const d of fs.readdirSync(base)) {
      const f = path.join(base, d, 'Default', '.ide');
      if (fs.existsSync(f)) {
        const p = String(fs.readFileSync(f, 'utf8')).trim();
        if (/^\d+$/.test(p)) return p;
      }
    }
  } catch (e) { /* ignore */ }
  return '38064';
}

const PORT = idePort();
const TOKEN = process.env.WXIDE_TOKEN || 'nmkEq4RWyOooHmCXvAP8pKACPWZRcGWt';
const BASE = `http://127.0.0.1:${PORT}/mcp`;

let sessionId = null;
let idSeq = 0;

function headers(extra) {
  const h = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream'
  };
  if (sessionId) h['mcp-session-id'] = sessionId;
  if (TOKEN) h.Authorization = 'Bearer ' + TOKEN;
  return Object.assign(h, extra || {});
}

function parseSSE(text) {
  let out = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) {
      const raw = line.slice(6);
      try { out = JSON.parse(raw); } catch (e) { out = { raw }; }
    }
  }
  if (out) return out;
  try { return JSON.parse(text); } catch (e) { return { raw: text.slice(0, 500) }; }
}

async function rpc(method, params, extraHeaders) {
  const id = ++idSeq;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), Number(process.env.WXIDE_TIMEOUT || 45000));
  let res;
  try {
    res = await fetch(BASE, {
      method: 'POST',
      headers: headers(extraHeaders),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }),
      signal: ctrl.signal
    });
  } catch (e) {
    throw new Error('请求超时或中断: ' + e.message);
  } finally { clearTimeout(to); }
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  const body = parseSSE(await res.text());
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(body).slice(0, 600)}`);
  }
  return body;
}

async function closeSession() {
  if (!sessionId) return;
  try {
    await fetch(BASE, { method: 'DELETE', headers: headers() });
  } catch (e) { /* 忽略 */ }
}

async function main() {
  const cmd = process.argv[2] || 'list';
  const init = await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'CodeBuddy', version: '1.0.0' }
  });
  if (init.error) { console.log('INIT ERROR:', JSON.stringify(init).slice(0, 800)); process.exit(1); }
  const server = init.result && init.result.serverInfo;
  console.log('[connected]', JSON.stringify(server || {}), 'session=', sessionId || '(none)');

  // notifications/initialized (无 id，忽略响应)
  await fetch(BASE, {
    method: 'POST',
    headers: headers({ 'x-wechatide-mcp-entry': 'skill-call' }),
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    signal: AbortSignal.timeout(8000)
  }).catch(() => {});

  try {
    await run(cmd);
  } finally {
    await closeSession();
  }
}

async function run(cmd) {

  if (cmd === 'list') {
    const r = await rpc('tools/list', {});
    const tools = (r.result && r.result.tools) || [];
    console.log('=== TOOLS (' + tools.length + ') ===');
    for (const t of tools) {
      console.log('- ' + t.name);
      const props = (t.inputSchema && t.inputSchema.properties) || {};
      const req = (t.inputSchema && t.inputSchema.required) || [];
      const sig = Object.keys(props).map(k => k + (req.includes(k) ? '*' : '') + ':' + (props[k].type || '?')).join('  ');
      if (sig) console.log('    ' + sig);
    }
    return;
  }

  if (cmd === 'call') {
    const name = process.argv[3];
    const args = process.argv[4] ? JSON.parse(process.argv[4]) : {};
    const r = await rpc('tools/call', { name, arguments: args }, { 'x-wechatide-requested-tool': name });
    if (r.error) { console.log('CALL ERROR:', JSON.stringify(r.error).slice(0, 1200)); process.exit(1); }
    const res = r.result || {};
    if (Array.isArray(res.content)) {
      for (const c of res.content) {
        if (c.type === 'text') console.log(c.text);
        else if (c.type === 'image') console.log('[image]', (c.mimeType || '') + ' ' + (c.data || '').slice(0, 60) + '...');
        else console.log('[' + c.type + ']', JSON.stringify(c).slice(0, 800));
      }
    } else {
      console.log(JSON.stringify(res, null, 2).slice(0, 20000));
    }
    if (res.isError) process.exit(2);
    return;
  }
  console.log('unknown cmd');
}

main().catch(e => { console.error('ERR:', e.message); process.exit(1); });
