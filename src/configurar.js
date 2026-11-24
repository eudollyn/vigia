// Assistente de configuração do Vigia: uma página no navegador que explica como ele funciona, testa a chave da IA,
// o e-mail e as vozes, conecta o WhatsApp pelo QR code e grava o .env. Rode pelo CONFIGURAR.bat.
// Só aceita conexões deste PC (127.0.0.1) e exige uma chave aleatória em cada pedido.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { RAIZ, DADOS } from './config.js';

const PORTA = Number(process.env.CONFIGURAR_PORTA) || 8770;
const TOKEN = crypto.randomBytes(16).toString('hex');
const ENV = path.join(RAIZ, '.env');
const EXEMPLO = path.join(RAIZ, '.env.example');
const SESSAO = path.join(DADOS, 'whatsapp-sessao');
const PAGINA = new URL('./configurar.html', import.meta.url);
const SEGREDOS = ['EMAIL_SENHA', 'GEMINI_API_KEY', 'CLAUDE_API_KEY', 'ANTHROPIC_API_KEY'];

// ---------- .env ----------
function lerEnv() {
  const v = {};
  const arq = fs.existsSync(ENV) ? ENV : EXEMPLO;
  if (!fs.existsSync(arq)) return v;
  for (const linha of fs.readFileSync(arq, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(linha);
    if (!m) continue;
    const q = /^(["'])(.*)\1\s*(?:#.*)?$/.exec(m[2]);
    v[m[1]] = q ? q[2] : m[2].replace(/\s+#.*$/, '').trim();
  }
  return v;
}
const formatar = (v) => {
  v = String(v ?? '');
  if (!v) return '';
  if (/[#\s"'=;]/.test(v)) return v.includes('"') ? `'${v}'` : `"${v}"`;
  return v;
};
function gravarEnv(novos) {
  const base = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : fs.existsSync(EXEMPLO) ? fs.readFileSync(EXEMPLO, 'utf8') : '';
  if (fs.existsSync(ENV)) fs.copyFileSync(ENV, path.join(DADOS, 'env-anterior.txt')); // cópia de segurança (dados/ não vai para o Git)
  const usados = new Set();
  const linhas = base.replace(/^﻿/, '').split(/\r?\n/).map((l) => {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l);
    if (m && Object.hasOwn(novos, m[1])) { usados.add(m[1]); return `${m[1]}=${formatar(novos[m[1]])}`; }
    return l;
  });
  const extras = Object.keys(novos).filter((k) => !usados.has(k));
  if (extras.length) linhas.push('', '# ---------- Definido pelo assistente ----------', ...extras.map((k) => `${k}=${formatar(novos[k])}`));
  fs.writeFileSync(ENV, linhas.join('\r\n'));
}

// ---------- estado ----------
function vigiaRodando() {
  try { const pid = Number(fs.readFileSync(path.join(DADOS, 'vigia.pid'), 'utf8')); if (pid) { process.kill(pid, 0); return true; } } catch {}
  return false;
}
function whatsappSalvo() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(SESSAO, 'creds.json'), 'utf8'));
    if (c?.me?.id) return { nome: c.me.name || '', numero: '+' + String(c.me.id).split(/[:@]/)[0].replace(/\d(?=\d{4})/g, '•') };
  } catch {}
  return null;
}
function ipsLocais() {
  const ips = [];
  for (const lista of Object.values(os.networkInterfaces())) for (const a of lista || []) {
    if (a.family === 'IPv4' && !a.internal && /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) ips.push(a.address);
  }
  return ips;
}
function linkNotebook(porta) {
  const arq = path.join(DADOS, 'alto-falante-chave.txt');
  let chave = ''; try { chave = fs.readFileSync(arq, 'utf8').trim(); } catch {}
  if (!chave) { chave = crypto.randomBytes(9).toString('base64url'); fs.writeFileSync(arq, chave); }
  return { local: `http://localhost:${porta}/?k=${chave}`, rede: ipsLocais().map((ip) => `http://${ip}:${porta}/?k=${chave}`) };
}
const temFfmpeg = () => spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0;
function estado() {
  const v = lerEnv();
  const valores = { ...v };
  for (const s of SEGREDOS) { valores[s + '_DEFINIDA'] = Boolean(v[s]); delete valores[s]; }
  return {
    valores, envExiste: fs.existsSync(ENV), vigiaRodando: vigiaRodando(), whatsapp: whatsappSalvo(), ffmpeg: temFfmpeg(),
    node: process.version, pagina: linkNotebook(Number(v.ALTO_FALANTE_PORTA) || 8765), inicioWindows: tarefaExiste(),
  };
}
function tarefaExiste() {
  const r = spawnSync('schtasks.exe', ['/Query', '/TN', 'Vigia de Mensagens'], { windowsHide: true });
  return r.status === 0;
}

// ---------- testes ----------
async function testarGemini(chave) {
  chave = chave || lerEnv().GEMINI_API_KEY;
  if (!chave) return { ok: false, msg: 'Cole a chave primeiro.' };
  const modelo = lerEnv().GEMINI_MODELO || 'gemini-flash-lite-latest';
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelo)}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': chave },
      body: JSON.stringify({ contents: [{ parts: [{ text: 'Responda só com a palavra: funcionando' }] }] }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return { ok: true, msg: 'A chave funciona! A IA respondeu.' };
    const motivo = JSON.stringify(j);
    if (r.status === 400 && /API_KEY_INVALID|API key not valid/i.test(motivo)) return { ok: false, msg: 'Chave inválida. Confira se copiou ela inteira.' };
    if (r.status === 403) return { ok: false, msg: 'Chave sem permissão para o Gemini. Crie outra no Google AI Studio.' };
    if (r.status === 429) return { ok: true, msg: 'A chave é válida, mas a cota gratuita acabou por agora. Ela volta sozinha.' };
    if (r.status === 503) return { ok: true, msg: 'A chave é válida (o Google está sobrecarregado agora, tente depois).' };
    return { ok: false, msg: `O Google respondeu ${r.status}: ${j?.error?.message || 'erro desconhecido'}` };
  } catch (e) { return { ok: false, msg: `Sem resposta do Google (${e.message}). Confira a internet.` }; }
}
async function testarEmail({ usuario, senha, host, porta }) {
  senha = senha || lerEnv().EMAIL_SENHA;
  if (!usuario || !senha || !host) return { ok: false, msg: 'Preencha e-mail, senha e servidor.' };
  const { ImapFlow } = await import('imapflow');
  const c = new ImapFlow({ host, port: Number(porta) || 993, secure: Number(porta || 993) === 993, auth: { user: usuario, pass: senha }, logger: false, emitLogs: false, socketTimeout: 20000 });
  c.on('error', () => {});
  try {
    await Promise.race([c.connect(), new Promise((_, n) => setTimeout(() => n(new Error('tempo esgotado')), 20000))]);
    const caixa = await c.status('INBOX', { messages: true, unseen: true }).catch(() => null);
    await c.logout().catch(() => {});
    return { ok: true, msg: caixa ? `Conectou! A caixa de entrada tem ${caixa.messages} e-mails (${caixa.unseen} não lidos).` : 'Conectou!' };
  } catch (e) {
    const t = `${e.message} ${e.responseText || ''} ${e.code || ''}`;
    // ordem importa: servidor errado e tempo esgotado antes de senha (o nome do servidor pode conter "invalid")
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(t)) return { ok: false, msg: `Não achei o servidor "${host}". Confira o endereço IMAP.` };
    if (/tempo esgotado|timeout|ETIMEDOUT|ECONNREFUSED|ECONNRESET/i.test(t)) return { ok: false, msg: 'O servidor não respondeu. Confira o servidor e a porta (normalmente 993).' };
    if (/AUTHENTICATIONFAILED|auth|login|credential|password|senha|invalid/i.test(t)) return { ok: false, msg: 'O servidor recusou o login. Confira a senha (no Gmail e no Outlook use uma "senha de app").' };
    return { ok: false, msg: `Não conectou: ${e.message}` };
  } finally { try { c.close(); } catch {} }
}
async function gerarVoz({ texto, voz }) {
  const { vozMicrosoft } = await import('./voz-microsoft.js');
  return vozMicrosoft(String(texto || 'Olá!').slice(0, 300), /^[a-z]{2}-[A-Z]{2}-\w+Neural$/.test(voz || '') ? voz : 'pt-BR-FranciscaNeural');
}

// ---------- WhatsApp (QR code na página) ----------
let wa = { estado: 'parado', qr: null, nome: null, erro: null };
let waSock = null;
async function conectarWhats() {
  if (vigiaRodando()) { wa = { estado: 'erro', erro: 'O Vigia está ligado e já usa o WhatsApp. Feche o Vigia e tente de novo.' }; return; }
  const b = await import('@whiskeysockets/baileys');
  const makeWASocket = b.default;
  const { default: pino } = await import('pino');
  const QRCode = (await import('qrcode')).default;
  const { state, saveCreds } = await b.useMultiFileAuthState(SESSAO);
  let version; try { ({ version } = await b.fetchLatestBaileysVersion()); } catch {}
  const sock = makeWASocket({
    ...(version ? { version } : {}), auth: state, logger: pino({ level: 'silent' }), browser: b.Browsers.windows('Vigia'),
    markOnlineOnConnect: false, syncFullHistory: false,
    shouldSyncHistoryMessage: ({ syncType }) => syncType !== b.proto.HistorySync.HistorySyncType.FULL,
  });
  waSock = sock;
  if (wa.estado !== 'qr') wa = { estado: 'conectando' };
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (waSock !== sock) return;
    if (qr) wa = { estado: 'qr', qr: await QRCode.toDataURL(qr, { width: 360, margin: 1 }) };
    if (connection === 'open') {
      wa = { estado: 'conectado', nome: sock.user?.name || '' };
      // fica uns segundos conectado para receber os dados iniciais (contatos e identificadores) e solta
      setTimeout(() => { try { sock.end(undefined); } catch {} waSock = null; }, 25_000);
    }
    if (connection === 'close') {
      if (wa.estado === 'conectado') return;
      const codigo = lastDisconnect?.error?.output?.statusCode;
      if (codigo === b.DisconnectReason.loggedOut) {
        fs.rmSync(SESSAO, { recursive: true, force: true });
        wa = { estado: 'erro', erro: 'O celular encerrou a conexão. Clique em conectar de novo.' };
      } else conectarWhats().catch((e) => { wa = { estado: 'erro', erro: e.message }; }); // QR expirou ou reinício depois do pareamento
    }
  });
}

// ---------- servidor ----------
const json = (res, codigo, obj) => res.writeHead(codigo, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(obj));
const corpo = (req) => new Promise((ok) => { const p = []; let t = 0; req.on('data', (d) => { t += d.length; if (t < 200_000) p.push(d); }); req.on('end', () => { try { ok(JSON.parse(Buffer.concat(p).toString('utf8') || '{}')); } catch { ok({}); } }); });

const srv = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "frame-ancestors 'none'" }).end(fs.readFileSync(PAGINA));
    return;
  }
  if (!url.pathname.startsWith('/api/')) return res.writeHead(404).end();
  if (req.headers['x-token'] !== TOKEN) return json(res, 403, { erro: 'sem permissão' });
  try {
    const r = url.pathname;
    if (r === '/api/estado') return json(res, 200, estado());
    if (r === '/api/testar/gemini' && req.method === 'POST') return json(res, 200, await testarGemini((await corpo(req)).chave));
    if (r === '/api/testar/email' && req.method === 'POST') return json(res, 200, await testarEmail(await corpo(req)));
    if (r === '/api/voz' && req.method === 'POST') {
      try { const arq = await gerarVoz(await corpo(req)); res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' }); fs.createReadStream(arq).pipe(res); }
      catch (e) { json(res, 500, { erro: e.message }); }
      return;
    }
    if (r === '/api/salvar' && req.method === 'POST') {
      const { valores = {} } = await corpo(req);
      const limpos = {};
      for (const [k, v] of Object.entries(valores)) if (/^[A-Z][A-Z0-9_]*$/.test(k) && typeof v !== 'object') limpos[k] = String(v ?? '').replace(/[\r\n]/g, ' ');
      for (const s of SEGREDOS) if (s in limpos && !limpos[s]) delete limpos[s]; // segredo vazio = manter o atual
      gravarEnv(limpos);
      return json(res, 200, { ok: true });
    }
    if (r === '/api/whatsapp/conectar' && req.method === 'POST') { if (!waSock) conectarWhats().catch((e) => { wa = { estado: 'erro', erro: e.message }; }); return json(res, 200, { ok: true }); }
    if (r === '/api/whatsapp/estado') return json(res, 200, { ...wa, salvo: whatsappSalvo() });
    if (r === '/api/whatsapp/esquecer' && req.method === 'POST') {
      try { waSock?.end(undefined); } catch {} waSock = null; wa = { estado: 'parado' };
      if (vigiaRodando()) return json(res, 200, { ok: false, msg: 'Feche o Vigia antes de desconectar o WhatsApp.' });
      fs.rmSync(SESSAO, { recursive: true, force: true });
      return json(res, 200, { ok: true });
    }
    if (r === '/api/inicio-windows' && req.method === 'POST') {
      const { ligar } = await corpo(req);
      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(RAIZ, 'scripts', 'instalar-inicio.ps1'), ...(ligar ? [] : ['-Remover'])];
      const p = spawnSync('powershell.exe', args, { windowsHide: true });
      return json(res, 200, { ok: p.status === 0, ligado: tarefaExiste() });
    }
    if (r === '/api/iniciar' && req.method === 'POST') {
      if (vigiaRodando()) return json(res, 200, { ok: true, msg: 'O Vigia já está ligado.' });
      try { waSock?.end(undefined); } catch {} waSock = null;
      spawn('wscript.exe', [path.join(RAIZ, 'scripts', 'iniciar-oculto.vbs')], { cwd: RAIZ, detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return json(res, 200, { ok: true, msg: 'O Vigia está ligando. Em alguns segundos aparece a notificação "Vigia ligado".' });
    }
    if (r === '/api/sair' && req.method === 'POST') { json(res, 200, { ok: true }); setTimeout(() => process.exit(0), 300); return; }
    return json(res, 404, { erro: 'não existe' });
  } catch (e) { return json(res, 500, { erro: e.message }); }
});

srv.on('error', (e) => { console.error(`Não abri a porta ${PORTA}: ${e.message}. Já existe um assistente aberto?`); process.exit(1); });
srv.listen(PORTA, '127.0.0.1', () => {
  const link = `http://127.0.0.1:${PORTA}/#t=${TOKEN}`;
  console.log('\n  Assistente de configuração do Vigia');
  console.log(`  Abrindo no navegador: http://127.0.0.1:${PORTA}/`);
  console.log('  (se não abrir sozinho, copie o endereço completo abaixo)\n  ' + link + '\n');
  if (!process.argv.includes('--sem-navegador')) spawn('rundll32.exe', ['url.dll,FileProtocolHandler', link], { detached: true, stdio: 'ignore' }).unref();
});
