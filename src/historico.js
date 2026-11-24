// "Perguntar ao histórico": "o que a Ana falou sobre o carro?", "qual era o valor que o Bruno passou?".
// Procura nas mensagens dos últimos 7 dias (dados/historico.jsonl: WhatsApp e e-mail que chegaram), filtra pela
// pessoa ou grupo citado na pergunta e pede ao Gemini uma resposta curta, para ser falada.
import fs from 'node:fs';
import path from 'node:path';
import { config, DADOS } from './config.js';

const HIST = path.join(DADOS, 'historico.jsonl');
const DIAS = 7;
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const semEmoji = (s) => String(s || '').replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '').replace(/\s+/g, ' ').trim();

function lerHistorico() {
  let linhas = [];
  try {
    const fd = fs.openSync(HIST, 'r'); const tam = fs.fstatSync(fd).size; const ler = Math.min(tam, 4_000_000);
    const buf = Buffer.alloc(ler); fs.readSync(fd, buf, 0, ler, tam - ler); fs.closeSync(fd);
    linhas = buf.toString('utf8').split('\n');
  } catch { return []; }
  const limite = Date.now() - DIAS * 86_400_000;
  const itens = [];
  for (const l of linhas) {
    let x; try { x = JSON.parse(l); } catch { continue; }
    if (!x.quando || Date.parse(x.quando) < limite || x.prioridade === 'silencio') continue;
    itens.push(x);
  }
  return itens;
}

// Quem foi citado na pergunta? Compara as palavras da pergunta com os nomes (remetentes e grupos) do histórico.
// "aninha" acha "Ana"; "grupo da AMS" acha o grupo.
function citados(pergunta, itens) {
  const palavras = norm(pergunta).split(' ').filter((w) => w.length >= 3);
  const nomes = new Set();
  for (const x of itens) { if (x.de) nomes.add(semEmoji(x.de)); if (x.grupo) nomes.add(semEmoji(x.grupo)); }
  const achados = [];
  for (const nome of nomes) {
    const partes = norm(nome).split(' ').filter((w) => w.length >= 3);
    if (!partes.length) continue;
    const bate = partes.some((p) => palavras.some((w) => w === p || (w.length >= 4 && p.length >= 4 && (w.startsWith(p) || p.startsWith(w)))));
    if (bate) achados.push(nome);
  }
  return achados;
}

function linha(x) {
  const d = new Date(x.quando);
  const quando = `${d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' })} ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  const onde = x.canal === 'email' ? `e-mail de ${semEmoji(x.de)}${x.assunto ? ` (assunto: ${x.assunto})` : ''}` : x.grupo ? `grupo ${semEmoji(x.grupo)}` : `WhatsApp de ${semEmoji(x.de)}`;
  const texto = String(x.texto || x.resumo || '').replace(/\s+/g, ' ').slice(0, 500);
  return `[${quando}] ${onde}: ${texto}`;
}

async function gemini(pergunta, contexto, modelo) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelo)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.geminiChave },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text:
        `Você é um assistente de voz em português do Brasil. Hoje é ${new Date().toLocaleString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}. ` +
        'Responda à pergunta usando SOMENTE as mensagens abaixo (WhatsApp e e-mail recebidos nos últimos dias). ' +
        'A resposta vai ser FALADA: 1 a 3 frases curtas, sem listas, sem emojis, sem links. Diga quem falou e quando (ex.: "hoje às 10h", "ontem à tarde"). ' +
        'Use o nome da pessoa em vez de "ele" ou "ela" (você não sabe o gênero de ninguém). Valores e números como a pessoa escreveu. Se não estiver nas mensagens, diga que não achou nada sobre isso nos últimos dias. Não invente.' }] },
      contents: [{ role: 'user', parts: [{ text: `Mensagens:\n${contexto}\n\nPergunta: ${pergunta}` }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 400 },
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`Gemini ${r.status}`);
  const j = await r.json();
  return (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').replace(/[*_#`]/g, '').trim();
}

/** pergunta falada → resposta para falar (e quem foi encontrado, para o log) */
export async function perguntarHistorico(pergunta) {
  const todos = lerHistorico();
  if (!todos.length) return { resposta: 'Ainda não tenho mensagens guardadas para procurar.' };
  const nomes = citados(pergunta, todos);
  let itens = todos.filter((x) => x.prioridade !== 'baixa');
  if (nomes.length) {
    const alvo = nomes.map(norm);
    // mensagens da pessoa (ou do grupo) e as falas dela dentro de grupos ("Ana: ...")
    itens = todos.filter((x) => alvo.includes(norm(x.de)) || alvo.includes(norm(x.grupo)) ||
      nomes.some((n) => String(x.texto || '').includes(`${n}:`) || String(x.texto || '').includes(`${semEmoji(n)}:`)));
  }
  if (!itens.length) return { resposta: `Não achei mensagens ${nomes.length ? `de ${nomes.join(' ou ')} ` : ''}nos últimos ${DIAS} dias.`, nomes };
  // as mais recentes, até ~60 mil caracteres
  const linhas = []; let total = 0;
  for (let i = itens.length - 1; i >= 0 && linhas.length < 300; i--) {
    const l = linha(itens[i]); total += l.length; if (total > 60_000) break; linhas.unshift(l);
  }
  if (!config.geminiChave) return { resposta: 'Para procurar nas mensagens eu preciso da chave do Gemini.', nomes };
  // buscar no meio de centenas de mensagens precisa de um modelo mais forte que o "lite" (que respondia "não achei")
  const fortes = (config.geminiReservas || []).filter((m) => !/lite/.test(m));
  const modelos = [...new Set([...fortes.slice(-1), ...fortes, config.geminiModelo || 'gemini-flash-lite-latest'])].slice(0, 3);
  for (const m of modelos) {
    try { const resposta = await gemini(pergunta, linhas.join('\n'), m); if (resposta) return { resposta, nomes, usadas: linhas.length }; }
    catch {}
  }
  return { resposta: 'Não consegui procurar agora: o Google não respondeu. Tenta de novo daqui a pouco.', nomes };
}
