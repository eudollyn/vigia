// Comandos de voz ditos no notebook (a página fica ouvindo) e o "bom dia" ao ligar.
//   "até amanhã" → avisa e desliga o PC por completo em 15 s ("cancela" nesse tempo desfaz)
//   "responda"   → responde a última mensagem de WhatsApp (dos últimos 15 min)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config, DADOS } from './config.js';
import { log, dizer, naFila, notificar, ultimoAvisoWhatsApp, enviarPeloWhatsApp } from './avisos.js';

const TESTE = process.env.VIGIA_TESTE_DESLIGAR === '1'; // ensaio: não desliga de verdade
let desligando = false;

function shutdown(args) {
  if (TESTE) { log(`(ENSAIO) shutdown ${args.join(' ')}`); return; }
  spawn('shutdown.exe', args, { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
}

async function ateAmanha() {
  if (desligando) return;
  desligando = true;
  log('comando: até amanhã → desligando o PC em 15 s');
  // fala por cima da fila (é um comando direto) e agenda o desligamento completo (sem inicialização rápida)
  await dizer('Até amanhã! Desligando o PC em 15 segundos. Se quiser cancelar, diga cancela.');
  shutdown(['/s', '/full', '/f', '/t', '15', '/c', 'Vigia: até amanhã! Desligando o PC.']);
  notificar('🌙 Até amanhã', 'O PC desliga em 15 segundos. Diga "cancela" para desfazer.', true);
}

async function cancelar() {
  if (!desligando) return;
  desligando = false;
  shutdown(['/a']);
  log('comando: cancela → desligamento cancelado');
  await dizer('Cancelado. O PC continua ligado.');
}

async function responder(textoOuvido) {
  const item = ultimoAvisoWhatsApp();
  if (!item) { await naFila(() => dizer('Não tem mensagem recente para responder.')); return; }
  const { talvezResponder } = await import('./conversa.js');
  await naFila(() => talvezResponder(item, { dizer, enviar: enviarPeloWhatsApp(), pedido: textoOuvido }));
}

// "Envia mensagem para o Dênisson" (opcional: "... dizendo que chego às sete")
const tirarAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const limparNome = (s) => String(s || '').replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '').trim();
async function enviarPara(t) {
  const { buscarDestino, nomesConhecidos } = await import('./whatsapp.js');
  const { enviarMensagemPorVoz, perguntar } = await import('./conversa.js');
  let resto = (/mensage\w*\s+(?:para|pra|pro|pr[oa]s?|ao|à|a)\s+(.+)$/i.exec(t) || [])[1] || '';
  let texto = '';
  const d = /\s*,?\s+(?:dizendo|falando|avisando|perguntando)\s+(.+)$/i.exec(resto);
  if (d) { texto = d[1].replace(/^que\s+/i, ''); resto = resto.slice(0, d.index); }
  let nome = resto.replace(/^(o|a)\s+/i, '').replace(/[.,!?]+$/, '').trim();

  await naFila(async () => {
    const nomes = nomesConhecidos();
    if (!nome) nome = await perguntar(dizer, 'Para quem?', 'contato', nomes);
    if (!nome) return dizer('Não ouvi o nome. Cancelei.');
    let r = buscarDestino(nome);
    if (r.tipo === 'nenhum') {
      nome = await perguntar(dizer, `Não achei ${nome}. Fala só o nome do contato.`, 'contato', nomes);
      r = nome ? buscarDestino(nome) : r;
    }
    if (r.tipo === 'nenhum') return dizer('Não achei esse contato. Cancelei, não enviei nada.');
    let destino = r.destino;
    if (r.tipo === 'varios') {
      const ord = ['primeiro', 'segundo', 'terceiro', 'quarto'];
      const lista = r.opcoes.map((o, i) => `${ord[i]}, ${limparNome(o.de)}`).join('; ');
      const resp = tirarAcento(await perguntar(dizer, `Encontrei: ${lista}. Qual deles?`, 'escolha', r.opcoes.map((o) => o.de)));
      let i = ord.findIndex((o) => resp.includes(o));
      if (i < 0) i = [/\b(um|1)\b/, /\b(dois|2)\b/, /\b(tres|3)\b/, /\b(quatro|4)\b/].findIndex((re) => re.test(resp));
      if (i < 0 && resp) { const r2 = buscarDestino(resp); if (r2.tipo === 'ok') i = r.opcoes.findIndex((o) => o.jid === r2.destino.jid); }
      if (i < 0 || !r.opcoes[i]) return dizer('Não entendi qual. Cancelei, não enviei nada.');
      destino = r.opcoes[i];
    }
    destino = { ...destino, privado: !destino.grupo && config.privados.some((p) => tirarAcento(destino.de).includes(tirarAcento(p))) };
    log(`enviar por voz: destino ${destino.de}${destino.grupo ? ' (grupo)' : ''}`);
    await enviarMensagemPorVoz(destino, texto, { dizer, enviar: enviarPeloWhatsApp() });
  });
}

// "Me lembra às três de ligar pro cliente"
async function novoLembrete(t) {
  const { criarLembrete, quandoFalado } = await import('./lembretes.js');
  const r = await criarLembrete(t);
  await naFila(() => {
    if (r.ok) return dizer(`Combinado. ${quandoFalado(r.lembrete.quando)}, eu te lembro de ${r.lembrete.texto}.`);
    if (r.motivo === 'passado') return dizer('Esse horário já passou. Fala de novo com outro horário.');
    if (r.motivo === 'sem-hora') return dizer('Não entendi o horário. Fala, por exemplo: me lembra às três da tarde de ligar pro cliente.');
    return dizer('Não consegui criar o lembrete agora. Tenta de novo daqui a pouco.');
  });
}

export function iniciarComandos(af) {
  // dispara os lembretes na hora marcada: voz (mesmo no horário de silêncio), notificação e cartão na página
  import('./lembretes.js').then(({ iniciarLembretes }) => iniciarLembretes((l, atrasado) => {
    const nome = config.saudacaoNome ? config.saudacaoNome.replace(/^Sr\.?\s*/i, 'senhor ') + ', ' : '';
    notificar(`⏰ Lembrete${atrasado ? ' (atrasado)' : ''}`, l.texto, true);
    af.mostrarAviso({ canal: 'lembrete', de: '⏰ Lembrete', resumo: l.texto, urgente: true, hora: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) });
    naFila(() => dizer(`${nome}lembrete${atrasado ? ' atrasado, era para ' + new Date(l.quando).getHours() + ' horas' : ''}: ${l.texto}.`));
  }));
  af.aoComando(async (c, t) => {
    // segunda trava (caso a página seja antiga): desligar/cancelar só com frase curta; o botão manda "(botão)"
    const curta = t.includes('(botão)') || t.trim().split(/\s+/).filter(Boolean).length <= 4;
    if ((c === 'ate-amanha' || c === 'cancela') && !curta) { log(`comando ignorado (frase longa demais): "${t}"`); return; }
    if (c === 'enviar' && config.responderVoz) return enviarPara(t);
    if (c === 'lembrete') return novoLembrete(t);
    if (c === 'ate-amanha') return ateAmanha();
    if (c === 'cancela') return cancelar();
    if (c === 'responda' && config.responderVoz) return responder(t);
  });

  // Bom dia: na primeira vez do dia em que o notebook conecta na página (assim você ouve)
  const ARQ = path.join(DADOS, 'ultima-saudacao.txt');
  af.aoConectar(async () => {
    const hoje = new Date().toLocaleDateString('pt-BR');
    let ultima = '';
    try { ultima = fs.readFileSync(ARQ, 'utf8').trim(); } catch {}
    if (ultima === hoje) return;
    fs.writeFileSync(ARQ, hoje);
    const h = new Date().getHours();
    const oi = h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
    const data = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
    log(`saudação: ${oi}`);
    await new Promise((r) => setTimeout(r, 4000)); // dá tempo de o e-mail ler o que chegou com o PC desligado
    const { previsaoHoje } = await import('./clima.js');
    const { whatsSemResposta } = await import('./pendencias.js');
    const juntar = (l) => (l.length <= 1 ? l.join('') : `${l.slice(0, -1).join(', ')} e ${l[l.length - 1]}`);
    const unicos = (l) => [...new Set(l.map(limparNome).filter(Boolean))];

    const clima = await previsaoHoje();
    const zap = unicos(whatsSemResposta(30).map((p) => p.nome));
    // Só WhatsApp: e-mail nem sempre precisa de resposta, então não vira pendência.
    const pend = zap.length
      ? ` No WhatsApp, ${zap.length === 1 ? 'ficou sem resposta' : 'ficaram sem resposta'}: ${juntar(zap.slice(0, 4))}${zap.length > 4 ? ` e mais ${zap.length - 4}` : ''}.`
      : ' Nenhuma conversa esperando resposta no WhatsApp.';
    // "Sr." escrito por extenso para a voz ler "senhor"
    const nome = config.saudacaoNome ? `, ${config.saudacaoNome.replace(/^Sr\.?\s*/i, 'senhor ')}` : '';
    const frase = `${oi}${nome}! Hoje é ${data}.${clima ? ' ' + clima : ''}${pend}`;
    log(`saudação: ${frase}`);
    await naFila(() => dizer(frase));
  });
}
