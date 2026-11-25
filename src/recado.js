// Vigia · github.com/eudollyn/vigia · AGPL-3.0-or-later · VGA-EUD-2026 (manter este crédito em cópias e versões modificadas)
// "Fala pro Aninha responder logo" → manda "Responde logo." para o Ana.
// Entende o pedido (para quem + o recado) e transforma o recado indireto na mensagem direta, do jeito que se escreve no zap:
//   "responder logo" → "Responde logo."   "me ligar quando chegar" → "Me liga quando chegar."
//   "que eu vou atrasar" → "Vou atrasar."   "que ela precisa trazer o carregador" → "Você precisa trazer o carregador."
// O Gemini faz a conversão; se ele estiver lento ou fora, uma regra local cuida dos casos comuns.
import { config } from './config.js';

const sem = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const VERBO = /^(fala|fale|falar|diz|diga|dizer|avisa|avise|avisar|pede|peca|pedir|manda|mande|lembra|lembre|chama|chame)\b/;
const PREP = /^(pro|pra|para o|para a|para|pros|pras|ao|a|o)\s+/;
// palavras que encerram o nome e começam o recado
const FIM_NOME = /^(que|pra|para|pro|se|de|ir|vir|me|te|nos|lhe|nao|ja|logo|agora|quando|porque|e)$/;
const infinitivo = (w) => w.length >= 2 && /^[a-zà-ú]*(ar|er|ir|or|ôr)$/.test(w); // "ir", "vir", "ter" também

/** "fala pro aninha responder logo" → { nome: "aninha", recado: "responder logo" } | null */
export function entenderRecado(fala) {
  const original = String(fala || '').replace(/[.!?]+$/, '').trim();
  const s = sem(original).replace(/[,;:]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!VERBO.test(s)) return null;
  let resto = s.replace(VERBO, '').trim().replace(/^(ai|la)\s+/, '');
  const temPrep = PREP.test(resto);
  if (!temPrep && !/^(avisa|avise|chama|chame|lembra|lembre)/.test(s)) return null; // "fala de novo" não é recado
  resto = resto.replace(PREP, '').replace(/^(o|a)\s+/, '');
  const palavras = resto.split(' ');
  const nome = [];
  for (const w of palavras) {
    if (nome.length && (FIM_NOME.test(w) || (infinitivo(w) && nome.length >= 1))) break;
    if (nome.length >= 3) break;
    nome.push(w);
  }
  // as palavras depois de "pro/pra", com acentos (o nome exato é escolhido depois, comparando com os contatos)
  const inicio = s.split(' ').length - palavras.length;
  const partes = original.replace(/[,;:]+/g, ' ').split(/\s+/).slice(inicio).filter(Boolean);
  const recado = partes.slice(nome.length).join(' ').trim();
  if (!nome.length || !recado) return null;
  return { nome: nome.join(' '), recado, partes, qtdNome: nome.length };
}
/** Com o tamanho do nome já decidido (ex.: pelos contatos), separa nome e recado. */
export function separar(partes, qtdNome) {
  return { nome: partes.slice(0, qtdNome).join(' '), recado: partes.slice(qtdNome).join(' ').trim() };
}

// regra local: infinitivo → imperativo do dia a dia ("responder" → "responde")
const IRREG = { ir: 'vai', vir: 'vem', ter: 'tem', trazer: 'traz', fazer: 'faz', dizer: 'diz', por: 'põe', pôr: 'põe', sair: 'sai', cair: 'cai', ser: 'seja', estar: 'fica', dar: 'dá', ver: 'vê', ler: 'lê', ouvir: 'ouve', pedir: 'pede', subir: 'sobe', fugir: 'foge', querer: 'quer', poder: 'pode', saber: 'sabe', trazê: 'traz' };
function imperativo(v) {
  const l = v.toLowerCase();
  if (IRREG[l]) return IRREG[l];
  if (/ar$/.test(l)) return l.slice(0, -2) + 'a';
  if (/[ei]r$/.test(l)) return l.slice(0, -2) + 'e';
  return l;
}
const maiuscula = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);
export function recadoLocal(recado) {
  let r = String(recado || '').trim().replace(/^(que|pra|para)\s+/i, '');
  const w = r.split(/\s+/);
  // "me ligar", "te avisar": pronome + infinitivo
  if (w.length > 1 && /^(me|te|nos|lhe|se)$/i.test(w[0]) && infinitivo(sem(w[1]))) w[1] = imperativo(w[1]);
  else if (infinitivo(sem(w[0]))) w[0] = imperativo(w[0]);
  else if (/^(ele|ela)$/i.test(w[0])) w[0] = 'você'; // "que ela precisa…" → "você precisa…"
  else if (/^eu$/i.test(w[0]) && w.length > 1) w.shift(); // "que eu vou atrasar" → "vou atrasar"
  r = w.join(' ');
  return maiuscula(r);
}

async function recadoGemini(recado, nome, modelo) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelo)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.geminiChave },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text:
        'Eu pedi ao meu assistente para dar um recado a uma pessoa pelo WhatsApp. Transforme o recado indireto na mensagem DIRETA ' +
        'que eu mesmo mandaria para essa pessoa, em português do Brasil informal, curta, mantendo as minhas palavras e gírias. ' +
        'Use o imperativo do dia a dia (responde, liga, vem, traz). "eu" continua sendo eu; "ele/ela" (a pessoa) vira "você". ' +
        'Exemplos: "responder logo" → "Responde logo."; "me ligar quando chegar" → "Me liga quando chegar."; ' +
        '"que eu vou atrasar" → "Vou atrasar."; "que ela precisa trazer o carregador" → "Você precisa trazer o carregador."; ' +
        '"pra vir jantar aqui hoje" → "Vem jantar aqui hoje.". NÃO comece com o nome da pessoa, não acrescente cumprimentos nem explicações. Responda só com a mensagem.' }] },
      contents: [{ role: 'user', parts: [{ text: `Pessoa: ${nome}\nRecado: ${recado}` }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 300 },
    }),
    signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) throw new Error(`Gemini ${r.status}`);
  const j = await r.json();
  const t = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim().replace(/^["“]|["”]$/g, '');
  if (!t || t.length > recado.length * 2 + 40) throw new Error('resposta estranha');
  return t;
}

/** recado indireto → mensagem direta */
export async function converterRecado(recado, nome) {
  if (config.geminiChave) {
    const modelos = [...new Set([config.geminiModelo || 'gemini-flash-lite-latest', ...(config.geminiReservas || [])])].slice(0, 2);
    for (const m of modelos) { try { return await recadoGemini(recado, nome, m); } catch {} }
  }
  return recadoLocal(recado);
}
