// Leitor de e-mail por IMAP (Locaweb). Usa IDLE: o servidor avisa na hora em que chega mensagem.
// Só leitura: busca com BODY.PEEK, então nada é marcado como lido no Outlook.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import fs from 'node:fs';
import path from 'node:path';
import { config, DADOS } from './config.js';
import { log, notificar } from './avisos.js';

const ESTADO = path.join(DADOS, 'email-estado.json');
const lerEstado = () => { try { return JSON.parse(fs.readFileSync(ESTADO, 'utf8')); } catch { return {}; } };
const salvarEstado = (s) => fs.writeFileSync(ESTADO, JSON.stringify(s));

export function textoDoEmail(m) {
  let t = m.text || '';
  if (!t && m.html) t = m.html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
  // corta histórico de resposta ("Em ... escreveu:" / "De: ... Enviado:")
  t = t.split(/\n\s*(Em .{5,120} escreveu:|On .{5,120} wrote:|-{2,}\s*Mensagem original|De:\s.*\n\s*Enviad[oa])/i)[0];
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

export function ehAutomatico(m) {
  const h = m.headers;
  const from = m.from?.value?.[0]?.address || '';
  return Boolean(h.get('list-unsubscribe') || /bulk|list|junk/i.test(String(h.get('precedence') || '')) ||
    /no-?reply|nao-?responda|naoresponda|mailer-daemon|newsletter|news@|marketing@|mkt@|promo|ofertas@|e-?mkt/i.test(from));
}

export function iniciarEmail(aoChegar) {
  let tentativas = 0;
  const estado = lerEstado();

  async function processar(cliente, desdeUid, inicial) {
    const uids = (await cliente.search({ uid: `${desdeUid}:*` }, { uid: true }) || []).filter((u) => u >= desdeUid).sort((a, b) => a - b);
    if (!uids.length) return;
    let lista = uids;
    if (inicial) globalThis.vigiaEmailsOffline = uids.length; // para o "bom dia"
    if (inicial && uids.length > 10) {
      notificar('✉️ E-mails enquanto o PC estava desligado', `Chegaram ${uids.length} e-mails. Lendo os 10 mais recentes.`);
      lista = uids.slice(-10);
    }
    for await (const msg of cliente.fetch(lista.join(','), { uid: true, source: true, envelope: true }, { uid: true })) {
      estado.ultimoUid = Math.max(estado.ultimoUid || 0, msg.uid);
      try {
        const m = await simpleParser(msg.source);
        const remet = m.from?.value?.[0] || {};
        await aoChegar({
          canal: 'email',
          de: remet.name || remet.address || 'remetente desconhecido',
          endereco: remet.address,
          assunto: m.subject || '(sem assunto)',
          texto: textoDoEmail(m),
          anexos: (m.attachments || []).filter((a) => !a.related).map((a) => a.filename).filter(Boolean),
          automatico: ehAutomatico(m),
        });
      } catch (e) { log(`e-mail ${msg.uid}: erro ao ler (${e.message})`); }
    }
    salvarEstado(estado);
  }

  async function conectar() {
    const cliente = new ImapFlow({
      host: config.email.host, port: config.email.porta, secure: config.email.porta === 993,
      auth: { user: config.email.usuario, pass: config.email.senha },
      logger: false, emitLogs: false,
    });
    let reconectando = false;
    const reconectar = () => {
      if (reconectando) return; reconectando = true;
      const espera = Math.min(300, 5 * 2 ** Math.min(tentativas++, 6));
      log(`e-mail: conexão fechada, reconectando em ${espera}s`);
      setTimeout(conectar, espera * 1000);
    };
    cliente.on('error', (e) => log(`e-mail: ${e.message}`));
    cliente.on('close', reconectar);

    try {
      await cliente.connect();
      const caixa = await cliente.mailboxOpen('INBOX', { readOnly: true });
      tentativas = 0;
      if (estado.validade !== String(caixa.uidValidity) || !estado.ultimoUid) {
        // primeira vez (ou caixa recriada): começa do zero, sem avisar o que já estava lá
        estado.validade = String(caixa.uidValidity);
        estado.ultimoUid = caixa.uidNext - 1;
        salvarEstado(estado);
        log(`e-mail: conectado em ${config.email.usuario}, vigiando a Caixa de Entrada.`);
      } else {
        log(`e-mail: conectado em ${config.email.usuario}.`);
        await processar(cliente, estado.ultimoUid + 1, true);
      }
      let ocupado = false;
      cliente.on('exists', async () => {
        if (ocupado) return; ocupado = true;
        try { await processar(cliente, (estado.ultimoUid || 0) + 1, false); }
        catch (e) { log(`e-mail: erro ao buscar novos (${e.message})`); }
        finally { ocupado = false; }
      });
      // O imapflow entra em IDLE sozinho quando está ocioso.
    } catch (e) {
      if (/auth|login|credentials|LOGIN/i.test(e.message) || e.authenticationFailed) {
        log('e-mail: usuário ou senha recusados pela Locaweb. Confira o .env.');
        notificar('Vigia: e-mail não conectou', 'Usuário ou senha recusados. Confira o arquivo .env.', true);
        cliente.removeAllListeners('close');
        return;
      }
      log(`e-mail: falha ao conectar (${e.message})`);
      try { await cliente.logout(); } catch {}
      reconectar();
    }
  }
  conectar();
}
