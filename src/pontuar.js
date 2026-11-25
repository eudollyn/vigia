// Vigia · github.com/eudollyn/vigia · AGPL-3.0-or-later · VGA-EUD-2026 (manter este crédito em cópias e versões modificadas)
// Pontuação do texto ditado. O reconhecimento de voz do Chrome devolve tudo sem vírgula, ponto ou interrogação
// ("oi tudo bem chego às sete pode ser"). Antes de ler de volta e enviar, coloca a pontuação:
// 0) a página marca onde você PAUSOU (" | "): cada pausa vira vírgula, ponto ou interrogação;
// 1) o Gemini pontua (vê as marcas de pausa) e pode corrigir só erros claros do reconhecimento ("chat de PT" → "ChatGPT");
// 2) se o Google estiver lento ou fora, uma regra local: pausas, cumprimentos ("Oi, tudo bem?"), vírgula antes de
//    "mas/então/só que/aí eu…", interrogação em perguntas e minúsculas nas maiúsculas soltas do Chrome.
import { config } from './config.js';

const PERGUNTA = /^(que|qual|quais|quando|onde|aonde|como|quem|quanto|quantos|quantas|por ?que|pq|cad[eê]|ser[aá]|ser[aá] que|vc vai|voc[eê] (vai|pode|quer|est[aá]|t[aá]|tem|sabe|viu|acha|lembra|consegue|conseguiu|j[aá])|tu (vai|pode|quer|viu|sabe|lembra|t[aá])|pode|posso|podemos|vamos|bora|tem como|t[aá] (a[ií]|bem|tudo|certo)|tudo (bem|bom|certo|joia|jóia)|j[aá] (chegou|foi|viu|comeu|acabou)|e a[ií]|e voc[eê]|e tu|n[eé]|deu certo|conseguiu|viu)\b/i;
const FIM_PERGUNTA = /\b(n[eé]|ok|t[aá]|beleza|blz|certo|sim ou n[aã]o|pode ser|t[aá] bom|tudo bem|combinado|que tal|viu|entendeu|lembra|sabe)$/i;
const CUMPRIMENTO = /^(oi|ol[aá]|opa|e a[ií]|eai|fala|ei|al[oô]|bom dia|boa tarde|boa noite)\b\s+(.+)$/i;
const COMO_VAI = /^(tudo (bem|bom|certo|joia|jóia|tranquilo)|beleza|blz|como (vai|voc[eê] (est[aá]|t[aá])|c[eê] t[aá])|como foi|suave)\b\s*(.*)$/i;
// palavras comuns que o Chrome às vezes escreve com maiúscula no meio da frase ("Tô", "E aí", "Devendo")
const COMUNS = new Set('eu tu você voce ele ela nós nos a gente vocês voces eles elas e é o a os as um uma uns umas de do da dos das em no na nos nas por pra pro para com sem que se não nao sim já ja só so também tambem mas então entao aí ai lá la aqui isso esse essa este esta isto tô to tá ta tava vou vai vamos foi era ser estar tem ter tinha mano cara véi vei né ne ok beleza agora depois antes hoje amanhã amanha ontem quando onde como porque porquê muito pouco mais menos bem mal tudo nada'.split(' '));

// quantas palavras foram trocadas, tiradas ou acrescentadas (distância de edição por palavra)
function distanciaPalavras(a, b) {
  let ant = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const at = [i];
    for (let j = 1; j <= b.length; j++) at[j] = Math.min(ant[j] + 1, at[j - 1] + 1, ant[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    ant = at;
  }
  return ant[b.length];
}
const soPalavras = (t) => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const ehPergunta = (s) => PERGUNTA.test(s) || (s.split(' ').length > 2 && FIM_PERGUNTA.test(s));

// maiúsculas soltas do Chrome no meio da frase → minúsculas (só palavras comuns e gerúndios, nunca nomes)
function minusculas(s) {
  return s.replace(/(^|\s)([A-ZÀ-Ú][a-zà-ú]*)/g, (m, esp, w) => {
    const l = w.toLowerCase();
    return COMUNS.has(l) || /[a-zà-ú]{3,}ndo$/.test(l) ? esp + l : m;
  });
}
// dentro de um trecho: "oi tudo bem tô indo" → "oi, tudo bem? tô indo"; vírgula antes de "mas", "então"…
function trecho(s) {
  let partes = [];
  let resto = s;
  const c = CUMPRIMENTO.exec(resto);
  if (c) { partes.push({ t: c[1], fim: ',' }); resto = c[2]; }
  const v = COMO_VAI.exec(resto);
  if (v && v[v.length - 1]) { partes.push({ t: resto.slice(0, resto.length - v[v.length - 1].length).trim(), fim: '?' }); resto = v[v.length - 1]; }
  resto = resto
    // (?<!\be) : "e aí eu" fica junto, sem virar "e, aí eu"
    .replace(/(?<!\be)\s+(mas|por[eé]m|ent[aã]o|s[oó] que|sen[aã]o|tipo assim|a[ií] (eu|ele|ela|a gente|voc[eê]|n[oó]s|eles|elas|depois|sim|n[aã]o)|e a[ií])\b/gi, ', $1')
    .replace(/^,\s*/, '');
  partes.push({ t: resto, fim: '' });
  return partes;
}
/** Regra local (sem IA). Aceita as marcas de pausa " | ". */
export function pontuarLocal(texto) {
  const pedacos = String(texto || '').split('|').map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!pedacos.length) return '';
  const itens = [];
  pedacos.forEach((p, i) => {
    const partes = trecho(minusculas(p));
    partes.forEach((x, j) => {
      let fim = x.fim;
      if (!fim) {
        const ultimo = i === pedacos.length - 1 && j === partes.length - 1;
        // cada pausa: "?" se o trecho é pergunta; senão vírgula (ou ponto no final)
        fim = ehPergunta(x.t) || ehPergunta(p) && j === partes.length - 1 ? '?' : ultimo ? '.' : ',';
      }
      if (x.t) itens.push(x.t.replace(/[,.!?]+$/, '') + fim);
    });
  });
  // maiúscula no começo e depois de . ? !
  return itens.join(' ').replace(/(^|[.?!]\s+)([a-zà-ú])/g, (m, a, b) => a + b.toUpperCase()).replace(/\s+,/g, ',');
}

async function pontuarGemini(texto, modelo, espera) {
  if (!config.geminiChave) throw new Error('sem chave');
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelo)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.geminiChave },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text:
        'Você recebe uma mensagem de WhatsApp ditada por voz em português do Brasil, sem pontuação. ' +
        'O sinal " | " marca onde a pessoa fez uma pausa ao falar: use isso para decidir vírgulas, pontos e interrogações, e tire os "|". ' +
        'Devolva a MESMA mensagem com a pontuação certa (vírgulas, pontos, interrogação, exclamação) e letras maiúsculas onde precisa. ' +
        'Ajuste também maiúsculas erradas no meio da frase. Mantenha as palavras, as gírias e o jeito de falar da pessoa: ' +
        'só corrija uma palavra se ela for claramente um erro do reconhecimento de voz (ex.: "chat de PT" → "ChatGPT"). ' +
        'O reconhecimento confunde "cem" (100) com "sem": quando for claramente uma quantidade, escreva o número (ex.: "sem folhas" num pedido → "100 folhas"). ' +
        'NÃO resuma, NÃO reescreva, NÃO acrescente nem tire frases. Responda só com a mensagem.' }] },
      contents: [{ role: 'user', parts: [{ text: texto }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 1000 },
    }),
    signal: AbortSignal.timeout(espera),
  });
  if (!r.ok) throw new Error(`Gemini ${r.status}`);
  const j = await r.json();
  const saida = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim().replace(/^["“]|["”]$/g, '').replace(/\s*\|\s*/g, ' ');
  // segurança: aceita pequenas correções do reconhecimento ("chat de PT" → "ChatGPT"); se reescreveu (mais de 2 palavras
  // ou 10% do texto), não usa
  if (!saida) throw new Error('resposta vazia');
  const a = soPalavras(texto).split(' '), b = soPalavras(saida).split(' ');
  if (distanciaPalavras(a, b) > Math.max(2, Math.ceil(a.length * 0.1))) throw new Error('a IA mudou palavras demais');
  return saida;
}

export let ultimoErro = ''; // para o log: por que caiu na regra local

// "cem" e "sem" soam igual: o reconhecimento escreve "sem folhas" quando a pessoa disse "100 folhas".
// Quando "sem" vem antes de uma unidade/quantidade ou de "mil", "reais", "por cento", vira 100.
const UNIDADES = 'folhas?|unidades?|pe[cç]as?|caixas?|pacotes?|rolos?|resmas?|parafusos?|porcas?|arruelas?|placas?|chapas?|barras?|tubos?|sacos?|kits?|pares?|itens|item|c[oó]pias?|p[aá]ginas?|metros?|cent[ií]metros?|mil[ií]metros?|quil[oô]metros?|km|cm|mm|m|quilos?|kg|gramas?|g|litros?|ml|toneladas?|reais|real|d[oó]lares?|euros?|mil|milh[oõ]es|por cento|%|graus?|horas?|minutos?|dias?|metros quadrados|m2|m²';
const CEM = new RegExp(`(^|[^\\p{L}\\p{N}])[Ss]em\\s+(?=(?:${UNIDADES})(?![\\p{L}]))`, 'gu');
const CEM_E = /(^|[^\p{L}\p{N}])[Ss]em e (\d{1,2})(?!\d)/gu; // "sem e 20 folhas" → "120 folhas"
export function corrigirCem(t) {
  return String(t || '').replace(CEM_E, (m, a, n) => `${a}${100 + Number(n)}`).replace(CEM, '$1100 ');
}

/** Texto ditado (pode ter marcas de pausa " | ") → texto pontuado, sem as marcas. */
export async function pontuar(texto) {
  const t = corrigirCem(String(texto || '').replace(/\s+/g, ' ').trim());
  ultimoErro = '';
  if (!t) return t;
  if (/[.,!?;:]/.test(t)) return t.replace(/\s*\|\s*/g, ' ').trim(); // já veio pontuado (transcrição do Gemini)
  if (soPalavras(t).split(' ').length < 3) return pontuarLocal(t); // "sim", "tô indo": não precisa de IA
  // o modelo principal e, se ele falhar ou demorar, um reserva (5 s cada); só então a regra local
  const modelos = [...new Set([config.geminiModelo || 'gemini-flash-lite-latest', ...(config.geminiReservas || [])])].slice(0, 2);
  const erros = [];
  for (const m of modelos) {
    try { return await pontuarGemini(t, m, 5000); }
    catch (e) { erros.push(`${m}: ${e.message}`); }
  }
  ultimoErro = erros.join(' | ');
  return pontuarLocal(t);
}
