// Extensao isolada do Vigia (AGPL-3.0-or-later, github.com/eudollyn/vigia, VGA-EUD-2026).
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

// Grupo de imóveis e contato do assistente que analisa os anúncios: no .env (fora do Git). Sem os dois, a extensão fica desligada.
export const GRUPO_IMOVEIS = process.env.VIGIA_IMOVEIS_GRUPO || '';
export const INSTI_IMOVEIS = process.env.VIGIA_IMOVEIS_INSTI || '';
const CABECALHO = 'VIGIA | Analise de imovel';
const HORA = 3600000;
const DOMINIOS = [
  ['olx.com.br', /\/imoveis\/[^/]+/i],
  ['quintoandar.com.br', /\/imovel\/[^/]+/i],
  ['vivareal.com.br', /\/imovel\/[^/]+/i],
  ['zapimoveis.com.br', /\/imovel\/[^/]+/i],
  ['imovelweb.com.br', /\/propriedades\/[^/]+/i],
  ['chavesnamao.com.br', /\/imovel\/[^/]+/i],
  ['netimoveis.com', /\/imovel\/[^/]+/i],
  ['imobiliaria.com.br', /\/imovel\/[^/]+/i],
];
export function linksImoveis(texto) {
  const links = new Set();
  for (const raw of String(texto || '').match(/https:\/\/[^\s<>"']+/gi) || []) {
    try {
      const u = new URL(raw.replace(/[),.;!?\]}]+$/, ''));
      if (u.username || u.password || u.port || u.protocol !== 'https:') continue;
      if (!DOMINIOS.some(([host, rota]) => (u.hostname === host || u.hostname.endsWith('.' + host)) && rota.test(u.pathname))) continue;
      u.search = ''; u.hash = '';
      links.add(u.href);
    } catch {}
  }
  return [...links];
}
function pedido(id, url) {
  return [
    'Vigia: analise este anuncio publico de aluguel para um casal:',
    url,
    'Pesquise com cuidado, mas responda como um amigo, em portugues simples. Abra a descricao e TODAS as fotos do anuncio, uma por uma, na galeria. Confira o total de fotos e quantas voce realmente viu. Avalie todos os ambientes visiveis, beleza, conservacao, espaco, luz e problemas aparentes. O casal valoriza uma casa bonita, acolhedora e bem cuidada, por dentro e por fora, com preco justo; nao basta ser barata ou grande. Observe especialmente fachada, muros, entrada, quintal, garagem, pintura, pisos e acabamentos. Diga em linguagem simples se o visual e agradavel e se ha algo feio, desgastado, mal acabado ou estranho que prejudique a vontade de morar ali, sem confundir gosto pessoal com defeito comprovado. Nao invente; se faltarem fotos ou comodos, diga que a avaliacao e parcial. Nao confunda imagem com descricao ou URL. Nao contorne restricoes.',
    'Confira aluguel, IPTU, condominio e total mensal conhecido (se faltar custo, diga que o total e parcial), tamanho, quartos, vagas e localizacao. Compare com anuncios individuais realmente semelhantes, de preferencia no mesmo bairro. Confira preco e disponibilidade anunciada; nao invente percentuais, use valores em reais e confira a conta. Se nao houver base suficiente, diga isso.',
    'Se encontrar alternativas realmente melhores, abra cada anuncio, leia a descricao e veja TODAS as fotos antes de recomenda-lo. Compare tambem a beleza, fachada, quintal, acabamento, conservacao e custo-beneficio geral, nao apenas preco, metragem ou numero de quartos. Evite indicar um imovel mais feio ou mal cuidado so porque custa menos ou tem mais espaco. Se tiver ressalvas esteticas relevantes, diga claramente; prefira nao indicar alternativa a recomendar uma casa que nao seja convincente. Confirme a disponibilidade anunciada quando possivel e declare se nao puder confirma-la. Escolha no maximo 2, com link direto, preco mensal conhecido e uma frase explicando por que cada um parece melhor. Nao recomende anuncios cuja galeria voce nao conseguiu ver inteira; se nao houver alternativas conferidas, diga que nao encontrou. Nao contate anunciantes.',
    'RESPOSTA FINAL CURTA: comece com "Preco bom", "Preco mais ou menos" ou "Preco ruim", ou "Nao da para avaliar o preco" se faltarem dados. Diga quanto custa por mes e em 2 ou 3 frases o que achou da casa, incluindo os principais pontos bons e ruins e quantas fotos viu (X de Y). Diga claramente se vale visitar, negociar (quanto) ou procurar outra. Depois, se houver, mostre as 1 ou 2 alternativas verificadas. Sem relatorio tecnico, lista foto por foto, nota numerica, porcentagens, jargao ou repeticoes. Mire em 1200 caracteres; maximo de 1800 incluindo links, sem contar marcadores. Nao sacrifique a pesquisa para encurtar a resposta.',
    'Nao inclua dados pessoais ou outras conversas. Entregue em uma unica mensagem FINAL; nao use marcadores em atualizacoes de andamento. Primeira e ultima linhas exatas, sem crases:',
    'VIGIA-IMOVEL:' + id,
    '[sua analise final curta]',
    'FIM-VIGIA:' + id,
  ].join('\n');
}
export function criarPonteImoveis({ pasta, log = () => {}, agora = Date.now, gerarId = () => randomBytes(8).toString('hex') }) {
  if (!/@g\.us$/.test(GRUPO_IMOVEIS) || !/@s\.whatsapp\.net$/.test(INSTI_IMOVEIS)) throw Error('desligado: VIGIA_IMOVEIS_GRUPO e VIGIA_IMOVEIS_INSTI não configurados no .env');
  const arquivo = path.join(pasta, 'vigia-imoveis.json');
  const desativado = path.join(pasta, 'vigia-imoveis.desativado');
  let estado;
  const salvar = () => {
    fs.writeFileSync(arquivo + '.tmp', JSON.stringify(estado, null, 2), 'utf8');
    fs.renameSync(arquivo + '.tmp', arquivo);
  };
  if (fs.existsSync(arquivo)) {
    estado = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
    if (!Number.isFinite(estado.ativadoEm) || !estado.jobs || typeof estado.jobs !== 'object' || Array.isArray(estado.jobs)) throw Error('estado invalido');
  } else {
    estado = { ativadoEm: Math.floor(agora()/1000), jobs: {} };
    salvar();
  }
  let fila = Promise.resolve();
  async function processar({ tipo, jid, ids = [], deMim, ts, texto, enviar }) {
    if (fs.existsSync(desativado) || !['notify', 'append'].includes(tipo)) return;
    if (!Number.isFinite(ts) || ts < estado.ativadoEm || ts * 1000 < agora() - 48 * HORA || ts * 1000 > agora() + HORA) return;
    const doGrupo = jid === GRUPO_IMOVEIS;
    const doInsti = !deMim && [jid, ...ids].includes(INSTI_IMOVEIS);
    if (!doGrupo && !doInsti) return;
    const jobs = estado.jobs;
    for (const [id, j] of Object.entries(jobs)) if (agora() - j.criado > 14*24*HORA) delete jobs[id];
    if (doGrupo) {
      if (String(texto || '').startsWith(CABECALHO)) return;
      for (const url of linksImoveis(texto)) {
        if (Object.values(jobs).some(j => j.url === url)) continue;
        if (Object.values(jobs).filter(j => ['reservado','enviado'].includes(j.status) && agora()-j.criado < 48*HORA).length >= 15) { log('Vigia imoveis: limite de 15 analises em aberto; novos links nao enviados'); break; }
        const id = gerarId();
        jobs[id] = { url, criado: agora(), status: 'reservado' };
        salvar(); // reserva antes de enviar: nunca reenvia automaticamente em caso de falha incerta
        try {
          await enviar(INSTI_IMOVEIS, pedido(id, url));
          jobs[id].status = 'enviado';
          log('Vigia imoveis: anuncio enviado ao Insti (' + id + ')');
        } catch { jobs[id].status = 'envio_incerto'; log('Vigia imoveis: envio falhou; nao sera repetido automaticamente (' + id + ')'); }
        salvar();
      }
    } else {
      const m = /^VIGIA-IMOVEL:([0-9a-f]{16})\r?\n([\s\S]+)\r?\nFIM-VIGIA:\1\s*$/.exec(String(texto || '').trim());
      if (!m) return; // outras conversas e respostas de andamento nunca saem do privado
      const [, id, corpo] = m;
      const j = jobs[id];
      if (!j || !['enviado','envio_incerto','reservado'].includes(j.status) || agora()-j.criado > 48*HORA || corpo.length > 6000 || /VIGIA-IMOVEL:|FIM-VIGIA:/.test(corpo)) return;
      j.status = 'entrega_reservada'; salvar();
      try {
        await enviar(GRUPO_IMOVEIS, CABECALHO + '\n' + j.url + '\n\nAnalise automatica do Insti (confirme os dados antes de decidir):\n' + corpo.trim());
        j.status = 'entregue'; log('Vigia imoveis: analise devolvida ao grupo (' + id + ')');
      } catch { j.status = 'entrega_incerta'; log('Vigia imoveis: retorno falhou; nao sera repetido automaticamente (' + id + ')'); }
      salvar();
    }
  }
  return (evento) => {
    fila = fila.then(() => processar(evento)).catch(() => log('Vigia imoveis: erro isolado; nenhum reenvio automatico'));
    return fila;
  };
}
