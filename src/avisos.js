// Avisos: notificação do Windows, voz em fila (uma fala por vez) e histórico em disco.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config, DADOS, RAIZ } from './config.js';

const b64 = (s) => Buffer.from(String(s ?? ''), 'utf8').toString('base64');
const HIST = path.join(DADOS, 'historico.jsonl');

function powershell(script, args) {
  return new Promise((resolve) => {
    const p = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', path.join(RAIZ, 'scripts', script), ...args],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => { if (code) log(`erro em ${script}: ${err.trim().slice(0, 300)}`); resolve(); });
    p.on('error', (e) => { log(`erro em ${script}: ${e.message}`); resolve(); });
  });
}

export function log(msg) {
  const linha = `[${new Date().toLocaleString('pt-BR')}] ${msg}`;
  console.log(linha);
  try { fs.appendFileSync(path.join(DADOS, 'vigia.log'), linha + '\n'); } catch {}
}

function emSilencio(d = new Date()) {
  if (!config.silencio) return false;
  const [ini, fim] = config.silencio;
  const h = d.getHours();
  return ini <= fim ? h >= ini && h < fim : h >= ini || h < fim;
}

export function notificar(titulo, texto, urgente = false) {
  return powershell('toast.ps1', ['-TituloB64', b64(titulo.slice(0, 120)), '-TextoB64', b64(texto.slice(0, 400)), '-Urgente', urgente ? '1' : '0']);
}

const tocarLocal = (arq) => powershell('tocar.ps1', ['-Arquivo', arq]);

// Toca no notebook (se a página do alto-falante estiver aberta), senão no PC. SAIDA_VOZ=ambos toca nos dois.
async function reproduzir(arq) {
  if (config.saidaVoz !== 'pc') {
    const af = await import('./alto-falante.js');
    if (af.conectado()) {
      if (config.saidaVoz === 'ambos') { await Promise.all([af.tocarRemoto(arq), tocarLocal(arq)]); return; }
      if (await af.tocarRemoto(arq)) return;
    }
  }
  return tocarLocal(arq);
}

// Voz do Windows (reserva): gera um WAV para poder tocar no notebook também
async function vozWindows(texto) {
  const arq = path.join(DADOS, 'voz', `aviso-${Date.now()}-win.wav`);
  fs.mkdirSync(path.dirname(arq), { recursive: true });
  await powershell('falar.ps1', ['-TextoB64', b64(texto.slice(0, 600)), '-Voz', config.vozNome, '-Velocidade', String(config.vozVelocidade), '-Arquivo', arq]);
  if (fs.existsSync(arq)) return reproduzir(arq);
  return powershell('falar.ps1', ['-TextoB64', b64(texto.slice(0, 600)), '-Voz', config.vozNome, '-Velocidade', String(config.vozVelocidade)]);
}
let avisouVoz = false;

// Ordem de tentativa: motor escolhido → Microsoft → (voz do Windows, em tocar())
async function gerarAudio(texto) {
  const t = texto.slice(0, 600);
  const motores = [];
  if (config.vozMotor === 'google' && config.geminiChave) motores.push(['Google', () => import('./voz-google.js').then((m) => m.vozGoogle(t))]);
  if (config.vozMotor !== 'windows') motores.push(['Microsoft', () => import('./voz-microsoft.js').then((m) => m.vozMicrosoft(t))]);
  for (const [nome, gerar] of motores) {
    try { return await gerar(); }
    catch (e) { if (!avisouVoz) { log(`voz ${nome} falhou (${e.message}). Tentando a próxima.`); avisouVoz = true; } }
  }
  return null;
}
async function tocar(audio, texto) {
  const arq = await audio;
  if (arq) { avisouVoz = false; return reproduzir(arq); }
  return vozWindows(texto);
}
export const tocarArquivo = (arq) => reproduzir(arq);
/** Fala agora (usado dentro da conversa, que já está na vez dela na fila). */
export const dizer = (texto) => tocar(gerarAudio(texto), texto);

let filaVoz = Promise.resolve();
/** Põe a fala na fila; "depois" roda logo após a fala, ainda segurando a fila (ex.: ouvir "responda"). */
export function falar(texto, depois) {
  if (!config.voz || emSilencio()) return;
  const audio = gerarAudio(texto); // gera já, em paralelo, mas toca na ordem
  filaVoz = filaVoz.then(async () => {
    await tocar(audio, texto);
    if (depois) { try { await depois(); } catch (e) { log(`conversa: ${e.message}`); } }
  });
}

/** Roda fn na vez dela na fila de voz (nada fala por cima). */
export function naFila(fn) {
  filaVoz = filaVoz.then(async () => { try { await fn(); } catch (e) { log(`fila de voz: ${e.message}`); } });
  return filaVoz;
}

let enviarWhatsApp = null;
export const registrarEnvio = (fn) => { enviarWhatsApp = fn; };
export const enviarPeloWhatsApp = () => enviarWhatsApp;

// Último aviso de WhatsApp (para o comando "responda" dito a qualquer momento)
let ultimoWhats = null;
export const ultimoAvisoWhatsApp = () => (ultimoWhats && Date.now() - ultimoWhats.quando < 15 * 60_000 ? ultimoWhats.item : null);

// Mensagens de prioridade baixa (grupos, propaganda) ficam juntas e viram um resumo periódico.
const baixa = [];
export function iniciarResumoBaixa() {
  setInterval(() => {
    if (!baixa.length) return;
    const itens = baixa.splice(0);
    const porOrigem = {};
    for (const i of itens) porOrigem[i.origemCurta] = (porOrigem[i.origemCurta] || 0) + 1;
    const partes = Object.entries(porOrigem).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([o, n]) => `${o} (${n})`);
    notificar(`Resumo: ${itens.length} mensagens sem pressa`, partes.join(' · '));
  }, Math.max(5, config.resumoBaixaMin) * 60_000).unref?.();
}

const semEmoji = (s) => String(s || '').replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '').replace(/\s+/g, ' ').trim() || 'um contato';
const ehPrivado = (item) => !item.grupo && config.privados.some((p) => `${item.de} ${item.endereco || ''}`.toLowerCase().includes(p));

/**
 * item = { canal: 'whatsapp'|'email', de, assunto?, grupo?, resumo, fala, prioridade: 'urgente'|'normal'|'baixa', textoOriginal }
 */
export async function avisar(item) {
  try { fs.appendFileSync(HIST, JSON.stringify({ quando: new Date().toISOString(), ...item }) + '\n'); } catch {}
  const icone = item.canal === 'email' ? '✉️' : '💬';
  const origem = item.grupo ? `${item.de} em ${item.grupo}` : item.de;
  log(`${item.prioridade.toUpperCase()} ${item.canal} ${origem}: ${item.resumo}`);

  if (item.prioridade === 'silencio') return; // newsletter/anúncio por e-mail: só histórico
  if (item.prioridade === 'baixa') {
    baixa.push({ origemCurta: item.grupo || item.de });
    return;
  }
  const urgente = item.prioridade === 'urgente';
  const titulo = `${urgente ? '🔴 URGENTE · ' : ''}${icone} ${origem}`;
  const texto = item.assunto ? `${item.assunto}\n${item.resumo}` : item.resumo;
  await notificar(titulo, texto, urgente);
  const canalFala = item.canal === 'email' ? 'E-mail de' : 'Mensagem de';
  // Contato privado (PRIVADOS no .env): a voz NÃO fala o conteúdo, só de quem é.
  item.privado = ehPrivado(item);
  const nomeFalado = semEmoji(item.de);
  if (item.canal === 'whatsapp' && item.jid) ultimoWhats = { quando: Date.now(), item: { ...item, de: nomeFalado } };
  if (config.saidaVoz !== 'pc') import('./alto-falante.js').then((af) => af.mostrarAviso({
    canal: item.canal, de: item.de, grupo: item.grupo, urgente,
    resumo: item.privado ? '' : (item.assunto ? `${item.assunto} — ${item.resumo}` : item.resumo),
    hora: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
  })).catch(() => {});
  const depois = item.canal === 'whatsapp' && item.jid && config.responderVoz
    ? () => import('./conversa.js').then((m) => m.talvezResponder({ ...item, de: nomeFalado }, { dizer, enviar: enviarWhatsApp }))
    : undefined;
  const conteudo = item.privado ? '' : ` ${item.fala || item.resumo}`;
  falar(`${urgente && !item.privado ? 'Urgente. ' : ''}${canalFala} ${nomeFalado}.${conteudo}`, depois);
}
