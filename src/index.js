// Vigia de mensagens: WhatsApp + e-mail → resumo pelo Claude → notificação do Windows + voz.
import fs from 'node:fs';
import path from 'node:path';
import { config, emailAtivo, DADOS } from './config.js';
import { avisar, iniciarResumoBaixa, log, notificar } from './avisos.js';
import { resumir, resumoSimples } from './resumo.js';
import { iniciarEmail } from './email.js';
import { iniciarWhatsApp } from './whatsapp.js';

// Impede duas cópias rodando ao mesmo tempo (duas conexões do WhatsApp brigariam).
const TRAVA = path.join(DADOS, 'vigia.pid');
try {
  const pid = Number(fs.readFileSync(TRAVA, 'utf8'));
  if (pid && pid !== process.pid) { process.kill(pid, 0); console.log(`O Vigia já está rodando (processo ${pid}).`); process.exit(0); }
} catch {}
fs.writeFileSync(TRAVA, String(process.pid));
const soltar = () => { try { if (Number(fs.readFileSync(TRAVA, 'utf8')) === process.pid) fs.unlinkSync(TRAVA); } catch {} };
process.on('exit', soltar);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(0));
process.on('unhandledRejection', (e) => log(`erro não tratado: ${e?.message || e}`));
process.on('uncaughtException', (e) => log(`erro não tratado: ${e?.message || e}`));

const dominioProprio = (config.email.usuario.split('@')[1] || '').toLowerCase();
const mesmoDominio = (end) => Boolean(dominioProprio && String(end || '').toLowerCase().endsWith('@' + dominioProprio));

async function aoChegar(msg) {
  // Regra: só os nomes de BAIXA_PRIORIDADE (ex.: grupo de promoções) ficam em baixa; todo o resto avisa e fala.
  const nome = `${msg.grupo || ''} ${msg.de || ''} ${msg.endereco || ''}`.toLowerCase();
  const ehBaixa = config.baixaPrioridade.some((b) => nome.includes(b));
  // Baixa prioridade nunca é falada: não gasta a cota da IA com ela (resumo simples basta para o resumo de hora em hora)
  // recuperadas de grupo (de quando o Vigia estava fora) também não gastam a IA: podem ser muitas de uma vez
  // resumo pela IA: no máximo 10 s (com o Gemini sobrecarregado ele tenta vários modelos e o aviso atrasava minutos)
  const r = ehBaixa || (msg.atrasada && msg.grupo) ? resumoSimples(msg)
    : await Promise.race([resumir(msg), new Promise((ok) => setTimeout(() => { log('resumo: IA demorou mais de 10 s, aviso sem esperar'); ok(resumoSimples(msg)); }, 10_000))]);
  if (ehBaixa) r.prioridade = 'baixa';
  // E-mail de newsletter/anúncio: não avisa nada (só fica no histórico). Exige as DUAS coisas: a IA achar que é
  // propaganda E o e-mail ter marca de envio em massa (Precedence: bulk, noreply, mkt@...). E-mail do próprio domínio nunca.
  else if (msg.canal === 'email' && r.prioridade === 'baixa' && msg.automatico && !mesmoDominio(msg.endereco)) r.prioridade = 'silencio';
  else if (r.prioridade === 'baixa') r.prioridade = 'normal';
  // e-mails de pessoas (não propaganda) entram no resumo do bom dia
  if (msg.canal === 'email' && !['silencio', 'baixa'].includes(r.prioridade) && !msg.automatico) {
    import('./pendencias.js').then((p) => p.emailRecebido(msg.de, msg.assunto)).catch(() => {});
  }
  if (msg.canal === 'email' && msg.anexos?.length) r.resumo += ` (anexo: ${msg.anexos.slice(0, 3).join(', ')})`;
  // Mensagem curta do WhatsApp: fala as PALAVRAS EXATAS da pessoa (a IA reescrevia "faz o L" como "fazendo o L")
  const literal = falaLiteral(msg);
  if (literal) r.fala = literal;
  await avisar({ ...msg, ...r, textoOriginal: undefined });
}

const LIMITE_LITERAL = 30; // palavras
function falaLiteral(msg) {
  if (msg.canal !== 'whatsapp' || !msg.texto || msg.grupo) return null; // grupos: várias pessoas juntas, fica o resumo
  let t = String(msg.texto);
  let prefixo = '';
  const audio = /^\[mandou um áudio de \d+ segundos dizendo:\]\s*/.exec(t);
  if (audio) { prefixo = 'Mandou um áudio: '; t = t.slice(audio[0].length); }
  else if (/^\[/.test(t)) return null; // foto, figurinha, arquivo…: fica a descrição da IA
  t = t.replace(/https?:\/\/\S+/g, 'um link').replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '').replace(/\s+/g, ' ').trim();
  if (!t || t.split(' ').length > LIMITE_LITERAL) return null;
  // entre aspas: a voz lê como citação (sem aspas, "Faz o L." virava "fazendão UEL")
  return `${prefixo}"${t.replace(/"/g, '')}"`;
}

// Vigia · github.com/eudollyn/vigia · AGPL-3.0 · VGA-EUD-2026 (manter este crédito em cópias e versões modificadas)
log('Vigia iniciado.');
console.log('Vigia · software livre (AGPL-3.0) · https://github.com/eudollyn/vigia');
const ligados = [];
if (config.whatsapp) { iniciarWhatsApp(aoChegar); ligados.push('WhatsApp'); }
if (emailAtivo()) { iniciarEmail(aoChegar); ligados.push('e-mail'); }
else log('E-mail desligado: preencha EMAIL_USUARIO e EMAIL_SENHA no .env para ativar.');
iniciarResumoBaixa();
// conector do ChatGPT (MCP): o GPT envia pelo WhatsApp/e-mail, com anexos da pasta arquivos-para-o-gpt
if (config.gpt) import('./conector-gpt.js').then((m) => m.iniciarConectorGPT()).catch((e) => log(`ChatGPT: conector falhou (${e.message})`));
if (config.saidaVoz !== 'pc') {
  const af = await import('./alto-falante.js');
  (await import('./comandos.js')).iniciarComandos(af);
  af.iniciarAltoFalante();
}

if (!ligados.length) {
  log('Nada para vigiar: ligue o WhatsApp ou configure o e-mail no .env.');
  process.exit(1);
}
notificar('Vigia ligado', `Vigiando: ${ligados.join(' e ')}.${config.claude ? '' : ' (resumo sem Claude)'}`);
