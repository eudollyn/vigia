// Alto-falante e microfone pela rede: o notebook abre uma página no navegador,
// toca as falas do Vigia e, quando o Vigia pede, grava a sua voz e manda de volta.
// Sem instalar nada no notebook. Protegido por uma chave na URL (só quem tem o link acessa).
import http from 'node:http';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, DADOS } from './config.js';
import { log, verificarCancelado, cancelarTudo, Cancelado } from './avisos.js';

const ARQ_CHAVE = path.join(DADOS, 'alto-falante-chave.txt');
let chave;
try { chave = fs.readFileSync(ARQ_CHAVE, 'utf8').trim(); } catch {}
if (!chave) { chave = crypto.randomBytes(9).toString('base64url'); fs.writeFileSync(ARQ_CHAVE, chave); }

const clientes = [];                 // { res, mic } conexões abertas (páginas de notebook), a última é a mais nova
const audios = new Map();            // id → caminho do WAV
const esperando = new Map();         // id → resolve (fim de reprodução / fala recebida)

export const conectado = () => clientes.length > 0;
const ouvintesComando = [], ouvintesConexao = [];
/** fn(comando, textoOuvido) para "ate-amanha", "cancela", "responda" ditos no notebook */
export const aoComando = (fn) => ouvintesComando.push(fn);
/** fn() quando um notebook conecta na página */
export const aoConectar = (fn) => ouvintesConexao.push(fn);
/** Mostra um aviso na lista da página (sem conteúdo para contatos privados). */
export function mostrarAviso(a) {
  const dados = JSON.stringify(a);
  for (const c of clientes) c.res.write(`event: aviso\ndata: ${dados}\n\n`);
}
/** Há um notebook conectado com microfone liberado? */
export const temMic = () => clientes.some((c) => c.mic);

/** Link da página no PRÓPRIO PC (localhost: o navegador libera o microfone sem configurar nada). */
export const linkLocal = () => `http://localhost:${config.altoFalantePorta}/?k=${chave}`;
/** Links para abrir a página em OUTRO aparelho da mesma rede (notebook, tablet…). */
export function enderecos() {
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  return ips.map((ip) => `http://${ip}:${config.altoFalantePorta}/?k=${chave}`);
}

/** "Cancelar": manda o notebook parar (fala, escuta, gravação) e solta quem estava esperando. */
export function pararTudo() {
  for (const c of clientes) { try { c.res.write('event: parar\ndata: 1\n\n'); } catch {} }
  for (const fim of [...esperando.values()]) { try { fim(null); } catch {} }
}
const PEDIU_CANCELAR = /\bcancel(a|ar|e|ou|em)\b/;
const semAcentoAF = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Manda o WAV para o(s) notebook(s) e espera terminar de tocar. Devolve false se ninguém estiver conectado. */
export function tocarRemoto(arq) {
  if (!clientes.length) return Promise.resolve(false);
  const id = crypto.randomBytes(6).toString('hex');
  audios.set(id, arq);
  let segundos = 5;
  try { segundos = Math.max(1, (fs.statSync(arq).size - 44) / 48000); } catch {} // 24 kHz, 16 bits, mono
  return new Promise((resolve) => {
    const fim = (ok) => { clearTimeout(t); esperando.delete(id); setTimeout(() => audios.delete(id), 60_000); resolve(ok); };
    const t = setTimeout(() => fim(true), (segundos + 6) * 1000); // se a página não responder, segue em frente
    esperando.set(id, fim);
    for (const c of clientes) c.res.write(`event: tocar\ndata: ${id}\n\n`);
  });
}

/** Pede ao notebook para ouvir (com bipe e detecção de fala no navegador). → WAV 16 kHz ou null. */
export async function ouvirRemoto(opcoes = {}) {
  verificarCancelado();
  const r = await ouvirRemoto0(opcoes);
  verificarCancelado();
  // disse "cancelar" (no ditado, na confirmação, no meio da gravação…): cancela TUDO, não envia nada
  const texto = r && typeof r === 'object' && !Buffer.isBuffer(r) ? r.texto : '';
  if (texto && PEDIU_CANCELAR.test(semAcentoAF(texto))) {
    log(`voz: ouvi "${texto}" → cancelar`);
    await cancelarTudo();
    import('./avisos.js').then((a) => a.naFila(() => a.dizer('Cancelado.'))).catch(() => {});
    throw new Cancelado();
  }
  return r;
}
function ouvirRemoto0({ esperaMs = 7000, silencioMs = 1400, maxMs = 20000, gravar = false } = {}) {
  const c = [...clientes].reverse().find((x) => x.mic);
  if (!c) return Promise.resolve(null);
  const id = crypto.randomBytes(6).toString('hex');
  return new Promise((resolve) => {
    // a página devolve TEXTO pronto (reconhecimento do Chrome), um WAV (para o Gemini) ou, com gravar, a GRAVAÇÃO (webm/opus)
    const fim = (r) => {
      clearTimeout(t); esperando.delete(id);
      if (r && typeof r === 'object' && r.gravacao) {
        log(`voz: gravação recebida do notebook (${Math.round(r.gravacao.length / 1024)} KB)`);
        return resolve(r.gravacao.length > 2000 ? r : null);
      }
      if (r && typeof r === 'object' && 'texto' in r) {
        if (!r.texto) log('voz: o Chrome do notebook não reconheceu fala (página nova)');
        return resolve(r.texto ? { texto: r.texto } : null);
      }
      if (r) log(`voz: recebi áudio gravado do notebook (${r.length} bytes; página ANTIGA? aperte F5 no notebook)`);
      resolve(r && r.length > 1000 ? r : null);
    };
    const t = setTimeout(() => fim(null), esperaMs + maxMs + 8000);
    esperando.set(id, fim);
    c.res.write(`event: ouvir\ndata: ${JSON.stringify({ id, esperaMs, silencioMs, maxMs, gravar })}\n\n`);
  });
}

// Página do notebook: src/pagina.html (relida a cada acesso, para mudanças valerem sem reiniciar)
const PAGINA_ARQ = new URL('./pagina.html', import.meta.url);

export function iniciarAltoFalante() {
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.searchParams.get('k') !== chave) { res.writeHead(403).end('Link sem a chave. Use o endereço de dados/LINK-DA-PAGINA.txt.'); return; }
    if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(fs.readFileSync(PAGINA_ARQ)); return; }
    if (url.pathname === '/eventos') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      res.write(`event: config\ndata: ${JSON.stringify({ nome: config.saudacaoNome })}\n\n`);
      const cli = { res, mic: url.searchParams.get('mic') === '1' };
      clientes.push(cli);
      for (const fn of ouvintesConexao) setTimeout(() => Promise.resolve(fn(cli)).catch(() => {}), 2500);
      log(`alto-falante: notebook conectado (${req.socket.remoteAddress?.replace('::ffff:', '')}), microfone ${cli.mic ? 'liberado' : 'indisponível'}`);
      const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
      req.on('close', () => {
        clearInterval(ping);
        const i = clientes.indexOf(cli); if (i >= 0) clientes.splice(i, 1);
        log('alto-falante: notebook desconectou (voz e microfone voltam para o PC)');
      });
      return;
    }
    let m = /^\/audio\/([a-f0-9]+)$/.exec(url.pathname);
    if (m && audios.has(m[1])) { res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' }); fs.createReadStream(audios.get(m[1])).pipe(res); return; }
    m = /^\/tocado\/([a-f0-9]+)$/.exec(url.pathname);
    if (m && req.method === 'POST') { esperando.get(m[1])?.(true); res.writeHead(204).end(); return; }
    if (url.pathname === '/comando' && req.method === 'POST') {
      const c = url.searchParams.get('c'), t = (url.searchParams.get('t') || '').slice(0, 300);
      res.writeHead(204).end();
      if (['ate-amanha', 'cancela', 'responda', 'enviar', 'enviar-audio', 'lembrete', 'leia', 'ouca-audio', 'leia-de', 'ouca-de', 'responda-de', 'hora', 'clima', 'emails', 'repete', 'abrir-link', 'silenciar', 'dessilenciar'].includes(c)) {
        log(`comando de voz: ${c} ("${t}")`);
        for (const fn of ouvintesComando) Promise.resolve(fn(c, t)).catch((e) => log(`comando ${c}: ${e.message}`));
      }
      return;
    }
    // o "Ligar o PC" do notebook pergunta se a página do Vigia já está aberta lá
    if (url.pathname === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ notebooks: clientes.length }));
      return;
    }
    // instalador do "Ligar o PC" para o notebook, já com os dados deste PC
    if (url.pathname === '/notebook/ligar-pc.zip') {
      import('./ligar-pc.js').then(async ({ montarLigarPc }) => {
        const zip = await montarLigarPc(chave);
        if (!zip) { res.writeHead(500).end('Não consegui montar o instalador.'); return; }
        log('alto-falante: instalador do "Ligar o PC" baixado');
        res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="Vigia-Ligar-o-PC.zip"', 'Cache-Control': 'no-store' });
        fs.createReadStream(zip).pipe(res);
      }).catch(() => res.writeHead(500).end());
      return;
    }
    m = /^\/fala\/([a-f0-9]+)$/.exec(url.pathname);
    if (m && req.method === 'POST') {
      const partes = []; let tam = 0;
      req.on('data', (d) => { tam += d.length; if (tam > 5_000_000) req.destroy(); else partes.push(d); });
      req.on('end', () => {
        const corpo = Buffer.concat(partes);
        const tipo = String(req.headers['content-type'] || '');
        let texto = ''; try { texto = decodeURIComponent(String(req.headers['x-texto'] || '')).slice(0, 2000); } catch {}
        esperando.get(m[1])?.(
          tipo.startsWith('text/plain') ? { texto: corpo.toString('utf8').trim().slice(0, 2000) }
          : tipo.startsWith('audio/webm') ? { gravacao: corpo, texto }
          : corpo);
        res.writeHead(204).end();
      });
      return;
    }
    res.writeHead(404).end();
  });
  srv.on('error', (e) => log(`alto-falante: não abriu a porta ${config.altoFalantePorta} (${e.message})`));
  srv.listen(config.altoFalantePorta, '0.0.0.0', () => {
    log(`página do Vigia neste PC → ${linkLocal()}`);
    for (const u of enderecos()) log(`página do Vigia em outro aparelho da rede → ${u}`);
    fs.writeFileSync(path.join(DADOS, 'LINK-DA-PAGINA.txt'),
      `Neste PC:\n${linkLocal()}\n\nEm outro aparelho da mesma rede (notebook, tablet):\n${enderecos().join('\n')}\n`);
    // ABRIR_PAGINA=1 (quem usa tudo no mesmo PC): se nenhuma página conectar em 12 s, abre no navegador deste PC
    if (config.abrirPagina) setTimeout(() => {
      if (clientes.length) return;
      log('página do Vigia: abrindo no navegador deste PC');
      spawn('rundll32.exe', ['url.dll,FileProtocolHandler', linkLocal()], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }, 12_000);
  });
}
