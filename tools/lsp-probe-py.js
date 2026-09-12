// /tmp/lsp-probe-py.js — 对 tools/*.py 发一次真实 LSP 会话，取回 documentSymbol 与 diagnostics
// 用法: node /tmp/lsp-probe-py.js tools/fetch-osm-lines.py
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const file = process.argv[2] || 'tools/fetch-osm-lines.py';
const abs = path.resolve(file);
const uri = 'file://' + abs;
const text = fs.readFileSync(abs, 'utf8');

const srv = spawn('basedpyright-langserver', ['--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = Buffer.alloc(0);
const diags = [];
let symbols = null;

function send(obj) {
  const s = JSON.stringify(obj);
  srv.stdin.write('Content-Length: ' + Buffer.byteLength(s) + '\r\n\r\n' + s);
}
srv.stderr.on('data', d => process.stderr.write('[server] ' + d));
srv.stdout.on('data', chunk => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const sep = buf.indexOf('\r\n\r\n');
    if (sep < 0) return;
    const head = buf.slice(0, sep).toString();
    const m = /Content-Length: (\d+)/i.exec(head);
    if (!m) return;
    const len = parseInt(m[1], 10);
    if (buf.length < sep + 4 + len) return;
    const body = buf.slice(sep + 4, sep + 4 + len).toString();
    buf = buf.slice(sep + 4 + len);
    let msg; try { msg = JSON.parse(body); } catch { continue; }
    if (msg.method === 'textDocument/publishDiagnostics') {
      diags.push({ version: msg.params.version, items: msg.params.diagnostics });
    }
    if (msg.id === 1 && msg.result) {
      send({ jsonrpc: '2.0', method: 'initialized', params: {} });
      send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'python', version: 1, text } } });
      send({ jsonrpc: '2.0', id: 2, method: 'textDocument/documentSymbol', params: { textDocument: { uri } } });
    }
    if (msg.id === 2 && msg.result) symbols = msg.result;
  }
});

send({
  jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    processId: process.pid, rootUri: 'file://' + process.cwd(), capabilities: {},
    workspaceFolders: [{ uri: 'file://' + process.cwd(), name: 'potato' }],
  },
});

setTimeout(() => {
  console.log('LSP file  : ' + file);
  console.log('documentSymbol : ' + (symbols ? symbols.length + ' 个符号' : '(未返回)'));
  if (symbols) {
    for (const s of symbols.slice(0, 6)) {
      const name = s.name || (s.selectionRange && '?');
      console.log('   · ' + s.kind + ' ' + name + ' @L' + (s.range ? s.range.start.line + 1 : '?'));
    }
  }
  console.log('publishDiagnostics 批次: ' + diags.length);
  const last = diags[diags.length - 1];
  if (last) {
    const errs = last.items.filter(d => d.severity === 1), warns = last.items.filter(d => d.severity === 2);
    console.log('诊断: error ' + errs.length + ' / warning ' + warns.length + '（共 ' + last.items.length + '）');
    for (const d of last.items.slice(0, 8)) {
      console.log('   ' + (d.severity === 1 ? 'ERROR' : 'WARN ') + ' L' + (d.range.start.line + 1) + ':' +
        (d.range.start.character + 1) + ' ' + d.message.split('\n')[0] + ' [' + d.code + ']');
    }
  }
  srv.kill();
  process.exit(0);
}, 25000);
