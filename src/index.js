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
  const r = ehBaixa ? resumoSimples(msg) : await resumir(msg);
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
  await avisar({ ...msg, ...r, textoOriginal: undefined });
}

log('Vigia iniciado.');
const ligados = [];
if (config.whatsapp) { iniciarWhatsApp(aoChegar); ligados.push('WhatsApp'); }
if (emailAtivo()) { iniciarEmail(aoChegar); ligados.push('e-mail'); }
else log('E-mail desligado: preencha EMAIL_USUARIO e EMAIL_SENHA no .env para ativar.');
iniciarResumoBaixa();
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
