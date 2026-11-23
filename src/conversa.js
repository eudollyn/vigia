// Conversa por voz depois de um aviso do WhatsApp:
//   (aviso lido) → microfone abre → "responda" → "O que você quer responder?" → ditado →
//   "Vou responder: ... Posso enviar?" → "enviar" envia / qualquer outra coisa cancela.
// Nada é enviado sem o "enviar" dito por você.
import fs from 'node:fs';
import path from 'node:path';
import { config, DADOS } from './config.js';
import { log, tocarArquivo, notificar } from './avisos.js';

// bipe de 0,15 s a 880 Hz, gerado uma vez
function criarBipe() {
  const arq = path.join(DADOS, 'bipe.wav');
  if (fs.existsSync(arq)) return arq;
  const taxa = 24000, n = Math.round(taxa * 0.15), pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / 240, (n - i) / 240);
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 880 * i) / taxa) * 9000 * env), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(taxa, 24);
  h.writeUInt32LE(taxa * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(arq, Buffer.concat([h, pcm]));
  return arq;
}
import { ouvir, micRemotoAtivo } from './microfone.js';
import { transcrever } from './transcrever.js';

const PEDIU_RESPOSTA = /\b(respond[aeo]r?|responde|resposta|responda)\b/i;
// Confirmação: frase CURTA (até 5 palavras) com uma palavra de "sim". Frase longa = correção do texto.
const PALAVRA_SIM = /\b(envia[r]?|envie|enviou|manda[r]?|mande|manda ver|sim|pode|confirm[ao]|confirmado|isso|ok|okay|beleza|certo|perfeito|claro|bora)\b/i;
const CANCELA = /\b(cancela[r]?|cancele|nao|deixa pra la|deixa|esquece|para tudo)\b/i;
const palavras = (s) => s.split(/\s+/).filter(Boolean).length;
export const confirmou = (s) => palavras(s) <= 5 && PALAVRA_SIM.test(s) && !CANCELA.test(s);

const semAcento = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

let bipe;
async function ouvirTexto(opcoes, rotulo, dica = []) {
  if (!bipe) bipe = criarBipe();
  log(`voz: escutando (${rotulo})…`);
  const remoto = await micRemotoAtivo();       // no notebook, a própria página toca o bipe
  const gravando = ouvir(opcoes);              // abre o microfone já
  if (!remoto) setTimeout(() => tocarArquivo(bipe), 350); // bipe curto quando o microfone já está aberto: "pode falar"
  const audio = await gravando;
  if (!audio) { log(`voz: ninguém falou (${rotulo})`); return ''; }
  try { return await transcrever(audio, dica); }
  catch (e) { log(`transcrição falhou: ${e.message}`); return ''; }
}

/**
 * item: aviso de WhatsApp com { de, grupo?, jid }
 * dizer(texto) → Promise que termina quando a fala acaba
 * enviar(jid, texto) → Promise
 */
export async function talvezResponder(item, { dizer, enviar, pedido: jaPedido = "" }) {
  if (!config.responderVoz || !item.jid || !enviar) return;

  // 1) janela curta esperando "responda" (ou o "responda" já veio do comando de voz do notebook)
  const pedido = jaPedido || await ouvirTexto({ esperaMs: config.janelaMs, silencioMs: 900, maxMs: 15000 }, 'responda?');
  if (!pedido) return;
  if (jaPedido) await dizer(`Respondendo para ${item.grupo ? 'o grupo ' + item.grupo : item.de}.`);
  if (!PEDIU_RESPOSTA.test(semAcento(pedido))) { log(`voz: ouvi "${pedido}" (não era "responda")`); return; }

  const para = item.grupo ? `o grupo ${item.grupo}` : item.de;
  // "responda: estou chegando" já traz o texto junto
  let texto = pedido.replace(/^.*?\b(respond[aeo]r?|responde|responda)\b[\s,:.-]*/i, '').trim();
  if (texto.split(/\s+/).filter(Boolean).length < 2) {
    await dizer('O que você quer responder?');
    texto = await ouvirTexto({ esperaMs: 8000, silencioMs: 1600, maxMs: 45000 }, 'ditado');
    if (!texto) { await dizer('Não ouvi nada. Cancelei.'); return; }
  }
  return confirmarEEnviar(item, texto, { dizer, enviar, verbo: 'responder' });
}

/** Pergunta em voz alta e devolve o que a pessoa respondeu (texto transcrito, ou '' se ninguém falou). */
export async function perguntar(dizer, pergunta, rotulo = 'pergunta', dica = []) {
  await dizer(pergunta);
  return ouvirTexto({ esperaMs: 8000, silencioMs: 1300, maxMs: 15000 }, rotulo, dica);
}

/**
 * "Envia mensagem para Fulano": destino = { jid, de, grupo?, privado? }.
 * Se o texto já veio no comando ("... dizendo que chego às 7"), pula a pergunta.
 */
export async function enviarMensagemPorVoz(destino, textoJa, { dizer, enviar }) {
  if (!enviar) { await dizer('O WhatsApp ainda não está conectado.'); return; }
  const para = semEmoji(destino.grupo ? `o grupo ${destino.grupo}` : destino.de);
  let texto = (textoJa || '').trim();
  if (palavras(texto) < 1) {
    texto = await perguntar(dizer, `Qual mensagem para ${para}?`, 'ditado');
    if (!texto) { await dizer('Não ouvi nada. Cancelei.'); return; }
  }
  return confirmarEEnviar(destino, texto, { dizer, enviar, verbo: 'enviar' });
}

// Lê o texto de volta (ou só mostra na tela, se for contato privado) e só envia com "enviar"/"sim"/"pode".
const semEmoji = (s) => String(s || '').replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '').replace(/\s+/g, ' ').trim();
async function confirmarEEnviar(item, texto, { dizer, enviar, verbo }) {
  item = { ...item, de: semEmoji(item.de), grupo: item.grupo && semEmoji(item.grupo) };
  const para = item.grupo ? `o grupo ${item.grupo}` : item.de;
  let tentativasExtra = 0, repetirTexto = true;
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    if (repetirTexto) {
      if (item.privado) {
        // contato privado: o texto aparece só na tela, a voz não lê
        notificar(`Mensagem para ${item.de}`, texto);
        await dizer(`Vou ${verbo} para ${para}. O texto está na tela. Posso enviar?`);
      } else await dizer(`Vou ${verbo} para ${para}: ${texto}. Posso enviar?`);
    }
    repetirTexto = true;
    const bruto = await ouvirTexto({ esperaMs: 7000, silencioMs: 1200, maxMs: 30000 }, 'confirmação');
    const resp = semAcento(bruto).toLowerCase();
    if (bruto) log(`voz: ouvi na confirmação "${bruto}"`);
    if (confirmou(resp)) {
      try {
        await enviar(item.jid, texto);
        log(`ENVIADO para ${para}: ${texto}`);
        await dizer('Enviado.');
      } catch (e) {
        log(`erro ao enviar para ${para}: ${e.message}`);
        await dizer('Não consegui enviar. A mensagem não foi.');
      }
      return;
    }
    if (!resp) { await dizer('Não ouvi a confirmação. Cancelei, não enviei nada.'); return; }
    if (palavras(resp) <= 5 && CANCELA.test(resp)) { await dizer('Cancelei. Não enviei nada.'); return; }
    // frase longa: trata como correção do texto e confirma de novo
    if (palavras(resp) > 5) texto = bruto;
    else { await dizer('Não entendi. Diga enviar, ou cancela.'); repetirTexto = false; tentativa--; if (++tentativasExtra > 1) break; continue; }
  }
  await dizer('Não entendi. Cancelei, não enviei nada.');
}
