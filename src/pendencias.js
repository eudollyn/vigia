// Pendências: conversas diretas do WhatsApp em que a última mensagem foi da outra pessoa
// (some quando você responde, inclusive pelo celular) e e-mails de pessoas recebidos.
import fs from 'node:fs';
import path from 'node:path';
import { config, DADOS } from './config.js';

const ARQ = path.join(DADOS, 'pendencias.json');
let dados = { whats: {}, emails: [] };
try { dados = { whats: {}, emails: [], ...JSON.parse(fs.readFileSync(ARQ, 'utf8')) }; } catch {}
let t;
const salvar = () => { clearTimeout(t); t = setTimeout(() => { try { fs.writeFileSync(ARQ, JSON.stringify(dados)); } catch {} }, 2000); };
const ignorado = (nome) => config.baixaPrioridade.some((b) => String(nome || '').toLowerCase().includes(b));

/** Chegou mensagem direta de alguém. ids: todas as formas do id do chat (telefone e @lid). */
export function recebeu(ids, nome) {
  if (ignorado(nome)) return;
  const chave = ids[0];
  const ant = dados.whats[chave] || {};
  dados.whats[chave] = { ...ant, ids: [...new Set([...(ant.ids || []), ...ids])], nome, recebida: Date.now() };
  salvar();
}

/** Você mandou mensagem nesse chat (pelo celular, pelo PC ou por voz). */
export function respondeu(ids) {
  let mudou = false;
  for (const [chave, p] of Object.entries(dados.whats)) {
    if ((p.ids || [chave]).some((i) => ids.includes(i))) { p.enviada = Date.now(); mudou = true; }
  }
  if (mudou) salvar();
}

/** E-mail de uma pessoa (não propaganda) que chegou. */
export function emailRecebido(de, assunto) {
  dados.emails.push({ de, assunto, quando: Date.now() });
  const limite = Date.now() - 4 * 86_400_000;
  dados.emails = dados.emails.filter((e) => e.quando > limite).slice(-200);
  salvar();
}

/** Conversas sem resposta há pelo menos `minimoMin` minutos (até 3 dias), mais antigas primeiro. */
export function whatsSemResposta(minimoMin = 30) {
  const agora = Date.now();
  return Object.values(dados.whats)
    .filter((p) => p.recebida > (p.enviada || 0) && agora - p.recebida >= minimoMin * 60_000 && agora - p.recebida < 3 * 86_400_000)
    .sort((a, b) => a.recebida - b.recebida);
}

/** E-mails de pessoas recebidos desde `desde` (padrão: ontem às 0h). */
export function emailsDesde(desde) {
  if (!desde) { const d = new Date(); d.setDate(d.getDate() - 1); d.setHours(0, 0, 0, 0); desde = d.getTime(); }
  return dados.emails.filter((e) => e.quando >= desde);
}
