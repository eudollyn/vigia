// Vigia · github.com/eudollyn/vigia · AGPL-3.0-or-later · VGA-EUD-2026 (manter este crédito em cópias e versões modificadas)
// Banco local (SQLite embutido no Node, sem dependência nova) com TODAS as mensagens do WhatsApp que o Vigia vê:
// enviadas e recebidas, conversas individuais e grupos, arquivadas, ao vivo e o histórico que o WhatsApp entregar.
// Regras: nunca apaga mensagem (apagar para todos e edição viram marcas), não duplica (msg_id + de_mim),
// não registra conteúdo em log. O arquivo fica em dados/ (fora do Git).
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  normalizeMessageContent, getContentType, isJidGroup, isJidBroadcast, isJidStatusBroadcast, isJidNewsletter,
  jidNormalizedUser, proto,
} from '@whiskeysockets/baileys';

export const FUSO = 'America/Sao_Paulo';
export const normalizar = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '').replace(/\s+/g, ' ').trim();
const normalizarNome = (s) => normalizar(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const agoraS = () => Math.floor(Date.now() / 1000);
const paraNumero = (v) => {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber();
  if (typeof v === 'object' && 'low' in v) return (v.high >>> 0) * 2 ** 32 + (v.low >>> 0);
  return Number(v) || 0;
};
const normJid = (j) => { try { return j ? jidNormalizedUser(j) : ''; } catch { return ''; } };
export const ehGrupo = (j) => String(j || '').endsWith('@g.us');
export const ehPn = (j) => String(j || '').endsWith('@s.whatsapp.net');
export const ehLid = (j) => String(j || '').endsWith('@lid');
export const telefoneDoJid = (j) => (ehPn(j) ? '+' + String(j).split('@')[0].split(':')[0] : null);

// ---------- datas em America/Sao_Paulo ----------
const fmtData = new Intl.DateTimeFormat('en-CA', {
  timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23', timeZoneName: 'longOffset',
});
function partesSP(ms) {
  const p = Object.fromEntries(fmtData.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const off = (p.timeZoneName || 'GMT-03:00').replace('GMT', '') || '+00:00';
  return { ...p, off: off === '' ? '+00:00' : off };
}
/** segundos UTC → "2026-11-26T07:37:31-03:00" (horário de Brasília) */
export function isoSP(seg) {
  if (!seg) return null;
  const p = partesSP(seg * 1000);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${p.off}`;
}
/** segundos UTC → "26/11/2026 07:37" */
export function legivelSP(seg) {
  if (!seg) return null;
  const p = partesSP(seg * 1000);
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}
/**
 * Data de entrada → segundos UTC. Aceita ISO com fuso (2026-11-25T08:00:00-03:00), data e hora sem fuso
 * (lida em America/Sao_Paulo) ou só a data (fim=true → 23:59:59 daquele dia em São Paulo).
 */
export function lerDataEntrada(valor, fim = false) {
  if (valor === undefined || valor === null || valor === '') return null;
  if (typeof valor !== 'string') throw new Error('Datas devem ser texto, ex.: 2026-11-25 ou 2026-11-25T08:00:00-03:00.');
  const v = valor.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) return localSP(+m[1], +m[2], +m[3], fim ? 23 : 0, fim ? 59 : 0, fim ? 59 : 0);
  m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(v);
  if (m) return localSP(+m[1], +m[2], +m[3], +m[4], +m[5], m[6] ? +m[6] : (fim ? 59 : 0));
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(v)) {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return Math.floor(t / 1000);
  }
  const e = new Error('Data inválida. Use 2026-11-25, 2026-11-25 08:00 (horário de Brasília) ou ISO com fuso.');
  e.validacao = true;
  throw e;
}
function localSP(a, mes, d, h, mi, s) {
  const chute = Date.UTC(a, mes - 1, d, h, mi, s);
  if (new Date(chute).getUTCDate() !== d || mes < 1 || mes > 12 || h > 23 || mi > 59 || s > 59) throw new Error('Data inválida.');
  // descobre o deslocamento de São Paulo naquele instante (hoje -03:00; o código não supõe isso fixo)
  const off = partesSP(chute).off;
  const [, sinal, hh, mm] = /([+-])(\d{2}):(\d{2})/.exec(off) || [, '-', '03', '00'];
  const minutos = (sinal === '-' ? -1 : 1) * (+hh * 60 + +mm);
  return Math.floor((chute - minutos * 60_000) / 1000);
}

// ---------- telefone em qualquer formato ----------
/** "+55 (31) 3050-6761", "31 3050 6761", "5531..." → lista de números possíveis (só dígitos, com país) */
export function variantesTelefone(texto) {
  let d = String(texto || '').replace(/\D/g, '');
  if (!d) return [];
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0') && (d.length === 11 || d.length === 12)) d = d.slice(1); // 031 3050-6761
  if (d.length === 10 || d.length === 11) d = '55' + d;
  if (d.length < 10 || d.length > 15) return [];
  const r = new Set([d]);
  // celular brasileiro com/sem o 9 extra
  if (d.startsWith('55') && d.length === 13 && d[4] === '9') r.add(d.slice(0, 4) + d.slice(5));
  if (d.startsWith('55') && d.length === 12 && /[6-9]/.test(d[4])) r.add(d.slice(0, 4) + '9' + d.slice(4));
  return [...r];
}

// ---------- extração do conteúdo ----------
const IGNORAR = new Set(['protocolMessage', 'reactionMessage', 'encReactionMessage', 'senderKeyDistributionMessage',
  'messageContextInfo', 'pollUpdateMessage', 'keepInChatMessage', 'pinInChatMessage', 'encEventResponseMessage',
  'callLogMesssage', 'callLogMessage', 'botInvokeMessage', 'peerDataOperationRequestMessage', 'peerDataOperationRequestResponseMessage',
  'deviceSentMessage', 'requestPhoneNumberMessage']);
const textoDe = (m) => {
  if (!m) return '';
  const t = getContentType(m);
  const c = m[t];
  if (t === 'conversation') return c || '';
  return c?.text || c?.caption || c?.contentText || c?.hydratedTemplate?.hydratedContentText || c?.body?.text
    || c?.description || c?.selectedDisplayText || c?.name || c?.displayName || c?.fileName || '';
};

/**
 * Mensagem do Baileys → registro do banco (ou null se for evento sem conteúdo: reação, recibo, chave…).
 * ctx.canonico(jid) devolve o id canônico da conversa/pessoa.
 */
export function extrairMensagem(msg, ctx) {
  const key = msg?.key;
  const remoto = normJid(key?.remoteJid);
  if (!remoto || !key?.id) return null;
  if (isJidStatusBroadcast(remoto) || isJidBroadcast(remoto) || isJidNewsletter(remoto)) return null;
  const bruto = msg.message;
  if (!bruto) return null; // stubs do sistema (entrou no grupo, criptografia…) e mensagens ilegíveis
  const unica = !!(bruto.viewOnceMessage || bruto.viewOnceMessageV2 || bruto.viewOnceMessageV2Extension);
  const m = normalizeMessageContent(bruto);
  const tipoWa = m && getContentType(m);
  if (!tipoWa || IGNORAR.has(tipoWa)) return null;
  const c = m[tipoWa] || {};
  const ctxInfo = c.contextInfo || m.messageContextInfo || {};
  let tipo = 'outro', texto = '', anexo = null;
  const midia = (tipoAnexo) => ({
    tipo: tipoAnexo, mimetype: c.mimetype || null, nome: c.fileName || c.title || null,
    tamanho_bytes: paraNumero(c.fileLength) || null, segundos: c.seconds || null, paginas: c.pageCount || null,
    largura: c.width || null, altura: c.height || null, voz: tipoWa === 'audioMessage' ? !!c.ptt : undefined,
    baixavel: !unica && !!(c.mediaKey && (c.directPath || c.url)),
  });
  switch (tipoWa) {
    case 'conversation': case 'extendedTextMessage': tipo = 'texto'; texto = textoDe(m); break;
    case 'imageMessage': tipo = 'imagem'; texto = c.caption || ''; anexo = midia('imagem'); break;
    case 'videoMessage': case 'ptvMessage': tipo = 'video'; texto = c.caption || ''; anexo = midia('video'); break;
    case 'audioMessage': tipo = 'audio'; anexo = midia('audio'); break;
    case 'documentMessage': {
      tipo = 'documento'; texto = c.caption || ''; anexo = midia(/pdf/i.test(c.mimetype || '') || /\.pdf$/i.test(c.fileName || '') ? 'pdf' : 'documento');
      break;
    }
    case 'stickerMessage': tipo = 'figurinha'; anexo = midia('figurinha'); break;
    case 'locationMessage': case 'liveLocationMessage':
      tipo = 'localizacao'; texto = [c.name, c.address].filter(Boolean).join(' - ');
      anexo = { tipo: 'localizacao', latitude: c.degreesLatitude ?? null, longitude: c.degreesLongitude ?? null, baixavel: false };
      break;
    case 'contactMessage': tipo = 'contato'; texto = c.displayName || ''; break;
    case 'contactsArrayMessage': tipo = 'contato'; texto = (c.contacts || []).map((x) => x.displayName).filter(Boolean).join(', '); break;
    case 'pollCreationMessage': case 'pollCreationMessageV2': case 'pollCreationMessageV3':
      tipo = 'enquete'; texto = [c.name, ...(c.options || []).map((o) => '• ' + o.optionName)].filter(Boolean).join('\n'); break;
    case 'eventMessage': tipo = 'evento'; texto = [c.name, c.description].filter(Boolean).join('\n'); break;
    case 'buttonsMessage': case 'templateMessage': case 'interactiveMessage': case 'listMessage':
      tipo = 'interativa'; texto = textoDe(m); break;
    case 'buttonsResponseMessage': case 'listResponseMessage': case 'templateButtonReplyMessage': case 'interactiveResponseMessage':
      tipo = 'resposta_botao'; texto = textoDe(m) || c.title || ''; break;
    default: tipo = 'outro'; texto = textoDe(m);
  }
  if (unica) { texto = ''; anexo = anexo ? { tipo: anexo.tipo, visualizacao_unica: true, baixavel: false } : null; }
  const deMim = !!key.fromMe;
  const grupo = ehGrupo(remoto);
  const alt = normJid(key.remoteJidAlt);
  const conversa = ctx.canonico(grupo ? remoto : (ehPn(alt) ? alt : remoto), ehPn(alt) ? remoto : alt);
  let remetente = null;
  if (!deMim) {
    if (grupo) {
      const p = normJid(key.participant), pa = normJid(key.participantAlt);
      remetente = p || pa ? ctx.canonico(ehPn(pa) ? pa : (p || pa), ehPn(pa) ? p : pa) : null;
    } else remetente = conversa;
  }
  const citadaMsg = ctxInfo.quotedMessage ? normalizeMessageContent(ctxInfo.quotedMessage) : null;
  const nomesBusca = [texto, anexo?.nome].filter(Boolean).join(' \n ');
  let original = null;
  if (!unica) { try { original = Buffer.from(proto.WebMessageInfo.encode(msg).finish()); } catch { original = null; } }
  return {
    msg_id: String(key.id), de_mim: deMim ? 1 : 0, conversa, jid_original: remoto, jid_alternativo: alt || null,
    grupo: grupo ? 1 : 0, remetente, remetente_nome: deMim ? null : (msg.pushName || msg.verifiedBizName || null),
    ts: paraNumero(msg.messageTimestamp) || agoraS(), tipo, texto: texto || null, texto_norm: normalizar(nomesBusca) || null,
    anexo: anexo ? JSON.stringify(anexo) : null,
    citada_id: ctxInfo.stanzaId || null, citada_texto: citadaMsg ? (textoDe(citadaMsg) || `[${getContentType(citadaMsg) || 'mensagem'}]`).slice(0, 500) : null,
    citada_remetente: ctxInfo.participant ? ctx.canonico(normJid(ctxInfo.participant)) : null,
    encaminhada: ctxInfo.isForwarded || paraNumero(ctxInfo.forwardingScore) > 0 ? 1 : 0,
    temporaria: bruto.ephemeralMessage || paraNumero(ctxInfo.expiration) > 0 ? 1 : 0,
    visualizacao_unica: unica ? 1 : 0, editada: bruto.editedMessage ? 1 : 0,
    status_envio: deMim && msg.status !== undefined && msg.status !== null ? Number(msg.status) : null,
    original,
  };
}

// ---------- o banco ----------
const ESQUEMA = `
CREATE TABLE IF NOT EXISTS mensagens (
  rid INTEGER PRIMARY KEY,
  msg_id TEXT NOT NULL, de_mim INTEGER NOT NULL,
  conversa TEXT NOT NULL, jid_original TEXT NOT NULL, jid_alternativo TEXT, grupo INTEGER NOT NULL DEFAULT 0,
  remetente TEXT, remetente_nome TEXT, ts INTEGER NOT NULL, tipo TEXT NOT NULL,
  texto TEXT, texto_norm TEXT, anexo TEXT,
  citada_id TEXT, citada_texto TEXT, citada_remetente TEXT,
  encaminhada INTEGER NOT NULL DEFAULT 0, temporaria INTEGER NOT NULL DEFAULT 0, visualizacao_unica INTEGER NOT NULL DEFAULT 0,
  editada INTEGER NOT NULL DEFAULT 0, apagada INTEGER NOT NULL DEFAULT 0, horario_aproximado INTEGER NOT NULL DEFAULT 0,
  status_envio INTEGER, origem TEXT NOT NULL, original BLOB, gravada_em INTEGER NOT NULL,
  UNIQUE (msg_id, de_mim)
);
CREATE INDEX IF NOT EXISTS ix_msg_conversa_ts ON mensagens (conversa, ts, rid);
CREATE INDEX IF NOT EXISTS ix_msg_ts ON mensagens (ts, rid);
CREATE INDEX IF NOT EXISTS ix_msg_remetente_ts ON mensagens (remetente, ts);
CREATE INDEX IF NOT EXISTS ix_msg_tipo_ts ON mensagens (tipo, ts);
CREATE VIRTUAL TABLE IF NOT EXISTS mensagens_busca USING fts5 (texto_norm, content='mensagens', content_rowid='rid', tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS mensagens_busca_ai AFTER INSERT ON mensagens BEGIN
  INSERT INTO mensagens_busca (rowid, texto_norm) VALUES (new.rid, new.texto_norm); END;
CREATE TRIGGER IF NOT EXISTS mensagens_busca_au AFTER UPDATE OF texto_norm ON mensagens BEGIN
  INSERT INTO mensagens_busca (mensagens_busca, rowid, texto_norm) VALUES ('delete', old.rid, old.texto_norm);
  INSERT INTO mensagens_busca (rowid, texto_norm) VALUES (new.rid, new.texto_norm); END;
CREATE TABLE IF NOT EXISTS conversas (
  id TEXT PRIMARY KEY, tipo TEXT NOT NULL, nome TEXT, nome_norm TEXT,
  arquivada INTEGER, nao_lidas INTEGER, silenciada_ate INTEGER, fixada INTEGER,
  participantes INTEGER, criada_ts INTEGER, ultima_atividade_ts INTEGER, atualizada_em INTEGER
);
CREATE TABLE IF NOT EXISTS contatos (
  jid TEXT PRIMARY KEY, nome TEXT, notify TEXT, verificado TEXT, busca_norm TEXT, atualizado_em INTEGER
);
CREATE INDEX IF NOT EXISTS ix_contatos_busca ON contatos (busca_norm);
CREATE TABLE IF NOT EXISTS aliases (jid TEXT PRIMARY KEY, canonico TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_aliases_canonico ON aliases (canonico);
CREATE TABLE IF NOT EXISTS estado (chave TEXT PRIMARY KEY, valor TEXT);
CREATE TABLE IF NOT EXISTS sincronizacoes (
  id INTEGER PRIMARY KEY, conversa TEXT NOT NULL, pedida_em INTEGER NOT NULL, quantidade INTEGER,
  recebidas INTEGER, novas INTEGER, situacao TEXT
);
`;

const ORIGENS = ['ao_vivo', 'historico_whatsapp', 'cache_antigo', 'aviso_legado', 'envio_vigia'];

export class BancoWhatsApp {
  /** arquivo = caminho do .db (ou ':memory:'); mapa = { pnDoLid(lidUser), lidDoPn(pnUser) } (opcional) */
  constructor(arquivo, mapa = {}) {
    if (arquivo !== ':memory:') fs.mkdirSync(path.dirname(arquivo), { recursive: true });
    this.db = new DatabaseSync(arquivo);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;');
    this.db.exec(ESQUEMA);
    this.mapa = mapa;
    this.cacheCanon = new Map();
    const p = (sql) => this.db.prepare(sql);
    this.sql = {
      inserir: p(`INSERT INTO mensagens (msg_id, de_mim, conversa, jid_original, jid_alternativo, grupo, remetente, remetente_nome, ts, tipo,
          texto, texto_norm, anexo, citada_id, citada_texto, citada_remetente, encaminhada, temporaria, visualizacao_unica, editada,
          horario_aproximado, status_envio, origem, original, gravada_em)
        VALUES (:msg_id, :de_mim, :conversa, :jid_original, :jid_alternativo, :grupo, :remetente, :remetente_nome, :ts, :tipo,
          :texto, :texto_norm, :anexo, :citada_id, :citada_texto, :citada_remetente, :encaminhada, :temporaria, :visualizacao_unica, :editada,
          :horario_aproximado, :status_envio, :origem, :original, :gravada_em)
        ON CONFLICT (msg_id, de_mim) DO UPDATE SET
          jid_alternativo = COALESCE(mensagens.jid_alternativo, excluded.jid_alternativo),
          remetente = COALESCE(mensagens.remetente, excluded.remetente),
          remetente_nome = COALESCE(mensagens.remetente_nome, excluded.remetente_nome),
          texto = COALESCE(mensagens.texto, excluded.texto),
          texto_norm = COALESCE(mensagens.texto_norm, excluded.texto_norm),
          anexo = COALESCE(mensagens.anexo, excluded.anexo),
          citada_id = COALESCE(mensagens.citada_id, excluded.citada_id),
          citada_texto = COALESCE(mensagens.citada_texto, excluded.citada_texto),
          original = COALESCE(mensagens.original, excluded.original),
          status_envio = COALESCE(excluded.status_envio, mensagens.status_envio),
          horario_aproximado = MIN(mensagens.horario_aproximado, excluded.horario_aproximado),
          ts = CASE WHEN mensagens.horario_aproximado = 1 AND excluded.horario_aproximado = 0 THEN excluded.ts ELSE mensagens.ts END`),
      existe: p('SELECT rid FROM mensagens WHERE msg_id = ? AND de_mim = ?'),
      estadoGet: p('SELECT valor FROM estado WHERE chave = ?'),
      estadoSet: p('INSERT INTO estado (chave, valor) VALUES (?, ?) ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor'),
      alias: p('SELECT canonico FROM aliases WHERE jid = ?'),
      aliasSet: p('INSERT INTO aliases (jid, canonico) VALUES (?, ?) ON CONFLICT (jid) DO UPDATE SET canonico = excluded.canonico'),
    };
    if (!this.estado('criado_em')) this.definirEstado('criado_em', String(agoraS()));
  }

  fechar() { try { this.db.close(); } catch {} }
  estado(chave) { return this.sql.estadoGet.get(chave)?.valor ?? null; }
  definirEstado(chave, valor) { this.sql.estadoSet.run(chave, valor === null || valor === undefined ? null : String(valor)); }
  transacao(fn) {
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { try { this.db.exec('ROLLBACK'); } catch {} throw e; }
  }

  // ----- identidade: o mesmo contato aparece como telefone (@s.whatsapp.net) e como LID (@lid) -----
  /** id canônico: grupo → ele mesmo; telefone → ele mesmo; LID → o telefone, se o mapa souber. alt = o outro id, se veio junto. */
  canonico(jid, alt) {
    const j = normJid(jid);
    if (!j) return j;
    if (ehGrupo(j) || ehPn(j)) {
      const a = normJid(alt);
      if (ehPn(j) && ehLid(a)) this.registrarAlias(a, j);
      return j;
    }
    if (ehLid(j)) {
      const a = normJid(alt);
      if (ehPn(a)) { this.registrarAlias(j, a); return a; }
      if (this.cacheCanon.has(j)) return this.cacheCanon.get(j);
      let c = this.sql.alias.get(j)?.canonico;
      if (!c && this.mapa.pnDoLid) {
        const pn = this.mapa.pnDoLid(j.split('@')[0]);
        if (pn && /^\d{8,15}$/.test(pn)) { c = pn + '@s.whatsapp.net'; this.registrarAlias(j, c); }
      }
      c ||= j;
      this.cacheCanon.set(j, c);
      return c;
    }
    return j;
  }
  /** Aprendeu que LID x = telefone y: junta tudo que estava separado sob o LID. */
  registrarAlias(lid, pn) {
    const l = normJid(lid), p = normJid(pn);
    if (!ehLid(l) || !ehPn(p)) return;
    if (this.cacheCanon.get(l) === p) return;
    const atual = this.sql.alias.get(l)?.canonico;
    this.cacheCanon.set(l, p);
    if (atual === p) return;
    this.sql.aliasSet.run(l, p);
    this.db.prepare('UPDATE mensagens SET conversa = ? WHERE conversa = ?').run(p, l);
    this.db.prepare('UPDATE mensagens SET remetente = ? WHERE remetente = ?').run(p, l);
    const velha = this.db.prepare('SELECT * FROM conversas WHERE id = ?').get(l);
    if (velha) {
      this.gravarConversa({ ...velha, id: p, nome: velha.nome });
      this.db.prepare('DELETE FROM conversas WHERE id = ?').run(l); // só o cadastro duplicado; as mensagens ficam
    }
  }
  /** Todos os ids conhecidos de uma pessoa/conversa canônica (para buscar também pelo LID sem mapa). */
  idsDe(canon) {
    const r = new Set([canon]);
    for (const x of this.db.prepare('SELECT jid FROM aliases WHERE canonico = ?').all(canon)) r.add(x.jid);
    if (ehPn(canon) && this.mapa.lidDoPn) {
      const lid = this.mapa.lidDoPn(canon.split('@')[0]);
      if (lid && /^\d+$/.test(lid)) r.add(lid + '@lid');
    }
    return [...r];
  }

  // ----- gravação -----
  /** msg do Baileys → grava. origem: ao_vivo | historico_whatsapp | cache_antigo | envio_vigia. → 'nova' | 'existente' | null */
  gravarMensagem(msg, origem = 'ao_vivo') {
    const r = extrairMensagem(msg, { canonico: (j, a) => this.canonico(j, a) });
    if (!r) return null;
    return this.gravarRegistro(r, origem);
  }
  /** Edição e "apagar para todos" chegam como protocolMessage: atualiza a original (que continua no banco). */
  processarProtocolo(msg) {
    const p = normalizeMessageContent(msg?.message)?.protocolMessage;
    if (!p?.key?.id) return false;
    const T = proto.Message.ProtocolMessage.Type;
    if (p.type === T.REVOKE) { this.marcarApagada(p.key.id); return true; }
    if (p.type === T.MESSAGE_EDIT && p.editedMessage) { this.marcarEditada(p.key.id, !!msg.key?.fromMe, p.editedMessage); return true; }
    return false;
  }
  gravarRegistro(r, origem) {
    const ja = this.sql.existe.get(r.msg_id, r.de_mim);
    this.sql.inserir.run({ horario_aproximado: 0, status_envio: null, ...r, origem, gravada_em: agoraS() });
    if (!ja && origem === 'ao_vivo' && !this.estado('gravando_desde')) this.definirEstado('gravando_desde', String(agoraS()));
    if (r.remetente && r.remetente_nome && !r.de_mim) this.gravarContato({ jid: r.remetente, notify: r.remetente_nome }, true);
    this.garantirConversa(r.conversa, r.grupo ? 'grupo' : 'individual', r.ts);
    return ja ? 'existente' : 'nova';
  }
  gravarMuitas(msgs, origem) {
    let novas = 0, total = 0;
    this.transacao(() => {
      for (const m of msgs || []) {
        try { const r = this.gravarMensagem(m, origem); if (r) total++; if (r === 'nova') novas++; } catch {}
      }
    });
    return { novas, total };
  }
  garantirConversa(id, tipo, ts) {
    this.db.prepare(`INSERT INTO conversas (id, tipo, ultima_atividade_ts, atualizada_em) VALUES (?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET ultima_atividade_ts = MAX(COALESCE(conversas.ultima_atividade_ts, 0), excluded.ultima_atividade_ts)`)
      .run(id, tipo, ts || null, agoraS());
  }
  /** c = { id, tipo?, nome?, arquivada?, nao_lidas?, silenciada_ate?, fixada?, participantes?, criada_ts?, ultima_atividade_ts? } */
  gravarConversa(c) {
    const id = this.canonico(c.id);
    if (!id) return;
    const tipo = c.tipo || (ehGrupo(id) ? 'grupo' : 'individual');
    const v = (x) => (x === undefined ? null : x);
    this.db.prepare(`INSERT INTO conversas (id, tipo, nome, nome_norm, arquivada, nao_lidas, silenciada_ate, fixada, participantes, criada_ts, ultima_atividade_ts, atualizada_em)
      VALUES (:id, :tipo, :nome, :nome_norm, :arquivada, :nao_lidas, :silenciada_ate, :fixada, :participantes, :criada_ts, :ultima, :agora)
      ON CONFLICT (id) DO UPDATE SET
        nome = COALESCE(excluded.nome, conversas.nome), nome_norm = COALESCE(excluded.nome_norm, conversas.nome_norm),
        arquivada = COALESCE(excluded.arquivada, conversas.arquivada), nao_lidas = COALESCE(excluded.nao_lidas, conversas.nao_lidas),
        silenciada_ate = CASE WHEN :mexeu_silencio THEN excluded.silenciada_ate ELSE conversas.silenciada_ate END,
        fixada = COALESCE(excluded.fixada, conversas.fixada), participantes = COALESCE(excluded.participantes, conversas.participantes),
        criada_ts = COALESCE(excluded.criada_ts, conversas.criada_ts),
        ultima_atividade_ts = MAX(COALESCE(conversas.ultima_atividade_ts, 0), COALESCE(excluded.ultima_atividade_ts, 0)),
        atualizada_em = excluded.atualizada_em`).run({
      id, tipo, nome: v(c.nome), nome_norm: c.nome ? normalizarNome(c.nome) : null,
      arquivada: typeof c.arquivada === 'boolean' ? (c.arquivada ? 1 : 0) : v(c.arquivada),
      nao_lidas: v(c.nao_lidas), silenciada_ate: v(c.silenciada_ate), mexeu_silencio: 'silenciada_ate' in c ? 1 : 0,
      fixada: typeof c.fixada === 'boolean' ? (c.fixada ? 1 : 0) : v(c.fixada), participantes: v(c.participantes),
      criada_ts: v(c.criada_ts), ultima: v(c.ultima_atividade_ts), agora: agoraS(),
    });
  }
  /** Ajuste do contador de não lidas como o Baileys manda: >0 soma, 0 zera, -1 = marcada como não lida. */
  ajustarNaoLidas(id, valor, absoluto = false) {
    const c = this.canonico(id);
    if (!c || typeof valor !== 'number') return;
    this.garantirConversa(c, ehGrupo(c) ? 'grupo' : 'individual', null);
    if (absoluto || valor === 0) this.db.prepare('UPDATE conversas SET nao_lidas = ? WHERE id = ?').run(Math.max(0, valor), c);
    else if (valor < 0) this.db.prepare('UPDATE conversas SET nao_lidas = MAX(COALESCE(nao_lidas, 0), 1) WHERE id = ?').run(c);
    else this.db.prepare('UPDATE conversas SET nao_lidas = COALESCE(nao_lidas, 0) + ? WHERE id = ?').run(valor, c);
  }
  /** c = { jid, nome?, notify?, verificado? }; soNotify = só o nome de perfil visto numa mensagem */
  gravarContato(c, soNotify = false) {
    const jid = normJid(c.jid || c.id);
    if (!jid || ehGrupo(jid)) return;
    const atual = this.db.prepare('SELECT * FROM contatos WHERE jid = ?').get(jid);
    if (soNotify && atual?.notify === c.notify) return;
    const nome = c.nome ?? c.name ?? atual?.nome ?? null;
    const notify = c.notify ?? atual?.notify ?? null;
    const verificado = c.verificado ?? c.verifiedName ?? atual?.verificado ?? null;
    const busca = normalizarNome([nome, notify, verificado].filter(Boolean).join(' ')) || null;
    this.db.prepare(`INSERT INTO contatos (jid, nome, notify, verificado, busca_norm, atualizado_em) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (jid) DO UPDATE SET nome = excluded.nome, notify = excluded.notify, verificado = excluded.verificado,
      busca_norm = excluded.busca_norm, atualizado_em = excluded.atualizado_em`).run(jid, nome, notify, verificado, busca, agoraS());
    if (ehLid(jid) && ehPn(normJid(c.phoneNumber))) this.registrarAlias(jid, c.phoneNumber);
    if (ehPn(jid) && ehLid(normJid(c.lid))) this.registrarAlias(c.lid, jid);
  }
  /** Edição feita depois (no celular ou PC): troca o texto e marca "editada". Nunca apaga o registro. */
  marcarEditada(msgId, deMim, novaMensagem) {
    const m = normalizeMessageContent(novaMensagem);
    const t = m ? textoDe(m) : '';
    if (!t) return;
    this.db.prepare('UPDATE mensagens SET texto = ?, texto_norm = ?, editada = 1 WHERE msg_id = ? AND de_mim = ?').run(t, normalizar(t), String(msgId), deMim ? 1 : 0);
  }
  /** "Apagar para todos": a mensagem fica no banco, marcada como apagada. */
  marcarApagada(msgId) {
    this.db.prepare('UPDATE mensagens SET apagada = 1 WHERE msg_id = ?').run(String(msgId));
  }
  atualizarStatusEnvio(msgId, status) {
    if (typeof status !== 'number') return;
    this.db.prepare('UPDATE mensagens SET status_envio = MAX(COALESCE(status_envio, 0), ?) WHERE msg_id = ? AND de_mim = 1').run(status, String(msgId));
  }

  // ----- leitura -----
  original(msgId) {
    const r = this.db.prepare('SELECT original, de_mim, conversa, anexo, tipo, ts, visualizacao_unica FROM mensagens WHERE msg_id = ? ORDER BY de_mim LIMIT 1').get(String(msgId));
    return r || null;
  }
  maisAntigaComOriginal(conversa) {
    const ids = this.idsDe(conversa);
    const ph = ids.map(() => '?').join(',');
    return this.db.prepare(`SELECT msg_id, de_mim, jid_original, ts FROM mensagens WHERE conversa IN (${ph}) AND origem != 'aviso_legado'
      ORDER BY ts ASC, rid ASC LIMIT 1`).get(...ids) || null;
  }
  contarConversa(conversa) {
    const ids = this.idsDe(conversa);
    const ph = ids.map(() => '?').join(',');
    return this.db.prepare(`SELECT COUNT(*) n, MIN(ts) antiga, MAX(ts) recente FROM mensagens WHERE conversa IN (${ph})`).get(...ids);
  }
  registrarSincronizacao(s) {
    this.db.prepare('INSERT INTO sincronizacoes (conversa, pedida_em, quantidade, recebidas, novas, situacao) VALUES (?, ?, ?, ?, ?, ?)')
      .run(s.conversa, agoraS(), s.quantidade ?? null, s.recebidas ?? null, s.novas ?? null, s.situacao ?? null);
  }
  ultimaSincronizacao(conversa) {
    return this.db.prepare('SELECT * FROM sincronizacoes WHERE conversa = ? ORDER BY id DESC LIMIT 1').get(conversa) || null;
  }

  nomeDe(jid) {
    if (!jid) return null;
    const conv = this.db.prepare('SELECT nome FROM conversas WHERE id = ?').get(jid);
    if (ehGrupo(jid)) return conv?.nome || null;
    for (const id of this.idsDe(jid)) {
      const c = this.db.prepare('SELECT nome, notify, verificado FROM contatos WHERE jid = ?').get(id);
      if (c?.nome) return c.nome;
    }
    for (const id of this.idsDe(jid)) {
      const c = this.db.prepare('SELECT nome, notify, verificado FROM contatos WHERE jid = ?').get(id);
      if (c?.notify || c?.verificado) return c.notify || c.verificado;
    }
    return conv?.nome || null;
  }

  /**
   * Nome parcial (sem acento/maiúscula) → conversas e pessoas que batem.
   * → { conversas: [ids canônicos], pessoas: [ids canônicos], candidatos: [{ id, nome, tipo }] }
   */
  resolverNome(q) {
    const palavras = normalizarNome(q).split(' ').filter(Boolean);
    if (!palavras.length) return { conversas: [], pessoas: [], candidatos: [] };
    const like = palavras.map(() => 'busca_norm LIKE ?').join(' AND ');
    const args = palavras.map((w) => `%${w}%`);
    const pessoas = new Map();
    for (const c of this.db.prepare(`SELECT jid, nome, notify, verificado FROM contatos WHERE ${like} LIMIT 200`).all(...args)) {
      const canon = this.canonico(c.jid);
      if (!pessoas.has(canon)) pessoas.set(canon, c.nome || c.notify || c.verificado);
    }
    const conversas = new Map();
    const likeC = palavras.map(() => 'nome_norm LIKE ?').join(' AND ');
    for (const c of this.db.prepare(`SELECT id, nome, tipo FROM conversas WHERE ${likeC} LIMIT 200`).all(...args)) conversas.set(c.id, c);
    for (const [id, nome] of pessoas) if (!conversas.has(id)) conversas.set(id, { id, nome, tipo: 'individual' });
    // nome de perfil visto só em mensagens (gente de grupo que não está na agenda)
    const likeM = palavras.map(() => 'remetente_nome LIKE ?').join(' AND ');
    if (!pessoas.size) {
      for (const r of this.db.prepare(`SELECT DISTINCT remetente, remetente_nome FROM mensagens WHERE remetente IS NOT NULL AND ${likeM} LIMIT 50`)
        .all(...palavras.map((w) => `%${w}%`))) {
        if (normalizarNome(r.remetente_nome).split(' ').length && palavras.every((w) => normalizarNome(r.remetente_nome).includes(w))) pessoas.set(r.remetente, r.remetente_nome);
      }
    }
    return {
      conversas: [...conversas.keys()], pessoas: [...pessoas.keys()],
      candidatos: [...conversas.values()].slice(0, 20).map((c) => ({ id: c.id, nome: c.nome || this.nomeDe(c.id), tipo: c.tipo })),
    };
  }
  /** telefone em qualquer formato → ids canônicos */
  resolverTelefone(t) {
    return variantesTelefone(t).map((d) => this.canonico(d + '@s.whatsapp.net'));
  }

  /**
   * Consulta principal. f = {
   *   conversas?: [ids], pessoas?: [ids] (remetente em grupo), termo?, todasPalavras?, desde?, ate? (segundos),
   *   direcao?: 'enviadas'|'recebidas'|'todas', tipos?: [..], comAnexo?, tiposAnexo?: [..], nomeArquivo?,
   *   grupos?: 'incluir'|'excluir'|'somente', arquivadas?: 'incluir'|'excluir'|'somente',
   *   limite, ordem: 'recentes'|'antigas'|'cronologica', cursor?, deslocamento? }
   */
  consultar(f) {
    const onde = [], args = [];
    const alvo = [];
    if (f.conversas) {
      const ids = [...new Set(f.conversas.flatMap((c) => this.idsDe(c)))];
      alvo.push(ids.length ? `m.conversa IN (${ids.map(() => '?').join(',')})` : '0'); args.push(...ids);
    }
    if (f.pessoas?.length) {
      const ids = [...new Set(f.pessoas.flatMap((c) => this.idsDe(c)))];
      alvo.push(`(m.grupo = 1 AND m.remetente IN (${ids.map(() => '?').join(',')}))`); args.push(...ids);
    }
    if (alvo.length) onde.push(`(${alvo.join(' OR ')})`);
    if (f.termo) {
      const termos = f.todasPalavras ? normalizar(f.termo).split(' ').filter(Boolean) : [normalizar(f.termo)];
      for (const t of termos) {
        if (t.length >= 3) { onde.push('m.rid IN (SELECT rowid FROM mensagens_busca WHERE mensagens_busca MATCH ?)'); args.push('"' + t.replace(/"/g, '""') + '"'); }
        else { onde.push("m.texto_norm LIKE ? ESCAPE '\\'"); args.push('%' + t.replace(/[\\%_]/g, (x) => '\\' + x) + '%'); }
      }
    }
    if (f.desde) { onde.push('m.ts >= ?'); args.push(f.desde); }
    if (f.ate) { onde.push('m.ts <= ?'); args.push(f.ate); }
    if (f.direcao === 'enviadas') onde.push('m.de_mim = 1');
    if (f.direcao === 'recebidas') onde.push('m.de_mim = 0');
    if (f.tipos?.length) { onde.push(`m.tipo IN (${f.tipos.map(() => '?').join(',')})`); args.push(...f.tipos); }
    if (f.comAnexo) onde.push('m.anexo IS NOT NULL');
    if (f.tiposAnexo?.length) { onde.push(`json_extract(m.anexo, '$.tipo') IN (${f.tiposAnexo.map(() => '?').join(',')})`); args.push(...f.tiposAnexo); }
    if (f.nomeArquivo) { onde.push("m.texto_norm LIKE ? ESCAPE '\\'"); args.push('%' + normalizar(f.nomeArquivo).replace(/[\\%_]/g, (x) => '\\' + x) + '%'); }
    if (f.grupos === 'excluir') onde.push('m.grupo = 0');
    if (f.grupos === 'somente') onde.push('m.grupo = 1');
    if (f.arquivadas === 'excluir') onde.push('COALESCE(c.arquivada, 0) = 0');
    if (f.arquivadas === 'somente') onde.push('c.arquivada = 1');
    const base = `FROM mensagens m LEFT JOIN conversas c ON c.id = m.conversa ${onde.length ? 'WHERE ' + onde.join(' AND ') : ''}`;
    const total = this.db.prepare(`SELECT COUNT(*) n ${base}`).get(...args).n;

    const asc = f.ordem === 'antigas';
    const pagArgs = [...args];
    let pagOnde = '';
    if (f.cursor) {
      pagOnde = `${onde.length ? ' AND' : ' WHERE'} (m.ts, m.rid) ${asc ? '>' : '<'} (?, ?)`;
      pagArgs.push(f.cursor.ts, f.cursor.rid);
    }
    const lim = f.limite;
    const linhas = this.db.prepare(`SELECT m.*, c.nome AS conversa_nome, c.arquivada AS conversa_arquivada ${base}${pagOnde}
      ORDER BY m.ts ${asc ? 'ASC' : 'DESC'}, m.rid ${asc ? 'ASC' : 'DESC'} LIMIT ? OFFSET ?`).all(...pagArgs, lim + 1, f.cursor ? 0 : (f.deslocamento || 0));
    const haMais = linhas.length > lim;
    const pagina = linhas.slice(0, lim);
    const ultimo = pagina[pagina.length - 1];
    const proximo = haMais && ultimo ? { ts: ultimo.ts, rid: ultimo.rid } : null;
    if (f.ordem === 'cronologica') pagina.reverse();
    return { linhas: pagina, total, haMais, proximo };
  }

  /** Cobertura real do banco (geral ou das conversas pedidas). */
  cobertura(conversas) {
    let onde = '', args = [];
    if (conversas) {
      const ids = [...new Set(conversas.flatMap((c) => this.idsDe(c)))];
      onde = ids.length ? `WHERE conversa IN (${ids.map(() => '?').join(',')})` : 'WHERE 0';
      args = ids;
    }
    const r = this.db.prepare(`SELECT COUNT(*) total, SUM(de_mim) enviadas, MIN(ts) antiga, MAX(ts) recente,
      COUNT(DISTINCT conversa) conversas FROM mensagens ${onde}`).get(...args);
    const porOrigem = {};
    for (const o of this.db.prepare(`SELECT origem, COUNT(*) n, MIN(ts) antiga FROM mensagens ${onde} GROUP BY origem`).all(...args)) porOrigem[o.origem] = { mensagens: o.n, mais_antiga: isoSP(o.antiga) };
    const gravando = Number(this.estado('gravando_desde')) || null;
    return {
      historico_completo: false,
      total_no_banco: r.total || 0, enviadas: r.enviadas || 0, recebidas: (r.total || 0) - (r.enviadas || 0),
      conversas: r.conversas || 0,
      mensagem_mais_antiga: isoSP(r.antiga), mensagem_mais_recente: isoSP(r.recente),
      gravacao_automatica_desde: isoSP(gravando),
      por_origem: porOrigem,
      _antiga: r.antiga || null,
    };
  }

  listarConversas(f) {
    const onde = [], args = [];
    if (f.ids) { onde.push(`c.id IN (${f.ids.map(() => '?').join(',') || "''"})`); args.push(...f.ids); }
    if (f.tipo === 'individual' || f.tipo === 'grupo') { onde.push('c.tipo = ?'); args.push(f.tipo); }
    if (f.arquivadas === 'excluir') onde.push('COALESCE(c.arquivada, 0) = 0');
    if (f.arquivadas === 'somente') onde.push('c.arquivada = 1');
    if (f.naoLidas) onde.push('c.nao_lidas > 0');
    if (f.comMensagens) onde.push('EXISTS (SELECT 1 FROM mensagens m WHERE m.conversa = c.id)');
    const where = onde.length ? 'WHERE ' + onde.join(' AND ') : '';
    const total = this.db.prepare(`SELECT COUNT(*) n FROM conversas c ${where}`).get(...args).n;
    const linhas = this.db.prepare(`SELECT c.*,
        (SELECT COUNT(*) FROM mensagens m WHERE m.conversa = c.id) AS total_msgs,
        (SELECT MIN(ts) FROM mensagens m WHERE m.conversa = c.id) AS antiga,
        (SELECT MAX(ts) FROM mensagens m WHERE m.conversa = c.id) AS recente
      FROM conversas c ${where}
      ORDER BY COALESCE((SELECT MAX(ts) FROM mensagens m WHERE m.conversa = c.id), c.ultima_atividade_ts, 0) DESC, c.id
      LIMIT ? OFFSET ?`).all(...args, f.limite + 1, f.deslocamento || 0);
    const ultimaMsg = this.db.prepare('SELECT de_mim, tipo, texto, ts, remetente_nome FROM mensagens WHERE conversa = ? ORDER BY ts DESC, rid DESC LIMIT 1');
    return {
      total, haMais: linhas.length > f.limite,
      linhas: linhas.slice(0, f.limite).map((c) => ({ ...c, ultima: ultimaMsg.get(c.id) })),
    };
  }

  listarContatos(f) {
    const onde = [], args = [];
    if (f.palavras?.length) { for (const w of f.palavras) { onde.push('busca_norm LIKE ?'); args.push(`%${w}%`); } }
    if (f.jids) { onde.push(`jid IN (${f.jids.map(() => '?').join(',') || "''"})`); args.push(...f.jids); }
    if (f.salvos) onde.push('nome IS NOT NULL');
    const where = onde.length ? 'WHERE ' + onde.join(' AND ') : '';
    const total = this.db.prepare(`SELECT COUNT(*) n FROM contatos ${where}`).get(...args).n;
    const linhas = this.db.prepare(`SELECT * FROM contatos ${where} ORDER BY (nome IS NULL), COALESCE(nome, notify, verificado, jid) COLLATE NOCASE
      LIMIT ? OFFSET ?`).all(...args, f.limite + 1, f.deslocamento || 0);
    return { total, haMais: linhas.length > f.limite, linhas: linhas.slice(0, f.limite) };
  }

  // ----- migração do cache antigo (recebidas.json) e do histórico de avisos (historico.jsonl) -----
  /** recebidas = { msgs: { id: base64 do WebMessageInfo } }. Idempotente. */
  migrarCacheRecebidas(recebidas) {
    const msgs = [];
    for (const b64 of Object.values(recebidas?.msgs || {})) {
      try { msgs.push(proto.WebMessageInfo.decode(Buffer.from(b64, 'base64'))); } catch {}
    }
    return this.gravarMuitas(msgs, 'cache_antigo');
  }
  /**
   * Avisos antigos do WhatsApp (dados/historico.jsonl): texto já juntado por aviso, sem id da mensagem.
   * Só entra a linha que NÃO existe no banco (mesma conversa, até 3 min antes do aviso). Horário = do aviso (aproximado).
   */
  migrarHistoricoAvisos(itens) {
    let novas = 0, total = 0, semConversa = 0;
    const achar = (nome, grupo) => {
      const n = normalizarNome(nome);
      if (!n) return null;
      if (grupo) return this.db.prepare("SELECT id FROM conversas WHERE tipo = 'grupo' AND nome_norm = ? LIMIT 1").get(n)?.id || null;
      const c = this.db.prepare('SELECT jid FROM contatos WHERE busca_norm = ? OR nome = ? OR notify = ? OR verificado = ? ORDER BY (nome IS NULL) LIMIT 1').get(n, nome, nome, nome);
      if (c) return this.canonico(c.jid);
      // nome de perfil mudou depois: aceita só se UMA pessoa tiver esse nome em alguma parte do cadastro
      const v = [...new Set(this.db.prepare('SELECT jid FROM contatos WHERE busca_norm LIKE ? LIMIT 5').all(`%${n}%`).map((x) => this.canonico(x.jid)))];
      return v.length === 1 ? v[0] : null;
    };
    // mensagens de verdade já no banco, até 18 h antes do aviso (o aviso de quando o Vigia estava fora chega depois)
    const reaisPerto = this.db.prepare(`SELECT texto, tipo FROM mensagens WHERE conversa = ? AND origem != 'aviso_legado' AND ts BETWEEN ? AND ?`);
    const DESCRICAO = /^\[(?:enviou|mandou|criou)[^\]]*\](?:\s.*)?$/s;
    this.transacao(() => {
      for (const x of itens) {
        if (x?.canal !== 'whatsapp' || !x.quando) continue;
        const ts = Math.floor(Date.parse(x.quando) / 1000);
        if (!ts) continue;
        const grupo = !!x.grupo;
        const conv = achar(grupo ? x.grupo : x.de, grupo);
        const conversa = conv || ('legado:' + (normalizarNome(grupo ? x.grupo : x.de) || 'desconhecido').replace(/ /g, '-'));
        if (!conv) semConversa++;
        // linhas reais (multiconjunto) para descontar do texto juntado
        const reais = new Map();
        let midiasReais = 0;
        if (conv) {
          for (const r of reaisPerto.all(conv, ts - 18 * 3600, ts + 5)) {
            if (r.tipo !== 'texto' && r.tipo !== 'interativa') midiasReais++;
            for (const l of String(r.texto || '').split('\n').map((s) => s.trim()).filter(Boolean)) reais.set(l, (reais.get(l) || 0) + 1);
          }
        }
        const consumir = (l) => { const n = reais.get(l); if (!n) return false; if (n === 1) reais.delete(l); else reais.set(l, n - 1); return true; };
        const autores = grupo ? String(x.de || '').split(', ').map((s) => s.trim()).filter(Boolean) : [];
        // grupo: "Autor: texto" abre uma mensagem nova; linha sem autor continua a anterior
        const blocos = [];
        for (const bruta of String(x.textoOriginal || x.texto || '').split('\n')) {
          const linha = bruta.trim();
          if (!linha) continue;
          const autor = grupo ? autores.find((a) => linha.startsWith(a + ': ')) : null;
          const conteudo = autor ? linha.slice(autor.length + 2).trim() : linha;
          if (consumir(conteudo)) { if (autor) blocos.push({ autor, linhas: [], fechado: true }); continue; }
          if (midiasReais && DESCRICAO.test(conteudo)) { midiasReais--; if (autor) blocos.push({ autor, linhas: [], fechado: true }); continue; }
          const ult = blocos[blocos.length - 1];
          if (grupo && !autor && ult) { ult.linhas.push(conteudo); continue; }
          if (!grupo && ult) { ult.linhas.push(conteudo); continue; } // conversa individual: um aviso = um registro (mensagens juntadas)
          blocos.push({ autor: autor || (grupo ? null : (x.de ?? null)), linhas: [conteudo] });
        }
        const ocorrencias = new Map();
        blocos.filter((bl) => bl.linhas.length).forEach((bl) => {
          const autor = bl.autor;
          const texto = bl.linhas.join('\n');
          const linha = `${autor || ''}|${texto}`;
          total++;
          const n = (ocorrencias.get(linha) || 0) + 1; ocorrencias.set(linha, n);
          const id = 'legado-' + crypto.createHash('sha1').update(`${x.quando}|${conversa}|${linha}|${n}`).digest('hex').slice(0, 24);
          const tipo = /^\[mandou um áudio/.test(texto) ? 'audio' : /^\[enviou uma foto/.test(texto) ? 'imagem' : /^\[enviou o arquivo/.test(texto) ? 'documento' : 'texto';
          const r = this.gravarRegistro({
            msg_id: id, de_mim: 0, conversa, jid_original: conversa, jid_alternativo: null, grupo: grupo ? 1 : 0,
            remetente: grupo ? null : conversa, remetente_nome: autor || null, ts, tipo, texto, texto_norm: normalizar(texto),
            anexo: null, citada_id: null, citada_texto: null, citada_remetente: null, encaminhada: 0, temporaria: 0,
            visualizacao_unica: 0, editada: 0, horario_aproximado: 1, original: null,
          }, 'aviso_legado');
          if (r === 'nova') novas++;
          if (!conv && grupo) this.db.prepare('UPDATE conversas SET tipo = ?, nome = COALESCE(nome, ?), nome_norm = COALESCE(nome_norm, ?) WHERE id = ?').run('grupo', x.grupo, normalizarNome(x.grupo), conversa);
          if (!conv && !grupo && x.de) this.db.prepare('UPDATE conversas SET nome = COALESCE(nome, ?), nome_norm = COALESCE(nome_norm, ?) WHERE id = ?').run(String(x.de), normalizarNome(x.de), conversa);
        });
      }
    });
    return { novas, linhas: total, sem_conversa_identificada: semConversa };
  }
}

export { ORIGENS };
