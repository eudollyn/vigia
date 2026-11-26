// Vigia · github.com/eudollyn/vigia · AGPL-3.0-or-later · VGA-EUD-2026
const FILTROS = new Set(['contato', 'palavra_chave', 'desde', 'ate', 'limite']);
const LIMITE_TEXTO = 2000;
const normalizar = (texto) => texto.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
const chatIndividual = (jid) => /^\d+(?::\d+)?@(?:s\.whatsapp\.net|lid)$/.test(jid || '');

function lerFiltro(campo, valor, maximo) {
  if (valor === undefined) return '';
  if (typeof valor !== 'string' || valor.length > maximo || !normalizar(valor)) {
    throw new Error(`${campo} deve ter entre 1 e ${maximo} caracteres.`);
  }
  return valor.trim();
}

function lerData(campo, valor, padrao) {
  if (valor === undefined) return padrao;
  const formato = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
  const dia = typeof valor === 'string' && formato.exec(valor)?.[1];
  const horario = dia && Date.parse(valor);
  const meiaNoiteUTC = dia && Date.parse(dia + 'T00:00:00Z');
  if (!Number.isFinite(horario) || !Number.isFinite(meiaNoiteUTC)
    || new Date(meiaNoiteUTC).toISOString().slice(0, 10) !== dia) {
    throw new Error(`${campo} deve ser uma data e hora ISO 8601 com fuso horário (Z ou ±HH:MM).`);
  }
  return horario;
}

export function validarConsulta(filtros) {
  if (!filtros || typeof filtros !== 'object' || Array.isArray(filtros)
    || Object.keys(filtros).some((campo) => !FILTROS.has(campo))) {
    throw new Error('Use apenas contato, palavra_chave, desde, ate e limite.');
  }
  const contato = normalizar(lerFiltro('contato', filtros.contato, 120));
  const palavra = normalizar(lerFiltro('palavra_chave', filtros.palavra_chave, 200));
  const desde = lerData('desde', filtros.desde, -Infinity);
  const ate = lerData('ate', filtros.ate, Infinity);
  if (!contato && !palavra && desde === -Infinity && ate === Infinity) {
    throw new Error('Informe um contato, uma palavra-chave ou um período.');
  }
  if (desde > ate) throw new Error('desde deve ser anterior ou igual a ate.');
  const limite = filtros.limite === undefined ? 10 : filtros.limite;
  if (!Number.isInteger(limite) || limite < 1 || limite > 30) {
    throw new Error('limite deve ser um número inteiro de 1 a 30.');
  }
  return { contato, palavra, desde, ate, limite };
}

function textoConsultavel(mensagem) {
  // Wrappers temporários e de visualização única nunca são abertos.
  const { conversation, extendedTextMessage, imageMessage, videoMessage, documentWithCaptionMessage } = mensagem || {};
  const documentMessage = mensagem?.documentMessage || documentWithCaptionMessage?.message?.documentMessage;
  if (mensagem?.ephemeralMessage || mensagem?.viewOnceMessage || mensagem?.viewOnceMessageV2
    || mensagem?.viewOnceMessageV2Extension) {
    return '';
  }
  const conteudo = extendedTextMessage || imageMessage || videoMessage || documentMessage;
  if (conteudo?.viewOnce || Number(conteudo?.contextInfo?.expiration) > 0) return '';
  return [conversation, extendedTextMessage?.text, imageMessage?.caption, videoMessage?.caption, documentMessage?.caption]
    .find((texto) => typeof texto === 'string' && texto.trim()) || '';
}

export function consultarRecebidas({ porChat, msgs }, { contato, palavra, desde, ate, limite }, {
  decodificar, idsDoContato, estaArquivada, nomesDoContato,
}) {
  const resultados = [];
  const vistos = new Set();
  for (const [jid, ids] of Object.entries(porChat || {})) {
    if (!chatIndividual(jid) || !Array.isArray(ids)) continue;
    for (const id of ids) {
      if (typeof id !== 'string' || vistos.has(id) || !Object.hasOwn(msgs || {}, id)) continue;
      let msg;
      try {
        msg = decodificar(msgs[id]);
      } catch {
        continue; // Um registro antigo ou danificado não impede a consulta dos demais.
      }
      if (!msg?.key || msg.key.fromMe || msg.key.remoteJid !== jid || msg.key.id !== id) continue;
      vistos.add(id);
      if (Number(msg.ephemeralDuration) > 0 || Number(msg.ephemeralStartTimestamp) > 0) continue;

      const horario = Number(msg.messageTimestamp) * 1000;
      if (!Number.isFinite(horario) || horario <= 0 || horario > 8.64e15 || horario < desde || horario > ate) continue;
      const texto = textoConsultavel(msg.message);
      if (!texto || (palavra && !normalizar(texto).includes(palavra))) continue;

      const alternativo = msg.key.remoteJidAlt;
      const aliases = [...new Set([jid, alternativo].filter(chatIndividual).flatMap(idsDoContato))];
      if (estaArquivada(aliases)) continue;
      const nomes = [...aliases.flatMap(nomesDoContato), msg.pushName]
        .filter((nome) => typeof nome === 'string' && nome.trim());
      if (contato && !nomes.some((nome) => normalizar(nome).includes(contato))) continue;
      resultados.push({
        contato: nomes[0]?.trim().slice(0, 120) || 'Contato sem nome',
        recebido_em: new Date(horario).toISOString(),
        texto: texto.slice(0, LIMITE_TEXTO),
        ...(texto.length > LIMITE_TEXTO ? { texto_truncado: true } : {}),
      });
    }
  }
  resultados.sort((a, b) => b.recebido_em.localeCompare(a.recebido_em));
  return { mensagens: resultados.slice(0, limite), ha_mais: resultados.length > limite };
}
