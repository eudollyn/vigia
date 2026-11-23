// Leitor de WhatsApp (conexão tipo WhatsApp Web, via Baileys). SOMENTE LEITURA:
// não envia mensagens, não marca como lido e não aparece "online".
import makeWASocket, {
  useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, Browsers,
  normalizeMessageContent, getContentType, isJidGroup, isJidBroadcast, isJidStatusBroadcast, isJidNewsletter, jidNormalizedUser,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import qrTerminal from 'qrcode-terminal';
import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DADOS } from './config.js';
import { log, notificar, registrarEnvio } from './avisos.js';
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

// ---------- áudios recebidos: baixa e transcreve com o Gemini ----------
async function transcreverAudio(msg, descricao) {
  const m = normalizeMessageContent(msg.message);
  const audio = m?.audioMessage;
  if (!audio) return descricao;
  const seg = Math.round(audio.seconds || 0);
  if (seg > 300) return descricao; // áudios de mais de 5 min: só avisa
  try {
    const buf = await downloadMediaMessage(msg, 'buffer', {});
    const tipo = String(audio.mimetype || 'audio/ogg').split(';')[0];
    const fala = await transcrever(buf, [], tipo);
    if (fala) { log(`WhatsApp: áudio de ${seg}s transcrito`); return `[mandou um áudio de ${seg} segundos dizendo:] ${fala}`; }
  } catch (e) { log(`WhatsApp: não consegui transcrever o áudio (${e.message})`); }
  return descricao;
}

// ---------- busca de contato/grupo pelo nome falado ("envia mensagem para Thiago") ----------
const gruposTodos = {}; // jid → nome do grupo
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
function lev(a, b) { // distância de edição (erros de transcrição: "tiago" ~ "thiago")
  const m = a.length, n = b.length; if (!m || !n) return m || n;
  let ant = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { const at = [i]; for (let j = 1; j <= n; j++) at[j] = Math.min(ant[j] + 1, at[j - 1] + 1, ant[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); ant = at; }
  return ant[n];
}
// "chave de som" em português: Thiago / Tiago → "tiago"; Thalyta / Talita → "talita"; Luíz / Luis → "luis"
const som = (w) => w.replace(/ph/g, 'f').replace(/h/g, '').replace(/y/g, 'i').replace(/w/g, 'v').replace(/k/g, 'c')
  .replace(/qu/g, 'c').replace(/z/g, 's').replace(/(.)\1+/g, '$1');
const parecido = (a, b) => a === b || som(a) === som(b) ||
  (a.length >= 3 && b.length >= 3 && 1 - lev(som(a), som(b)) / Math.max(som(a).length, som(b).length) >= 0.75);
function pontuar(q, nome) {
  if (!q || !nome) return 0;
  if (q === nome) return 100;
  const pq = q.split(' '), pn = nome.split(' ');
  const extra = Math.max(0, pn.length - pq.length) * 3; // "Thiago" vence "Thiago Souza Comercial"
  if (som(q) === som(nome)) return 95;
  if (nome.startsWith(q + ' ') || pn[0] === q) return 85 - extra;
  if (pq.every((w) => pn.includes(w))) return 72 - extra;
  if (pq.every((w) => pn.some((x) => som(x) === som(w)))) return 68 - extra;
  if (pq.every((w) => pn.some((x) => parecido(w, x)))) return 55 - extra;
  if (pq.length === 1 && q.length >= 4 && pn.some((x) => x.startsWith(q))) return 45 - extra;
  return 0;
}
/** Nomes conhecidos (para ajudar a transcrição a acertar a grafia). */
export function nomesConhecidos() {
  return [...new Set([...Object.values(contatos).map((c) => c.name || c.notify), ...Object.values(gruposTodos)].filter(Boolean))];
}
/** → { tipo: 'ok', destino } | { tipo: 'varios', opcoes: [destino...] } | { tipo: 'nenhum' } */
export function buscarDestino(nomeFalado) {
  const q = norm(nomeFalado).replace(/^(o|a|os|as|grupo|grupo do|grupo da|contato)\s+/, '');
  if (!q) return { tipo: 'nenhum' };
  const porNome = new Map(); // um destino por nome (o mesmo contato pode ter id de telefone e @lid)
  for (const [jid, c] of Object.entries(contatos)) {
    const nome = c.name || c.notify; if (!nome) continue;
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

export function iniciarWhatsApp(aoChegar) {
  // aceita mensagens de até 3 min antes de ligar (cobre reinícios rápidos) e ignora repetidas
  const inicio = Math.floor(Date.now() / 1000) - 180;
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
    if (!b) { b = { ...dados, linhas: [] }; buffers.set(chave, b); }
    b.linhas.push(linha);
    clearTimeout(b.t);
    b.t = setTimeout(() => {
      buffers.delete(chave);
      const texto = b.grupo ? b.linhas.map((l) => `${l.autor}: ${l.texto}`).join('\n') : b.linhas.map((l) => l.texto).join('\n');
      const de = b.grupo ? [...new Set(b.linhas.map((l) => l.autor))].slice(0, 3).join(', ') : b.de;
      aoChegar({ canal: 'whatsapp', jid: chave, de, grupo: b.grupo, texto, quantidade: b.linhas.length });
    }, 4000);
  }

  async function conectar() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSAO);
    let version;
    try { ({ version } = await fetchLatestBaileysVersion()); } catch {}
    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: Browsers.windows('Vigia'),
      markOnlineOnConnect: false,   // não aparece online: o celular continua recebendo notificação
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      generateHighQualityLinkPreview: false,
    });

    sock.ev.on('creds.update', saveCreds);
    // Única forma de envio: a resposta ditada e confirmada por voz (conversa.js).
    registrarEnvio(async (jid, texto) => { await sock.sendMessage(jid, { text: texto }); });
    sock.ev.on('contacts.upsert', (lista) => { for (const c of lista) contatos[jidNormalizedUser(c.id)] = { ...contatos[jidNormalizedUser(c.id)], ...c }; salvarContatos(); });
    sock.ev.on('contacts.update', (lista) => { for (const c of lista) if (c.id) contatos[jidNormalizedUser(c.id)] = { ...contatos[jidNormalizedUser(c.id)], ...c }; salvarContatos(); });
    sock.ev.on('groups.update', (lista) => { for (const g of lista) if (g.id && g.subject) nomesGrupo[g.id] = g.subject; });

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
          if (msg.key.fromMe) { if (!isJidGroup(jid)) respondeu(idsChat); continue; } // você respondeu (celular/PC)
          if (Number(msg.messageTimestamp || 0) < inicio) continue;
          if (vistos.has(msg.key.id)) continue;
          vistos.add(msg.key.id); if (vistos.size > 2000) vistos.delete(vistos.values().next().value);
          let texto = descrever(msg.message);
          if (!texto) continue;
          texto = await transcreverAudio(msg, texto);
          if (isJidGroup(jid)) {
            const autorJid = msg.key.participantAlt || msg.key.participant || '';
            enfileirar(jid, { grupo: await nomeGrupo(sock, jid) }, { autor: nomeDe(autorJid, msg.pushName), texto });
          } else {
            const remet = msg.key.remoteJidAlt || jid;
            if (msg.pushName) { const id = jidNormalizedUser(remet); contatos[id] = { ...contatos[id], notify: msg.pushName }; salvarContatos(); }
            const nome = nomeDe(remet, msg.pushName);
            recebeu(idsChat, nome);
            enfileirar(jid, { de: nome }, { texto });
          }
        } catch (e) { log(`WhatsApp: erro ao ler mensagem (${e.message})`); }
      }
    });
  }

  conectar().catch((e) => log(`WhatsApp: falha ao iniciar (${e.message})`));
}
