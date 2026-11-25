// Vigia · github.com/eudollyn/vigia · AGPL-3.0-or-later · VGA-EUD-2026 (manter este crédito em cópias e versões modificadas)
// Lembretes por voz: "me lembra às 3 de ligar pro cliente", "me lembra daqui a 20 minutos de tirar o bolo".
// O Gemini transforma a frase em data/hora + texto; os lembretes ficam em dados/lembretes.json.
import fs from 'node:fs';
import path from 'node:path';
import { config, DADOS } from './config.js';
import { log } from './avisos.js';

const ARQ = path.join(DADOS, 'lembretes.json');
let lista = [];
try { lista = JSON.parse(fs.readFileSync(ARQ, 'utf8')); } catch {}
const salvar = () => fs.writeFileSync(ARQ, JSON.stringify(lista, null, 1));

const agoraSP = () => new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).replace(' ', 'T'); // 2026-11-23T11:20:00

async function interpretar(fala) {
  const prompt = `Agora é ${agoraSP()} (horário de Brasília, ${new Date().toLocaleDateString('pt-BR', { weekday: 'long', timeZone: 'America/Sao_Paulo' })}).
A pessoa pediu um lembrete com esta frase: "${fala}"
Extraia quando lembrar e do quê. Regras: "às 3" sem manhã/tarde = o próximo 3h ou 15h que ainda não passou (no horário comercial, prefira a tarde);
"daqui a X minutos/horas" = agora + X; "amanhã de manhã" sem hora = 08:00; "à tarde" sem hora = 14:00; "à noite" sem hora = 19:00.
O texto do lembrete é curto, no infinitivo ou como a pessoa falou, sem "me lembra". Se não houver horário entendível, quando = "".
Responda só JSON: {"quando":"AAAA-MM-DDTHH:MM","texto":"..."}`;
  const modelos = [...new Set([config.geminiModelo, ...config.geminiReservas])];
  // duas rodadas: se o Google estiver num pico de demanda, espera 2 s e tenta tudo de novo
  for (const m of [...modelos, 'pausa', ...modelos]) {
    if (m === 'pausa') { await new Promise((r) => setTimeout(r, 2000)); continue; }
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.geminiChave },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0 } }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) continue;
      const out = ((await r.json()).candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
      const j = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
      if (!j.quando) return { quando: null, texto: j.texto || '' };
      const iso = String(j.quando).trim().replace(' ', 'T').slice(0, 19);
      const quando = new Date(`${iso.length === 16 ? iso + ':00' : iso}-03:00`).getTime(); // Brasília (sem horário de verão)
      return isNaN(quando) ? { quando: null, texto: j.texto || '' } : { quando, texto: String(j.texto || '').trim() };
    } catch {}
  }
  return null;
}

/** Quando falado: "hoje às 15 horas", "amanhã às 8 horas", "sexta, 28, às 10 e 30". */
export function quandoFalado(ms) {
  const d = new Date(ms), hoje = new Date(), amanha = new Date(); amanha.setDate(hoje.getDate() + 1);
  const h = d.getHours(), mi = d.getMinutes();
  const hora = `às ${h} ${h === 1 ? 'hora' : 'horas'}${mi ? ` e ${mi}` : ''}`;
  if (d.toDateString() === hoje.toDateString()) return `hoje ${hora}`;
  if (d.toDateString() === amanha.toDateString()) return `amanhã ${hora}`;
  return `${d.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric' })}, ${hora}`;
}

/** → { ok: true, lembrete } | { ok: false, motivo } */
// "daqui a 20 minutos", "daqui a uma hora e meia", "em meia hora": calculado aqui, sem depender da IA
const NUM = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12,
  quinze: 15, vinte: 20, 'vinte e cinco': 25, trinta: 30, quarenta: 40, 'quarenta e cinco': 45, cinquenta: 50 };
function relativo(fala) {
  const s = fala.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const re = /\b(?:daqui a|daqui|em|dentro de)\s+(meia hora|(\d+|[a-z]+(?: e [a-z]+)?)\s+(minutos?|min|horas?|h)(\s+e\s+meia)?)\b/;
  const m = re.exec(s);
  if (!m) return null;
  let ms;
  if (m[1] === 'meia hora') ms = 30 * 60_000;
  else {
    const n = /^\d+$/.test(m[2]) ? Number(m[2]) : NUM[m[2]];
    if (!n) return null;
    ms = /^h/.test(m[3]) ? n * 3600_000 : n * 60_000;
    if (m[4] && /^h/.test(m[3])) ms += 30 * 60_000;
  }
  // texto: o que vem depois de "de" / "para", tirando o pedaço do tempo
  const semTempo = fala.replace(new RegExp(m[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' ');
  const texto = (/(?:\bde\b|\bpara\b|\bpra\b)\s+(.+)$/i.exec(semTempo.replace(/^\W*(me\s+)?(lembra|lembre|lembrar|lembrete)\s*/i, '')) || [])[1] || '';
  return { quando: Date.now() + ms, texto: texto.replace(/[.!?]+$/, '').trim() };
}

// Horário absoluto entendido no código (sem IA): "às 17 horas", "às 17:00", "às cinco e meia da tarde", "às três",
// "amanhã às 8", "meio-dia", "amanhã de manhã", "hoje à noite".
const HORA_PALAVRA = { uma: 1, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12,
  treze: 13, quatorze: 14, catorze: 14, quinze: 15, dezesseis: 16, dezessete: 17, dezoito: 18, dezenove: 19, vinte: 20,
  'vinte e uma': 21, 'vinte e duas': 22, 'vinte e tres': 23 };
const MIN_PALAVRA = { meia: 30, quinze: 15, trinta: 30, 'quarenta e cinco': 45, dez: 10, vinte: 20, cinco: 5, cinquenta: 50, quarenta: 40 };
function absoluto(fala) {
  const s = fala.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[-–]/g, ' ');
  const base = new Date();
  let dias = /\bdepois de amanha\b/.test(s) ? 2 : /\bamanha\b/.test(s) ? 1 : 0;
  let h = null, m = 0, pedaco = '';
  const pal = Object.keys(HORA_PALAVRA).sort((a, b) => b.length - a.length).join('|');
  const re = new RegExp(`\\b(?:as|a|ao|para as|pras)\\s+(\\d{1,2}|${pal})(?:\\s*(?::|h)\\s*(\\d{2}))?(?:\\s*(?:horas?|hs?)\\b)?(?:\\s+e\\s+(\\d{1,2}|meia|quinze|trinta|quarenta e cinco|vinte|dez|cinco|cinquenta|quarenta)(?:\\s+minutos?)?)?`);
  const x = re.exec(s);
  if (x) {
    h = /^\d+$/.test(x[1]) ? Number(x[1]) : HORA_PALAVRA[x[1]];
    if (x[2]) m = Number(x[2]); else if (x[3]) m = /^\d+$/.test(x[3]) ? Number(x[3]) : MIN_PALAVRA[x[3]];
    pedaco = x[0];
  } else if (/\bmeio dia\b/.test(s)) { h = 12; pedaco = (/\b(?:ao |as |a )?meio dia\b/.exec(s) || [''])[0]; }
  else if (/\bmeia noite\b/.test(s)) { h = 0; dias = dias || 1; pedaco = (/\b(?:a |as )?meia noite\b/.exec(s) || [''])[0]; }
  else if (/\b(de|pela|na) manha\b/.test(s)) { h = 8; pedaco = /\b(de|pela|na) manha\b/.exec(s)[0]; }
  else if (/\b(a|de|pela|na) tarde\b/.test(s)) { h = 14; pedaco = /\b(a|de|pela|na) tarde\b/.exec(s)[0]; }
  else if (/\b(a|de|pela|na) noite\b/.test(s)) { h = 19; pedaco = /\b(a|de|pela|na) noite\b/.exec(s)[0]; }
  if (h === null || h > 23 || m > 59) return null;
  const periodo = /\bda (tarde|noite)\b/.test(s) ? 'pm' : /\bda (manha|madrugada)\b/.test(s) ? 'am' : '';
  if (periodo === 'pm' && h < 12) h += 12;
  const d = new Date(base); d.setDate(d.getDate() + dias); d.setHours(h, m, 0, 0);
  if (!periodo && h >= 1 && h <= 11 && x) {
    // "às três" sem manhã/tarde: até 7 é sempre da tarde; senão, se já passou hoje, usa o mesmo horário da tarde
    if (h <= 7) d.setHours(h + 12);
    else if (dias === 0 && d <= base) d.setHours(h + 12);
  }
  if (dias === 0 && d <= base) d.setDate(d.getDate() + 1); // já passou hoje: amanhã no mesmo horário
  // texto: o que vem depois de "de / que / pra / para" (tirando o comando e o horário)
  let resto = fala.normalize('NFC');
  const semAc = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const i = semAc(resto).indexOf(pedaco.trim());
  if (pedaco && i >= 0) resto = resto.slice(0, i) + ' ' + resto.slice(i + pedaco.trim().length);
  resto = resto.replace(/^\W*(me\s+)?(lembra|lembre|lembrar|lembrete|cria um lembrete|criar lembrete)\b/i, '')
    .replace(/\b(amanh[ãa]|hoje|depois de amanh[ãa])\b/gi, '').replace(/\bda (tarde|noite|manh[ãa]|madrugada)\b/gi, '');
  const t = (/(?:^|\s)(?:de|que|pra|para|do|da)\s+(.+)$/i.exec(resto.trim()) || [])[1] || '';
  return { quando: d.getTime(), texto: t.replace(/[.!?]+$/, '').trim() };
}

/** ajustarTexto(texto) → texto final (usado no "me lembra disso": troca o "disso" pela mensagem). */
export async function criarLembrete(fala, ajustarTexto) {
  let r = relativo(fala) || absoluto(fala);
  if (r && !r.texto) r.texto = 'lembrete'; // sem assunto: "Senhor João, lembrete."
  if (!r) r = await interpretar(fala); // frase muito diferente: tenta a IA
  if (!r) return { ok: false, motivo: 'sem-hora' }; // nem o código nem a IA acharam um horário
  if (!r.quando) return { ok: false, motivo: 'sem-hora' };
  if (r.quando < Date.now() - 60_000) return { ok: false, motivo: 'passado' };
  if (ajustarTexto) r.texto = ajustarTexto(r.texto === 'lembrete' ? '' : r.texto || '');
  const lembrete = { id: Date.now().toString(36), quando: r.quando, texto: r.texto || 'lembrete', feito: false };
  lista.push(lembrete); salvar();
  log(`lembrete criado para ${new Date(r.quando).toLocaleString('pt-BR')}: ${lembrete.texto}`);
  return { ok: true, lembrete };
}

/** Confere a cada 15 s; ao ligar, lembretes que venceram nas últimas 12 h tocam como "atrasados". */
export function iniciarLembretes(disparar) {
  const verificar = () => {
    const agora = Date.now();
    let mudou = false;
    for (const l of lista) {
      if (l.feito || l.quando > agora) continue;
      l.feito = true; mudou = true;
      const atraso = agora - l.quando;
      if (atraso < 12 * 3600_000) disparar(l, atraso > 5 * 60_000);
    }
    if (mudou) { lista = lista.filter((l) => !l.feito || Date.now() - l.quando < 7 * 86_400_000); salvar(); }
  };
  setTimeout(verificar, 20_000); // espera o notebook conectar
  setInterval(verificar, 15_000);
}
