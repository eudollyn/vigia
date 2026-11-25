// Vigia · github.com/eudollyn/vigia · AGPL-3.0-or-later · VGA-EUD-2026 (manter este crédito em cópias e versões modificadas)
// Leitor de WhatsApp (conexão tipo WhatsApp Web, via Baileys). SOMENTE LEITURA:
// não envia mensagens, não marca como lido e não aparece "online".
import makeWASocket, {
  useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, Browsers,
  normalizeMessageContent, getContentType, isJidGroup, isJidBroadcast, isJidStatusBroadcast, isJidNewsletter, jidNormalizedUser,
  downloadMediaMessage, proto,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import qrTerminal from 'qrcode-terminal';
import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config, DADOS, aplicarApelidos } from './config.js';
import { log, notificar, registrarEnvio, registrarEnvioAudio, registrarEncaminhar, marcarConversa, conversaAtiva } from './avisos.js';
import { transcrever } from './transcrever.js';
import { recebeu, respondeu } from './pendencias.js';

const SESSAO = path.join(DADOS, 'whatsapp-sessao');
const CONTATOS = path.join(DADOS, 'contatos.json');
const QR_PNG = path.join(DADOS, 'whatsapp-qr.png');

let contatos = {};
try { contatos = JSON.parse(fs.readFileSync(CONTATOS, 'utf8')); } catch {}
let salvarContatosT;
const salvarContatos = () => { clearTimeout(salvarContatosT); salvarContatosT = setTimeout(() => fs.writeFileSync(CONTATOS, JSON.stringify(contatos)), 3000); };

const nomeDe = (jid, pushName) => {
  const id = jidNormalizedUser(jid);
  const c = contatos[id];
  return c?.name || c?.notify || pushName || c?.verifiedName || ('+' + id.split('@')[0]);
};

function descrever(message) {
  const m = normalizeMessageContent(message);
  if (!m) return null;
  const tipo = getContentType(m);
  const c = m[tipo];
  switch (tipo) {
    case 'conversation': return c;
    case 'extendedTextMessage': return c.text;
    case 'imageMessage': return `[enviou uma foto]${c.caption ? ' ' + c.caption : ''}`;
    case 'videoMessage': return `[enviou um vídeo]${c.caption ? ' ' + c.caption : ''}`;
    case 'audioMessage': return `[enviou um áudio de ${Math.round(c.seconds || 0)} segundos]`;
    case 'documentMessage': case 'documentWithCaptionMessage':
      return `[enviou o arquivo ${c.fileName || c.title || 'sem nome'}]${c.caption ? ' ' + c.caption : ''}`;
    case 'stickerMessage': return '[enviou uma figurinha]';
    case 'locationMessage': case 'liveLocationMessage': return '[enviou uma localização]';
    case 'contactMessage': return `[enviou o contato ${c.displayName || ''}]`;
    case 'contactsArrayMessage': return '[enviou contatos]';
    case 'pollCreationMessage': case 'pollCreationMessageV3': return `[criou uma enquete] ${c.name || ''}`;
    case 'eventMessage': return `[criou um evento] ${c.name || ''}`;
    default: return null; // reações, edições, protocolos, confirmações: ignora
  }
}

// ---------- conversas arquivadas: não geram aviso nenhum ----------
const ARQ_ARQUIVADAS = path.join(DADOS, 'arquivadas.json');
let arquivadas = new Set();
try { arquivadas = new Set(JSON.parse(fs.readFileSync(ARQ_ARQUIVADAS, 'utf8'))); } catch {}
let salvarArqT;
function marcarArquivada(id, sim) {
  if (!id) return;
  const n = jidNormalizedUser(id);
  const antes = arquivadas.has(n);
  if (sim) arquivadas.add(n); else arquivadas.delete(n);
  if (antes !== !!sim) { clearTimeout(salvarArqT); salvarArqT = setTimeout(() => fs.writeFileSync(ARQ_ARQUIVADAS, JSON.stringify([...arquivadas])), 2000); }
}
const estaArquivada = (ids) => ids.some((i) => arquivadas.has(jidNormalizedUser(i)));
export const totalArquivadas = () => arquivadas.size;

// ---------- conversas SILENCIADAS no WhatsApp: a mensagem aparece só na tela, sem voz nem notificação ----------
// O WhatsApp sincroniza o "silenciar" entre os aparelhos: muteEndTime = até quando (ms), -1 = "sempre", null = sem silêncio.
const ARQ_SILENCIADAS = path.join(DADOS, 'silenciadas-whatsapp.json');
let silenciadasZap = {};
try { silenciadasZap = JSON.parse(fs.readFileSync(ARQ_SILENCIADAS, 'utf8')); } catch {}
let salvarSilT;
function marcarSilenciada(id, ate) {
  if (!id) return;
  const n = jidNormalizedUser(id);
  const antes = silenciadasZap[n];
  const valor = ate && (Number(ate) < 0 || Number(ate) > Date.now()) ? Number(ate) : null;
  if (valor) silenciadasZap[n] = valor; else delete silenciadasZap[n];
  if (antes !== silenciadasZap[n]) { clearTimeout(salvarSilT); salvarSilT = setTimeout(() => fs.writeFileSync(ARQ_SILENCIADAS, JSON.stringify(silenciadasZap)), 2000); }
}
/** A conversa está silenciada no WhatsApp agora? (o silêncio de 8 h / 1 semana acaba sozinho) */
const estaSilenciadaNoZap = (ids) => ids.some((i) => { const v = silenciadasZap[jidNormalizedUser(i)]; return v && (v < 0 || v > Date.now()); });

// ---------- áudios recebidos: baixa e transcreve com o Gemini ----------
// Os últimos áudios ficam guardados (só na memória, 1 hora) para o "ouça o áudio" — inclusive os que não deu para transcrever.
const audiosRecentes = []; // { jid, buf, tipo, seg, quando, texto }
async function transcreverAudio(msg, descricao) {
  const m = normalizeMessageContent(msg.message);
  const audio = m?.audioMessage;
  if (!audio) return descricao;
  const seg = Math.round(audio.seconds || 0);
  let guardado = null;
  try {
    const buf = await downloadMediaMessage(msg, 'buffer', {});
    const tipo = String(audio.mimetype || 'audio/ogg').split(';')[0];
    const autorJid = msg.key.participantAlt || msg.key.participant || msg.key.remoteJidAlt || '';
    guardado = { jid: jidNormalizedUser(msg.key.remoteJid), autor: autorJid ? jidNormalizedUser(autorJid) : '', buf, tipo, seg, quando: Date.now(), texto: '' };
    audiosRecentes.push(guardado);
    salvarAudioEmDisco(guardado);
    while (audiosRecentes.length > 20 || (audiosRecentes[0] && Date.now() - audiosRecentes[0].quando > 3600_000)) audiosRecentes.shift();
    if (seg > 300) return descricao; // áudios de mais de 5 min: não transcreve na chegada (dá para tocar com "ouça o áudio")
    // no máximo 12 s: com o Gemini sobrecarregado, o aviso não pode ficar esperando (dá para ouvir o original)
    const fala = await Promise.race([transcrever(buf, [], tipo), new Promise((_, nao) => setTimeout(() => nao(new Error('demorou mais de 12 s')), 12_000))]);
    if (fala) { guardado.texto = fala; salvarAudioEmDisco(guardado); log(`WhatsApp: áudio de ${seg}s transcrito`); return `[mandou um áudio de ${seg} segundos dizendo:] ${fala}`; }
  } catch (e) { log(`WhatsApp: não consegui transcrever o áudio (${e.message})`); }
  return descricao;
}

let meuJid = '';
let sockAtual = null;
/** Seu próprio número (conversa "Você"), para testes sem incomodar ninguém. */
export const jidProprio = () => meuJid;

/** "Onda sonora" do áudio de voz (64 valores 0–100), calculada do próprio arquivo com o ffmpeg. */
export async function calcularOnda(ogg) {
  const { spawn } = await import('node:child_process');
  const pcm = await new Promise((ok) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { windowsHide: true });
    const partes = []; ff.stdout.on('data', (d) => partes.push(d));
    ff.on('close', () => ok(Buffer.concat(partes))); ff.on('error', () => ok(Buffer.alloc(0)));
    ff.stdin.on('error', () => {}); ff.stdin.end(ogg);
  });
  const n = Math.floor(pcm.length / 2); if (!n) return undefined;
  const blocos = 64, tam = Math.max(1, Math.floor(n / blocos)), medias = [];
  for (let b = 0; b < blocos; b++) { let s = 0; for (let i = b * tam; i < Math.min(n, (b + 1) * tam); i++) s += Math.abs(pcm.readInt16LE(i * 2)); medias.push(s / tam); }
  const max = Math.max(...medias) || 1;
  return new Uint8Array(medias.map((m) => Math.round((m / max) * 100)));
}


// O ÚLTIMO áudio de cada conversa e de cada pessoa também fica em disco (dados/audios, um por id, sobrescreve):
// "ouça o último áudio da Ana" funciona mesmo depois de reiniciar o PC.
const PASTA_AUDIOS = path.join(DADOS, 'audios');
const nomeArq = (id) => path.join(PASTA_AUDIOS, String(id).replace(/[^0-9a-z@._-]/gi, '_'));
function salvarAudioEmDisco(a) {
  try {
    fs.mkdirSync(PASTA_AUDIOS, { recursive: true });
    const meta = JSON.stringify({ jid: a.jid, autor: a.autor, tipo: a.tipo, seg: a.seg, quando: a.quando, texto: a.texto });
    for (const id of new Set([a.jid, a.autor].filter(Boolean))) {
      fs.writeFileSync(nomeArq(id) + '.audio', a.buf);
      fs.writeFileSync(nomeArq(id) + '.json', meta);
    }
  } catch (e) { log(`WhatsApp: não guardou o áudio em disco (${e.message})`); }
}
/** Todas as formas do id de um contato (telefone e @lid), pela agenda. */
export function idsDoContato(jid) {
  const n = jidNormalizedUser(jid);
  const ids = new Set([n]);
  const c = contatos[n];
  for (const x of [c?.lid, c?.phoneNumber, c?.id]) if (x) ids.add(jidNormalizedUser(x));
  for (const [id, o] of Object.entries(contatos)) {
    if ([o.lid, o.phoneNumber, o.id].filter(Boolean).map((x) => jidNormalizedUser(x)).includes(n)) ids.add(jidNormalizedUser(id));
  }
  return [...ids];
}
/** Último áudio de uma pessoa ou grupo (qualquer um dos ids): da memória ou, depois de reiniciar, do disco. */
export function ultimoAudioDe(ids) {
  for (let i = audiosRecentes.length - 1; i >= 0; i--) {
    const a = audiosRecentes[i];
    if (ids.includes(a.jid) || ids.includes(a.autor)) return a;
  }
  let melhor = null;
  for (const id of ids) {
    try {
      const meta = JSON.parse(fs.readFileSync(nomeArq(id) + '.json', 'utf8'));
      if (!melhor || meta.quando > melhor.quando) melhor = { ...meta, arq: nomeArq(id) + '.audio' };
    } catch {}
  }
  if (!melhor) return null;
  try { return { ...melhor, buf: fs.readFileSync(melhor.arq) }; } catch { return null; }
}

/** Último áudio recebido (de um chat, ou de qualquer um). → { jid, buf, tipo, seg, texto } | null */
export const _audiosRecentes = audiosRecentes; // (usado só nos testes)
export function ultimoAudio(jid) {
  const n = jid ? jidNormalizedUser(jid) : null;
  for (let i = audiosRecentes.length - 1; i >= 0; i--) if (!n || audiosRecentes[i].jid === n) return audiosRecentes[i];
  return null;
}

// ---------- busca de contato/grupo pelo nome falado ("envia mensagem para Dênisson") ----------
const gruposTodos = {}; // jid → nome do grupo
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
function lev(a, b) { // distância de edição (erros de transcrição: "tiago" ~ "thiago")
  const m = a.length, n = b.length; if (!m || !n) return m || n;
  let ant = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { const at = [i]; for (let j = 1; j <= n; j++) at[j] = Math.min(ant[j] + 1, at[j - 1] + 1, ant[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); ant = at; }
  return ant[n];
}
// "chave de som" em português: Thiago / Tiago / Thyago → "tiago"; Thalyta / Talita → "talita"
const som = (w) => w.replace(/ph/g, 'f').replace(/h/g, '').replace(/y/g, 'i').replace(/w/g, 'v').replace(/k/g, 'c')
  .replace(/qu/g, 'c').replace(/z/g, 's').replace(/(.)\1+/g, '$1');
const parecido = (a, b) => a === b || som(a) === som(b) ||
  (a.length >= 3 && b.length >= 3 && 1 - lev(som(a), som(b)) / Math.max(som(a).length, som(b).length) >= 0.75);
function pontuar(q, nome) {
  if (!q || !nome) return 0;
  if (q === nome) return 100;
  const pq = q.split(' '), pn = nome.split(' ');
  const extra = Math.max(0, pn.length - pq.length) * 3; // "Thiago" vence "Thiago Oficina Mecânica"
  if (som(q) === som(nome)) return 95;
  if (nome.startsWith(q + ' ') || pn[0] === q) return 85 - extra;
  if (pq.every((w) => pn.includes(w))) return 72 - extra;
  if (pq.every((w) => pn.some((x) => som(x) === som(w)))) return 68 - extra;
  if (pq.every((w) => pn.some((x) => parecido(w, x)))) return 55 - extra;
  // começo do som: "Rafa" → "Rafael", "Gabi" → "Gabriela"
  if (pq.length === 1 && som(q).length >= 3 && pn.some((x) => som(x).startsWith(som(q)))) return 60 - extra;
  if (pq.length === 1 && q.length >= 4 && pn.some((x) => x.startsWith(q))) return 45 - extra;
  return 0;
}
/** Nomes conhecidos (para ajudar a transcrição a acertar a grafia). */
/** Quantas das primeiras palavras formam o nome de um contato/grupo? ("grupo gato cachorro e elefante que hoje…" → 5).
 *  Escolhe o pedaço com a melhor nota; empate → o mais longo. null se nenhum pedaço parecer um nome. */
export function tamanhoDoNome(palavras) {
  let melhor = null;
  for (let n = 1; n <= Math.min(7, palavras.length - 1); n++) {
    const q = norm(aplicarApelidos(palavras.slice(0, n).join(' '))).replace(/^(o|a|os|as|grupo|grupo do|grupo da|contato)\s+/, '');
    if (!q) continue;
    let nota = 0;
    for (const c of Object.values(contatos)) if (c.name) nota = Math.max(nota, pontuar(q, norm(c.name)));
    for (const g of Object.values(gruposTodos)) nota = Math.max(nota, pontuar(q, norm(g)));
    if (nota >= 55 && (!melhor || nota >= melhor.nota)) melhor = { n, nota };
  }
  return melhor ? melhor.n : null;
}
export function nomesConhecidos() {
  return [...new Set([...Object.values(contatos).map((c) => c.name), ...Object.values(gruposTodos)].filter(Boolean))];
}
/** → { tipo: 'ok', destino } | { tipo: 'varios', opcoes: [destino...] } | { tipo: 'nenhum' } */
export function buscarDestino(nomeFalado) {
  const q = norm(aplicarApelidos(nomeFalado)).replace(/^(o|a|os|as|grupo|grupo do|grupo da|contato)\s+/, '');
  if (!q) return { tipo: 'nenhum' };
  const porNome = new Map(); // um destino por nome (o mesmo contato pode ter id de telefone e @lid)
  for (const [jid, c] of Object.entries(contatos)) {
    // só contatos SALVOS na agenda: o nome de perfil de quem você não salvou (ex.: "Dennis" de um grupo) não entra
    const nome = c.name; if (!nome) continue;
    const p = pontuar(q, norm(nome)); if (!p) continue;
    const atual = porNome.get(nome);
    const melhorJid = !atual || (jid.endsWith('@s.whatsapp.net') && !atual.destino.jid.endsWith('@s.whatsapp.net'));
    if (!atual || p > atual.p || (p === atual.p && melhorJid)) porNome.set(nome, { p, destino: { jid, de: nome } });
  }
  for (const [jid, nome] of Object.entries(gruposTodos)) {
    const p = pontuar(q, norm(nome)); if (p) porNome.set('grupo:' + nome, { p, destino: { jid, de: nome, grupo: nome } });
  }
  const lista = [...porNome.values()].sort((a, b) => b.p - a.p);
  if (!lista.length) return { tipo: 'nenhum' };
  const melhores = lista.filter((x) => x.p === lista[0].p);
  if (melhores.length === 1) return { tipo: 'ok', destino: melhores[0].destino };
  return { tipo: 'varios', opcoes: melhores.slice(0, 4).map((x) => x.destino) };
}

// Mensagens RECEBIDAS (o original completo, últimas 30 por conversa), em disco: é o que o "encaminhe essa mensagem"
// reenvia com o selo "Encaminhada" (também áudio, foto e documento).
const ARQ_RECEBIDAS = path.join(DADOS, 'recebidas.json');
let recebidas = { msgs: {}, porChat: {} };
try { recebidas = { msgs: {}, porChat: {}, ...JSON.parse(fs.readFileSync(ARQ_RECEBIDAS, 'utf8')) }; } catch {}
let tRecebidas;
function guardarRecebida(jid, msg) {
  try {
    if (!msg?.key?.id || !msg.message) return;
    recebidas.msgs[msg.key.id] = Buffer.from(proto.WebMessageInfo.encode(msg).finish()).toString('base64');
    const lista = (recebidas.porChat[jid] ||= []);
    lista.push(msg.key.id);
    while (lista.length > 30) delete recebidas.msgs[lista.shift()];
    clearTimeout(tRecebidas);
    tRecebidas = setTimeout(() => { try { fs.writeFileSync(ARQ_RECEBIDAS, JSON.stringify(recebidas)); } catch {} }, 2000);
  } catch (e) { log(`WhatsApp: não guardei a mensagem original (${e.message})`); }
}
// ---------- envio pedido pelo ChatGPT (conector-gpt.js) ----------
/** Contatos salvos e grupos que batem com o nome (até 8), com o número quando houver. */
export function pesquisarContatos(nome) {
  const q = norm(nome);
  if (!q) return [];
  const r = [];
  for (const [jid, c] of Object.entries(contatos)) {
    if (!c.name || !norm(c.name).includes(q)) continue;
    const numero = jid.endsWith('@s.whatsapp.net') ? '+' + jid.split('@')[0] : null;
    if (!r.some((x) => x.nome === c.name && (x.numero || !numero))) r.push({ nome: c.name, numero, tipo: 'contato' });
  }
  for (const [, nomeG] of Object.entries(gruposTodos)) if (norm(nomeG).includes(q)) r.push({ nome: nomeG, numero: null, tipo: 'grupo' });
  return r.slice(0, 8);
}

/** Número de telefone (com ou sem +55, com espaços/traços) → jid conferido no WhatsApp, ou null. */
export async function jidDoNumero(texto) {
  let d = String(texto || '').replace(/\D/g, '');
  if (d.length < 10) return null;
  if (d.startsWith('0')) d = d.replace(/^0+/, '');
  if (d.length === 10 || d.length === 11) d = '55' + d; // número brasileiro sem o código do país
  if (!sockAtual) throw new Error('O WhatsApp do Vigia não está conectado agora.');
  const tentativas = [d];
  // celular brasileiro com/sem o 9 extra: o WhatsApp às vezes cadastra o número antigo
  if (d.startsWith('55') && d.length === 13) tentativas.push(d.slice(0, 4) + d.slice(5));
  if (d.startsWith('55') && d.length === 12) tentativas.push(d.slice(0, 4) + '9' + d.slice(4));
  for (const n of tentativas) {
    const [r] = await sockAtual.onWhatsApp(n).catch(() => []);
    if (r?.exists) return jidNormalizedUser(r.jid);
  }
  return null;
}

/** Envia texto + arquivos (PDF etc.). destino = número ou nome salvo. → { para, numero } */
export async function enviarComArquivos(destino, texto, arquivos = []) {
  if (!sockAtual) throw new Error('O WhatsApp do Vigia não está conectado agora.');
  let jid = null, para = null;
  if (/\d{8,}/.test(String(destino).replace(/[\s().-]/g, ''))) {
    jid = await jidDoNumero(destino);
    if (!jid) throw new Error(`O número ${destino} não tem WhatsApp (ou está incompleto). Confira o DDD.`);
    para = contatos[jid]?.name || '+' + jid.split('@')[0];
  } else {
    const r = buscarDestino(destino);
    if (r.tipo === 'nenhum') throw new Error(`Não achei "${destino}" nos contatos salvos. Mande o número com DDD.`);
    if (r.tipo === 'varios') throw new Error(`"${destino}" bate com mais de um contato: ${r.opcoes.map((o) => o.de).join(', ')}. Diga qual, ou mande o número.`);
    jid = r.destino.jid; para = r.destino.de;
  }
  if (texto) guardarEnviada(await sockAtual.sendMessage(jid, { text: texto }));
  for (const a of arquivos) {
    guardarEnviada(await sockAtual.sendMessage(jid, { document: fs.readFileSync(a.caminho), mimetype: a.tipo, fileName: a.nome }));
  }
  marcarConversa(idsDoContato(jid));
  return { para, numero: jid.endsWith('@s.whatsapp.net') ? '+' + jid.split('@')[0] : null };
}

/** ids de mensagens → os originais (na ordem); os que não existirem mais são ignorados. */
export function mensagensOriginais(ids) {
  const out = [];
  for (const id of ids || []) {
    const b64 = recebidas.msgs[id];
    if (b64) try { out.push(proto.WebMessageInfo.decode(Buffer.from(b64, 'base64'))); } catch {}
  }
  return out;
}

// Mensagens que o Vigia enviou (últimas 200), gravadas em disco. Quando um aparelho não consegue abrir uma
// delas (no celular aparece "Aguardando mensagem"), ele pede reenvio e o Baileys busca aqui (getMessage).
const ARQ_ENVIADAS = path.join(DADOS, 'enviadas.json');
let enviadas = {};
try { enviadas = JSON.parse(fs.readFileSync(ARQ_ENVIADAS, 'utf8')); } catch {}
function guardarEnviada(m) {
  try {
    if (!m?.key?.id || !m.message) return;
    enviadas[m.key.id] = Buffer.from(proto.Message.encode(m.message).finish()).toString('base64');
    const ids = Object.keys(enviadas);
    for (const id of ids.slice(0, Math.max(0, ids.length - 200))) delete enviadas[id];
    fs.writeFileSync(ARQ_ENVIADAS, JSON.stringify(enviadas));
  } catch (e) { log(`WhatsApp: não guardou a mensagem enviada (${e.message})`); }
}
async function buscarEnviada(key) {
  const b64 = enviadas[key?.id];
  if (!b64) return undefined;
  log(`WhatsApp: um aparelho pediu reenvio da mensagem ${key.id}: reenviando`);
  return proto.Message.decode(Buffer.from(b64, 'base64'));
}

export function iniciarWhatsApp(aoChegar) {
  // Recupera o que chegou enquanto o Vigia estava fora (PC desligado, reinício): aceita mensagens desde a última
  // vez que ele esteve ligado (dados/whatsapp-visto.txt, gravado a cada 30 s), no máximo 18 h para trás.
  // As que chegaram ANTES de ligar viram "atrasadas": não são faladas uma a uma, entram num aviso único.
  const agoraS = Math.floor(Date.now() / 1000);
  const ARQ_VISTO = path.join(DADOS, 'whatsapp-visto.txt');
  let visto = 0;
  try { visto = Number(fs.readFileSync(ARQ_VISTO, 'utf8')) || 0; } catch {}
  const inicio = visto ? Math.max(visto - 120, agoraS - 18 * 3600) : agoraS - 180;
  const marcarVisto = () => { try { fs.writeFileSync(ARQ_VISTO, String(Math.floor(Date.now() / 1000))); } catch {} };
  marcarVisto(); setInterval(marcarVisto, 30_000).unref?.();
  const vistos = new Set();
  const nomesGrupo = {};
  const buffers = new Map(); // junta mensagens seguidas do mesmo chat (8 s)
  let tentativas = 0;

  async function nomeGrupo(sock, jid) {
    if (nomesGrupo[jid]) return nomesGrupo[jid];
    try { nomesGrupo[jid] = (await sock.groupMetadata(jid)).subject; } catch { nomesGrupo[jid] = 'um grupo'; }
    return nomesGrupo[jid];
  }

  function enfileirar(chave, dados, linha) {
    let b = buffers.get(chave);
    if (!b) { b = { ...dados, linhas: [], inicio: Date.now(), ids: new Set([chave]) }; buffers.set(chave, b); }
    for (const i of linha.ids || []) b.ids.add(i);
    b.linhas.push(linha);
    clearTimeout(b.t);
    // espera a pessoa parar de mandar (mensagens picadas viram um aviso só), mas no máximo 1 minuto
    // conversando com a pessoa agora? junta por pouco tempo (6 s) para a resposta chegar rápido
    const agrupar = conversaAtiva(chave) ? Math.min(6000, config.agruparMs) : config.agruparMs;
    const espera = Math.max(1000, Math.min(agrupar, b.inicio + 60_000 - Date.now()));
    b.t = setTimeout(() => {
      buffers.delete(chave);
      const texto = b.grupo ? b.linhas.map((l) => `${l.autor}: ${l.texto}`).join('\n') : b.linhas.map((l) => l.texto).join('\n');
      const de = b.grupo ? [...new Set(b.linhas.map((l) => l.autor))].slice(0, 3).join(', ') : b.de;
      aoChegar({ canal: 'whatsapp', jid: chave, de, grupo: b.grupo, texto, quantidade: b.linhas.length, msgIds: b.linhas.map((l) => l.msgId).filter(Boolean), ...(estaSilenciadaNoZap([...b.ids]) ? { silenciadaNoZap: true } : {}), ...(b.atrasada ? { atrasada: true } : {}) });
    }, espera);
  }

  async function conectar() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSAO);
    let version;
    try { ({ version } = await fetchLatestBaileysVersion()); } catch {}
    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      // só avisos e erros do WhatsApp, num arquivo à parte (para diagnosticar falhas de grupo/criptografia)
      logger: pino({ level: process.env.VIGIA_WA_LOG || 'warn' }, pino.destination({ dest: path.join(DADOS, 'whatsapp-erros.log'), sync: false })),
      getMessage: buscarEnviada,
      browser: Browsers.windows('Vigia'),
      markOnlineOnConnect: false,   // não aparece online: o celular continua recebendo notificação
      syncFullHistory: false,
      // recusa só o histórico COMPLETO. Os pacotes leves trazem o mapa telefone↔LID: sem eles a criptografia dos
      // grupos falha (mensagens de grupo sem aviso, áudio "Aguardando mensagem" no seu celular).
      // O histórico chega pelo evento messaging-history.set, que o Vigia não lê: não gera avisos.
      shouldSyncHistoryMessage: ({ syncType }) => syncType !== proto.HistorySync.HistorySyncType.FULL,
      generateHighQualityLinkPreview: false,
    });

    sock.ev.on('creds.update', saveCreds);
    // Única forma de envio: a resposta ditada e confirmada por voz (conversa.js).
    registrarEnvio(async (jid, texto) => { guardarEnviada(await sock.sendMessage(jid, { text: texto })); });
    // áudio de voz (o "de bolinha azul"): OGG/Opus mono, ptt = gravado na hora
    // encaminhar = o "forward" do WhatsApp: a mensagem chega com o selo "Encaminhada", igual ao feito no celular
    registrarEncaminhar(async (jid, originais) => {
      for (const m of originais) guardarEnviada(await sock.sendMessage(jid, { forward: m }));
    });
    registrarEnvioAudio(async (jid, ogg, segundos) => {
      // com a "onda sonora" calculada (as barrinhas do áudio de voz)
      const m = await sock.sendMessage(jid, { audio: ogg, mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: segundos, waveform: await calcularOnda(ogg) });
      guardarEnviada(m);
      return m;
    });
    meuJid = jidNormalizedUser(sock.user?.id || ""); sockAtual = sock;
    sock.ev.on('contacts.upsert', (lista) => { for (const c of lista) contatos[jidNormalizedUser(c.id)] = { ...contatos[jidNormalizedUser(c.id)], ...c }; salvarContatos(); });
    sock.ev.on('contacts.update', (lista) => { for (const c of lista) if (c.id) contatos[jidNormalizedUser(c.id)] = { ...contatos[jidNormalizedUser(c.id)], ...c }; salvarContatos(); });
    sock.ev.on('groups.update', (lista) => { for (const g of lista) if (g.id && g.subject) nomesGrupo[g.id] = g.subject; });
    // arquivar/desarquivar no celular (e a lista inicial ao conectar)
    const lerChats = (lista) => {
      for (const c of lista || []) {
        if (!c?.id) continue;
        if (typeof c.archived === 'boolean') marcarArquivada(c.id, c.archived);
        if ('muteEndTime' in c) marcarSilenciada(c.id, c.muteEndTime); // silenciou / tirou o silêncio no celular
      }
    };
    sock.ev.on('chats.upsert', lerChats);
    sock.ev.on('chats.update', lerChats);
    sock.ev.on('messaging-history.set', ({ chats }) => lerChats(chats));

    // Mensagens pendentes vêm em lotes de 100 e cada lote precisa ser PEDIDO. O Baileys só pede o primeiro:
    // se havia mais de 100 pendentes (noite com muitos grupos), o servidor fica esperando e NÃO entrega nada ao
    // vivo (só no próximo reinício). Aqui: continua pedindo lotes até o servidor avisar que acabou ("offline").
    let pendentesOk = false, lotes = 0;
    sock.ws.on('CB:ib,,offline', () => { pendentesOk = true; if (lotes) log(`WhatsApp: mensagens pendentes recebidas (${lotes + 1} lotes)`); });
    sock.ws.on('CB:ib,,offline_preview', () => {
      const pedirMais = setInterval(async () => {
        if (pendentesOk || lotes >= 40 || sockAtual !== sock) return clearInterval(pedirMais);
        lotes++;
        try { await sock.sendNode({ tag: 'ib', attrs: {}, content: [{ tag: 'offline_batch', attrs: { count: '100' } }] }); } catch {}
      }, 4000);
    });

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        qrTerminal.generate(qr, { small: true });
        await QRCode.toFile(QR_PNG, qr, { width: 420, margin: 2 });
        log(`WhatsApp: escaneie o QR code (Aparelhos conectados > Conectar aparelho). Imagem: ${QR_PNG}`);
        notificar('Vigia: conectar o WhatsApp', 'Abra o QR code que apareceu e escaneie em Aparelhos conectados.', true);
        exec(`start "" "${QR_PNG}"`, { windowsHide: true });
      }
      if (connection === 'open') {
        tentativas = 0;
        try { fs.unlinkSync(QR_PNG); } catch {}
        log(`WhatsApp: conectado como ${sock.user?.name || sock.user?.id}. Só leitura.`);
        // lista de grupos para o "envia mensagem para o grupo …"
        sock.groupFetchAllParticipating().then((g) => {
          for (const [id, m] of Object.entries(g || {})) if (m?.subject) { gruposTodos[id] = m.subject; nomesGrupo[id] = m.subject; }
          log(`WhatsApp: ${Object.keys(gruposTodos).length} grupos carregados para envio por voz.`);
        }).catch(() => {});
        // Lista de arquivadas: pede uma cópia completa só da coleção de configurações das conversas ("regular_low").
        // Na sincronização inicial o Baileys só libera o "arquivada" de conversas que vieram no histórico (que não baixamos),
        // então refazemos essa coleção do zero como sincronização normal; assim cada "arquivada" vira um chats.update.
        setTimeout(async () => {
          try {
            // regular_low = arquivadas; regular_high = silenciadas (refeitas do zero para virem todas)
            await state.keys.set({ 'app-state-sync-version': { regular_low: null, regular_high: null } });
            await sock.resyncAppState(['regular_low', 'regular_high'], false);
          } catch (e) { log(`WhatsApp: não consegui ler as arquivadas (${e.message})`); }
          setTimeout(() => {
            const nomes = [...arquivadas].map((id) => gruposTodos[id] || nomesGrupo[id] || contatos[id]?.name || contatos[id]?.notify || id.split('@')[0]);
            log(`WhatsApp: ${arquivadas.size} conversas arquivadas (sem aviso): ${nomes.join(' · ')}`);
            const sil = Object.keys(silenciadasZap).filter((id) => estaSilenciadaNoZap([id]));
            const nomesSil = sil.map((id) => gruposTodos[id] || nomesGrupo[id] || contatos[id]?.name || contatos[id]?.notify || id.split('@')[0]);
            log(`WhatsApp: ${sil.length} conversas silenciadas no WhatsApp (só na tela): ${nomesSil.join(' · ')}`);
          }, 3000);
        }, 6000);
      }
      if (connection === 'close') {
        const codigo = lastDisconnect?.error?.output?.statusCode;
        if (codigo === DisconnectReason.loggedOut) {
          log('WhatsApp: o aparelho foi desconectado no celular. Apague dados/whatsapp-sessao e rode de novo para gerar outro QR.');
          notificar('Vigia: WhatsApp desconectado', 'O aparelho foi removido no celular. Rode o Vigia de novo para escanear outro QR.', true);
          return;
        }
        if (codigo === DisconnectReason.connectionReplaced) {
          log('WhatsApp: outra sessão do Vigia assumiu a conexão. Esta foi encerrada.');
          return;
        }
        const espera = codigo === DisconnectReason.restartRequired ? 1 : Math.min(300, 3 * 2 ** Math.min(tentativas++, 7));
        log(`WhatsApp: conexão caiu (${codigo ?? 'sem código'}), reconectando em ${espera}s`);
        setTimeout(conectar, espera * 1000);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      // 'append' = mensagens entregues ao reconectar; o filtro de horário abaixo descarta as antigas.
      if (type !== 'notify' && type !== 'append') return;
      for (const msg of messages) {
        try {
          const jid = msg.key?.remoteJid;
          if (!jid) continue;
          if (isJidStatusBroadcast(jid) || isJidBroadcast(jid) || isJidNewsletter(jid)) continue;
          const idsChat = [jid, msg.key.remoteJidAlt].filter(Boolean).map((j) => jidNormalizedUser(j));
          if (msg.key.fromMe) { // você mandou mensagem (celular, PC ou por voz)
            if (!isJidGroup(jid)) respondeu(idsChat);
            marcarConversa(idsChat); // está conversando: as respostas dessa pessoa são avisadas na hora
            continue;
          }
          if (estaArquivada(idsChat)) continue; // conversa arquivada: nenhum aviso
          if (Number(msg.messageTimestamp || 0) < inicio) continue;
          if (vistos.has(msg.key.id)) continue;
          vistos.add(msg.key.id); if (vistos.size > 2000) vistos.delete(vistos.values().next().value);
          let texto = descrever(msg.message);
          if (!texto) {
            // não dá para ler: mostra o motivo no log (ex.: falha de criptografia do grupo = stub 2 "CIPHERTEXT")
            if (msg.messageStubType || !msg.message) log(`WhatsApp: mensagem ilegível em ${jid} (stub ${msg.messageStubType || '-'} ${(msg.messageStubParameters || []).join(' ')})`);
            continue;
          }
          texto = await transcreverAudio(msg, texto);
          guardarRecebida(jid, msg); // o original, para "encaminhe essa mensagem" (com o selo Encaminhada)
          const atrasada = Number(msg.messageTimestamp || 0) < agoraS - 30; // chegou antes do Vigia ligar
          if (atrasada) log(`WhatsApp: recuperada mensagem de quando o Vigia estava fora (${new Date(Number(msg.messageTimestamp) * 1000).toLocaleTimeString('pt-BR')})`);
          if (isJidGroup(jid)) {
            const autorJid = msg.key.participantAlt || msg.key.participant || '';
            enfileirar(jid, { grupo: await nomeGrupo(sock, jid), atrasada }, { autor: nomeDe(autorJid, msg.pushName), texto, msgId: msg.key.id, ids: idsChat });
          } else {
            const remet = msg.key.remoteJidAlt || jid;
            if (msg.pushName) { const id = jidNormalizedUser(remet); contatos[id] = { ...contatos[id], notify: msg.pushName }; salvarContatos(); }
            const nome = nomeDe(remet, msg.pushName);
            recebeu(idsChat, nome);
            enfileirar(jid, { de: nome, atrasada }, { texto, msgId: msg.key.id, ids: idsChat });
          }
        } catch (e) { log(`WhatsApp: erro ao ler mensagem (${e.message})`); }
      }
    });
  }

  conectar().catch((e) => log(`WhatsApp: falha ao iniciar (${e.message})`));
}
