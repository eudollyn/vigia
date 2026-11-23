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

export async function criarLembrete(fala) {
  let r = relativo(fala);
  if (r && !r.texto) { const ia = await interpretar(fala); r.texto = ia?.texto || 'lembrete'; }
  if (!r) r = await interpretar(fala);
  if (!r) return { ok: false, motivo: 'sem-ia' };
  if (!r.quando) return { ok: false, motivo: 'sem-hora' };
  if (r.quando < Date.now() - 60_000) return { ok: false, motivo: 'passado' };
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
