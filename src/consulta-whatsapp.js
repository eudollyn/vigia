// Vigia · github.com/eudollyn/vigia · AGPL-3.0-or-later · VGA-EUD-2026
const FILTROS = new Set(['contato', 'telefone', 'palavra_chave', 'desde', 'ate', 'limite', 'ordem', 'deslocamento']);
const LIMITE_TEXTO = 2000;
const normalizar = (texto) => texto.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
const normalizarNome = (s) => normalizar(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const telefoneJid = (jid) => /^(\d+)(?::\d+)?@s\.whatsapp\.net$/.exec(jid || '')?.[1] || '';
const telefoneEntrada = (s) => {
  if (!s || !/^[+\d\s().-]+$/.test(s)) return '';
  let d = s.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  else if (!s.trim().startsWith('+') && (d.length === 10 || d.length === 11)) d = '55' + d;
  return d.length >= 10 && d.length <= 15 ? d : '';
};
const bateNome = (nome, q) => {
  const n = normalizarNome(nome);
  const f = normalizarNome(q);
  return !!f && (n.includes(f) || f.split(' ').every(w => n.split(' ').some(p => p.startsWith(w))));
};
const chatIndividual = (jid) => /^\d+(?::\d+)?@(?:s\.whatsapp\.net|lid)$/.test(jid || '');

// Resolve o LID com o mapa local do Baileys, somente quando os dois sentidos conferem.
export function expandirIdsConsulta(ids, lerMapa) {
  const aliases = new Set(ids.filter(chatIndividual));
  for (const jid of [...aliases]) {
    const pn = telefoneJid(jid);
    const lid = /^(\d+)(?::\d+)?@lid$/.exec(jid)?.[1];
    try {
      if (pn) {
        const l = String(lerMapa(pn, false) || '');
        if (/^\d+$/.test(l) && String(lerMapa(l, true)) === pn) aliases.add(l + '@lid');
      } else if (lid) {
        const p = String(lerMapa(lid, true) || '');
        if (/^\d{10,15}$/.test(p) && String(lerMapa(p, false)) === lid) aliases.add(p + '@s.whatsapp.net');
      }
    } catch {}
  }
  return [...aliases];
}

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
    throw new Error('Use apenas contato, telefone, palavra_chave, desde, ate, limite, ordem e deslocamento.');
  }
  const nomeOuNumero = lerFiltro('contato', filtros.contato, 120);
  const numeroNoContato = telefoneEntrada(nomeOuNumero);
  const contato = numeroNoContato ? '' : normalizar(nomeOuNumero);
  const telefoneInformado = lerFiltro('telefone', filtros.telefone, 40);
  const telefone = telefoneInformado ? telefoneEntrada(telefoneInformado) : numeroNoContato;
  if (telefoneInformado && !telefone) throw new Error('Informe um telefone completo com DDD e, se internacional, o código do país.');
  if (numeroNoContato && telefoneInformado && telefone !== numeroNoContato) throw new Error('Os dois telefones informados são diferentes.');
  const palavra = normalizar(lerFiltro('palavra_chave', filtros.palavra_chave, 200));
  const desde = lerData('desde', filtros.desde, -Infinity);
  const ate = lerData('ate', filtros.ate, Infinity);
  if (!contato && !telefone && !palavra && desde === -Infinity && ate === Infinity) {
    throw new Error('Informe um contato, uma palavra-chave ou um período.');
  }
  if (desde > ate) throw new Error('desde deve ser anterior ou igual a ate.');
  const limite = filtros.limite === undefined ? 10 : filtros.limite;
  if (!Number.isInteger(limite) || limite < 1 || limite > 30) {
    throw new Error('limite deve ser um número inteiro de 1 a 30.');
  }
  const ordem = filtros.ordem ?? 'recentes';
  if (!['recentes', 'cronologica'].includes(ordem)) throw new Error('ordem deve ser recentes ou cronologica.');
  const deslocamento = filtros.deslocamento ?? 0;
  if (!Number.isInteger(deslocamento) || deslocamento < 0 || deslocamento > 1000) throw new Error('deslocamento deve ser um inteiro de 0 a 1000.');
  return { contato, telefone, palavra, desde, ate, limite, ordem, deslocamento };
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

export function consultarRecebidas({ porChat, msgs }, { contato, telefone = '', palavra, desde, ate, limite, ordem = 'recentes', deslocamento = 0 }, {
  decodificar, idsDoContato, estaArquivada, nomesDoContato,
}) {
  const resultados = [];
  const vistos = new Set();
  let sequencia = 0;
  for (const [jid, ids] of Object.entries(porChat || {})) {
    if (!chatIndividual(jid) || !Array.isArray(ids)) continue;
    for (const id of ids) {
      sequencia++;
      if (typeof id !== 'string' || vistos.has(jid + ':' + id) || !Object.hasOwn(msgs || {}, id)) continue;
      let msg;
      try {
        msg = decodificar(msgs[id]);
      } catch {
        continue; // Um registro antigo ou danificado não impede a consulta dos demais.
      }
      if (!msg?.key || msg.key.fromMe || msg.key.remoteJid !== jid || msg.key.id !== id) continue;
      vistos.add(jid + ':' + id);
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
      const numeros = [...new Set(aliases.map(telefoneJid).filter(Boolean))];
      if (telefone && !numeros.includes(telefone)) continue;
      if (contato && !nomes.some((nome) => bateNome(nome, contato))) continue;
      resultados.push({
        contato: nomes[0]?.trim().slice(0, 120) || (numeros[0] ? '+' + numeros[0] : 'Contato sem nome'),
        ...(numeros[0] ? { numero: '+' + numeros[0] } : {}),
        _seq: sequencia,
        recebido_em: new Date(horario).toISOString(),
        texto: texto.slice(0, LIMITE_TEXTO),
        ...(texto.length > LIMITE_TEXTO ? { texto_truncado: true } : {}),
      });
    }
  }
  resultados.sort((a, b) => b.recebido_em.localeCompare(a.recebido_em) || b._seq - a._seq);
  const pagina = resultados.slice(deslocamento, deslocamento + limite);
  pagina.sort((a, b) => (ordem === 'cronologica' ? a.recebido_em.localeCompare(b.recebido_em) : b.recebido_em.localeCompare(a.recebido_em)) || a._seq - b._seq);
  const haMais = resultados.length > deslocamento + limite;
  return {
    mensagens: pagina.map(({ _seq, ...m }) => m),
    total_encontradas: resultados.length,
    ha_mais: haMais,
    ...(haMais ? { proximo_deslocamento: deslocamento + limite } : {}),
    cobertura: 'Cache local de mensagens recebidas: até 30 por conversa; não inclui histórico completo do WhatsApp, mensagens enviadas, grupos, arquivadas ou temporárias.',
  };
}
