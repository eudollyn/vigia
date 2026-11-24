// Avisos: notificação do Windows, voz em fila (uma fala por vez) e histórico em disco.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config, DADOS, RAIZ } from './config.js';
import { expandirGirias } from './girias.js';
import { AsyncLocalStorage } from 'node:async_hooks';

// ---------- "cancelar" ----------
// Cada item da fila de voz roda com a "geração" em que entrou. "Cancelar" troca a geração: o que estava esperando
// é descartado e a conversa em andamento é interrompida no próximo passo (falar, ouvir, gravar, enviar).
const execucao = new AsyncLocalStorage();
let geracao = 0;
export class Cancelado extends Error { constructor() { super('cancelado pelo usuário'); this.cancelado = true; } }
/** Lança Cancelado se o usuário disse "cancelar" depois que esta conversa começou. */
export function verificarCancelado() { const g = execucao.getStore(); if (g !== undefined && g !== geracao) throw new Cancelado(); }
export async function cancelarTudo() {
  geracao++;
  log('cancelar: tudo o que estava em andamento foi interrompido');
  try { (await import('./alto-falante.js')).pararTudo(); } catch {}
}

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
// Pronúncia: troca só no que é FALADO (PRONUNCIA=Thalyta=Talíta;Outro=Outro jeito). Palavra inteira, sem diferenciar maiúsculas.
// Consoante maiúscula sozinha é lida pelo nome da letra: "faz o L" saía "fazendão UEL"; com "éle" sai certo.
// (Vogais ficam de fora: "A", "O", "E" sozinhos costumam ser artigo ou conjunção.)
const NOME_LETRA = { B: 'bê', C: 'cê', D: 'dê', F: 'éfe', G: 'gê', H: 'agá', J: 'jota', K: 'cá', L: 'éle', M: 'ême', N: 'êne',
  P: 'pê', Q: 'quê', R: 'érre', S: 'ésse', T: 'tê', V: 'vê', W: 'dáblio', X: 'xis', Y: 'ípsilon', Z: 'zê' };
export function pronunciar(texto) {
  const mapa = new Map(config.pronuncia.map(([de, para]) => [de.toLowerCase(), para]));
  // 1) internetês → palavras ("vc" → "você", "kkkk" → "risos", "simmm" → "sim")
  // 2) nomes com pronúncia própria (PRONUNCIA) e letras soltas ("L" → "éle")
  // separa em palavras (letras) e o resto; troca só palavras inteiras ("Thalytinha" não vira "Talítinha")
  return expandirGirias(texto).split(/(\p{L}+)/u).map((p) => mapa.get(p.toLowerCase()) ?? NOME_LETRA[p] ?? p).join('');
}
async function gerarAudio(texto) {
  const t = pronunciar(texto).slice(0, 600);
  const motores = [];
  if (config.vozMotor === 'google' && config.geminiChave) motores.push(['Google', () => import('./voz-google.js').then((m) => m.vozGoogle(t))]);
  if (config.vozMotor !== 'windows') motores.push(['Microsoft', () => import('./voz-microsoft.js').then((m) => m.vozMicrosoft(t))]);
  for (const [nome, gerar] of motores) {
    try { return await gerar(); }
    catch (e) { if (!avisouVoz) { log(`voz ${nome} falhou (${e.message}). Tentando a próxima.`); avisouVoz = true; } }
  }
  return null;
}
/** O último link (http/https ou www.) de um texto, ou ''. */
export function acharLink(texto) {
  const links = String(texto || '').match(/\bhttps?:\/\/[^\s<>"'`]+|\bwww\.[^\s<>"'`]+/gi);
  if (!links) return '';
  const l = links[links.length - 1].replace(/[).,;!?]+$/, '');
  return /^https?:\/\//i.test(l) ? l : 'https://' + l;
}

/** Abre o link no navegador padrão do PC. Só http/https, sem passar pelo shell. */
export async function abrirLink(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (!['http:', 'https:'].includes(u.protocol)) return false;
  return new Promise((ok) => {
    const p = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', u.href], { windowsHide: true, detached: true, stdio: 'ignore' });
    p.on('error', () => ok(false)); p.on('spawn', () => { p.unref(); ok(true); });
  });
}

// a última coisa falada, para o comando "repete"
let ultimaFalaTexto = '';
export const ultimaFala = () => ultimaFalaTexto;
async function tocar(audio, texto) {
  verificarCancelado();
  if (texto && !/^(cancelado\.?|vou repetir\.?)$/i.test(String(texto).trim())) ultimaFalaTexto = texto;
  const arq = await audio;
  verificarCancelado();
  if (arq) { avisouVoz = false; await reproduzir(arq); verificarCancelado(); return; }
  return vozWindows(texto);
}
export const tocarArquivo = (arq) => reproduzir(arq);
/** Fala agora (usado dentro da conversa, que já está na vez dela na fila). */
export const dizer = (texto) => tocar(gerarAudio(texto), texto);
/** Gera o WAV da fala (voz configurada, ex.: Francisca) sem tocar. → caminho do arquivo ou null */
export const gerarAudioArquivo = (texto) => gerarAudio(texto);

let filaVoz = Promise.resolve();
/** Põe a fala na fila; "depois" roda logo após a fala, ainda segurando a fila (ex.: ouvir "responda"). */
export function falar(texto, depois) {
  if (!config.voz || emSilencio()) return;
  const audio = gerarAudio(texto); // gera já, em paralelo, mas toca na ordem
  const g = geracao;
  filaVoz = filaVoz.then(() => execucao.run(g, async () => {
    if (g !== geracao) return; // cancelado enquanto esperava a vez
    try {
      await tocar(audio, texto);
      if (depois) await depois();
    } catch (e) { if (!e.cancelado) log(`conversa: ${e.message}`); }
  }));
}

/** Roda fn na vez dela na fila de voz (nada fala por cima). */
export function naFila(fn) {
  const g = geracao;
  filaVoz = filaVoz.then(() => execucao.run(g, async () => {
    if (g !== geracao) return; // cancelado enquanto esperava a vez
    try { await fn(); } catch (e) { if (!e.cancelado) log(`fila de voz: ${e.message}`); }
  }));
  return filaVoz;
}

let enviarWhatsApp = null;
export const registrarEnvio = (fn) => { enviarWhatsApp = fn; };
export const enviarPeloWhatsApp = () => enviarWhatsApp;
let enviarAudioWhatsApp = null;
export const registrarEnvioAudio = (fn) => { enviarAudioWhatsApp = fn; };
export const enviarAudioPeloWhatsApp = () => enviarAudioWhatsApp;

// Último aviso de WhatsApp (para o comando "responda" dito a qualquer momento)
let ultimoWhats = null;
export const ultimoAvisoWhatsApp = () => (ultimoWhats && Date.now() - ultimoWhats.quando < 15 * 60_000 ? ultimoWhats.item : null);
// Último aviso de qualquer canal (para o comando "leia" dito a qualquer momento)
let ultimoQualquer = null;
export const ultimoAviso = () => (ultimoQualquer && Date.now() - ultimoQualquer.quando < 30 * 60_000 ? ultimoQualquer.item : null);

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
  if (item.atrasada) return guardarAtrasada(item, icone, origem);
  const urgente = item.prioridade === 'urgente';
  const titulo = `${urgente ? '🔴 URGENTE · ' : ''}${icone} ${origem}`;
  const texto = item.assunto ? `${item.assunto}\n${item.resumo}` : item.resumo;
  await notificar(titulo, texto, urgente);
  const canalFala = item.canal === 'email' ? 'E-mail de' : 'Mensagem de';
  // Contato privado (ex.: Ana): a voz NÃO fala o conteúdo, só de quem é.
  item.privado = ehPrivado(item);
  const nomeFalado = semEmoji(item.de);
  if (item.canal === 'whatsapp' && item.jid) ultimoWhats = { quando: Date.now(), item: { ...item, de: nomeFalado } };
  if (config.saidaVoz !== 'pc') import('./alto-falante.js').then((af) => af.mostrarAviso({
    canal: item.canal, de: item.de, grupo: item.grupo, urgente,
    resumo: item.privado ? '' : (item.assunto ? `${item.assunto} — ${item.resumo}` : item.resumo),
    hora: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
  })).catch(() => {});
  const itemFalado = { ...item, de: nomeFalado, grupo: item.grupo && semEmoji(item.grupo) };
  ultimoQualquer = { quando: Date.now(), item: itemFalado };
  const grupoFalado = itemFalado.grupo ? `, no grupo ${itemFalado.grupo}` : '';

  if (config.lerSobDemanda) {
    // Aviso curto: só de quem é (e o grupo). O conteúdo só é lido se você disser "leia" quando o microfone abrir.
    const depois = config.responderVoz
      ? () => import('./conversa.js').then((m) => m.aposAviso(itemFalado, { dizer, enviar: enviarWhatsApp }))
      : undefined;
    // mensagem com link: "Ana mandou um link." (aí "abra o link" abre no navegador do PC)
    const comLink = item.canal === 'whatsapp' && acharLink(item.texto);
    falar(comLink
      ? `${urgente ? 'Urgente. ' : ''}${nomeFalado} mandou um link${grupoFalado}.`
      : `${urgente ? 'Urgente. ' : ''}${canalFala} ${nomeFalado}${grupoFalado}.`, depois);
    return;
  }
  // modo antigo (LER_SOB_DEMANDA=0): já lê o conteúdo junto
  const depois = item.canal === 'whatsapp' && item.jid && config.responderVoz
    ? () => import('./conversa.js').then((m) => m.talvezResponder(itemFalado, { dizer, enviar: enviarWhatsApp }))
    : undefined;
  const conteudo = item.privado ? '' : ` ${item.fala || item.resumo}`;
  falar(`${urgente && !item.privado ? 'Urgente. ' : ''}${canalFala} ${nomeFalado}${grupoFalado}.${conteudo}`, depois);
}

// Mensagens que chegaram enquanto o Vigia estava fora (PC desligado, reinício): em vez de falar uma por uma,
// junta tudo e fala UM aviso só ("Enquanto eu estava desligado, chegaram mensagens de Ana e do grupo X.").
const atrasadas = [];
let tAtrasadas;
function guardarAtrasada(item, icone, origem) {
  item.privado = ehPrivado(item);
  const nomeFalado = semEmoji(item.de);
  const itemFalado = { ...item, de: nomeFalado, grupo: item.grupo && semEmoji(item.grupo) };
  if (item.jid) ultimoWhats = { quando: Date.now(), item: itemFalado };
  ultimoQualquer = { quando: Date.now(), item: itemFalado };
  if (config.saidaVoz !== 'pc') import('./alto-falante.js').then((af) => af.mostrarAviso({
    canal: item.canal, de: item.de, grupo: item.grupo, urgente: false,
    resumo: item.privado ? '' : item.resumo,
    hora: 'enquanto estava fora',
  })).catch(() => {});
  atrasadas.push({ origem: itemFalado.grupo ? `do grupo ${itemFalado.grupo}` : `de ${nomeFalado}`, titulo: `${icone} ${origem}`, itemFalado });
  clearTimeout(tAtrasadas);
  tAtrasadas = setTimeout(falarAtrasadas, 12_000); // espera o WhatsApp terminar de entregar tudo
}
function falarAtrasadas() {
  const lista = atrasadas.splice(0);
  if (!lista.length) return;
  const origens = [...new Set(lista.map((a) => a.origem))];
  const nomes = origens.slice(0, 4);
  const resto = origens.length - nomes.length;
  const junta = (l) => (l.length > 1 ? `${l.slice(0, -1).join(', ')} e ${l[l.length - 1]}` : l[0]);
  const frase = `Enquanto eu estava desligado, chegaram mensagens ${junta(resto > 0 ? [...nomes, `mais ${resto} conversas`] : nomes)}.`;
  log(`aviso das mensagens de quando estava fora: ${frase}`);
  notificar('💬 Enquanto o Vigia estava fora', lista.map((a) => a.titulo).slice(0, 8).join(' · '));
  const ultima = lista[lista.length - 1].itemFalado;
  const depois = config.lerSobDemanda && config.responderVoz && ultima.jid
    ? () => import('./conversa.js').then((m) => m.aposAviso(ultima, { dizer, enviar: enviarWhatsApp }))
    : undefined;
  falar(frase, depois);
}

/** O que a voz lê quando você pede "leia". */
export function textoParaLer(item) {
  const corpo = item.fala || item.resumo || 'sem texto';
  return item.canal === 'email' && item.assunto ? `Assunto: ${item.assunto}. ${corpo}` : corpo;
}
