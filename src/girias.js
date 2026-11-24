// Dicionário de FALA para o "internetês" brasileiro: abreviações de WhatsApp, risadas e letras esticadas.
// Não muda o texto na tela nem o que vai para a IA: só o que a voz fala.
// Gírias regionais (uai, trem, oxe, bah, mano, piá, bolado, armaria…) são palavras normais e a voz já lê bem;
// aqui entram as formas ESCRITAS que a voz soletraria ou leria errado ("vc" → "vê cê").
// Fontes de referência: Dicio (siglas da internet), Wiktionary (Portuguese internet slang), The Brazilian Ways,
// Speaking Brazilian, Toda Matéria e BlaBlaCar (gírias regionais).

export const ABREVIACOES = {
  // pronomes e palavras do dia a dia
  vc: 'você', vcs: 'vocês', voce: 'você', cê: 'cê', c: 'cê', tb: 'também', tbm: 'também', tbem: 'também',
  pq: 'porque', pk: 'porque', q: 'que', oq: 'o que', oqq: 'o que', qm: 'quem', ql: 'qual', qnd: 'quando', qdo: 'quando',
  qndo: 'quando', qto: 'quanto', qnt: 'quanto', qts: 'quantos', n: 'não', ñ: 'não', naum: 'não', nao: 'não', nn: 'não não',
  neh: 'né', eh: 'é', ss: 'sim sim', sim: 'sim', hj: 'hoje', amn: 'amanhã', amanha: 'amanhã', dps: 'depois', dpois: 'depois',
  agr: 'agora', aq: 'aqui', kd: 'cadê', cad: 'cadê', td: 'tudo', tds: 'todos', tdo: 'tudo', nd: 'nada',
  ngm: 'ninguém', nnm: 'ninguém', alg: 'alguém', algm: 'alguém', mt: 'muito', mto: 'muito', mta: 'muita', mts: 'muitos',
  mtos: 'muitos', mtas: 'muitas', msm: 'mesmo', mesmu: 'mesmo', dnv: 'de novo', smp: 'sempre', sempr: 'sempre',
  cmg: 'comigo', ctg: 'contigo', p: 'pra', pr: 'pra', pro: 'pro', pf: 'por favor', pfv: 'por favor', pfvr: 'por favor',
  pls: 'por favor', obg: 'obrigado', obgd: 'obrigado', obgda: 'obrigada', obrg: 'obrigado', vlw: 'valeu', vlww: 'valeu',
  vdd: 'verdade', vdc: 'verdade', blz: 'beleza', bls: 'beleza', tmj: 'tamo junto', tmjunto: 'tamo junto', sdds: 'saudades',
  sdd: 'saudade', bjs: 'beijos', bj: 'beijo', bjo: 'beijo', bjss: 'beijos', abs: 'abraços', abraco: 'abraço',
  flw: 'falou', fls: 'falou', fmz: 'firmeza', fz: 'faz', fzr: 'fazer', qr: 'quer', qro: 'quero', qer: 'quer', tô: 'tô', to: 'tô',
  ta: 'tá', tah: 'tá', tava: 'tava', tamo: 'tamo', vamo: 'vamo', bora: 'bora', glr: 'galera', mn: 'mano', mlk: 'moleque',
  mlq: 'moleque', mina: 'mina', vey: 'véi', vei: 'véi', vlh: 'velho', pdc: 'pode crer', pdp: 'pode pá', tlgd: 'tá ligado',
  tlg: 'tá ligado', sla: 'sei lá', sl: 'sei lá', sei: 'sei', pse: 'pois é', poise: 'pois é', slk: 'cê é louco', slc: 'cê é louco',
  mds: 'meu Deus', mdss: 'meu Deus', plmdds: 'pelo amor de Deus', pelamor: 'pelo amor', sqn: 'só que não', tmb: 'também',
  fds: 'fim de semana', msg: 'mensagem', msgs: 'mensagens', add: 'adicionar', cel: 'celular',
  obs: 'observação', info: 'informação', infos: 'informações', qq: 'qualquer', qlq: 'qualquer', qqr: 'qualquer',
  qlqr: 'qualquer', tdb: 'tudo bem', tdbm: 'tudo bem', tbom: 'tá bom', blza: 'beleza',
  aff: 'afe', affs: 'afe', af: 'afe', hmm: 'hum', hm: 'hum', ahn: 'ãhn', eita: 'eita', oxe: 'óxi', oxi: 'óxi', vish: 'vixe',
  vixe: 'vixe', uai: 'uai', bah: 'bah', tche: 'tchê', ixi: 'ixe', opa: 'ôpa', sussa: 'sussa', suave: 'suave', zap: 'zap',
  zapzap: 'zap zap', insta: 'insta', pix: 'pix', ok: 'okei', okk: 'okei', oki: 'okei', okay: 'okei', blzz: 'beleza',
  rlx: 'relaxa', tranq: 'tranquilo', trnq: 'tranquilo', tmjj: 'tamo junto', dms: 'demais', dmais: 'demais',
  krl: 'caramba', mns: 'menos', ctz: 'certeza', ctza: 'certeza', nois: 'nóis', noix: 'nóis', nóis: 'nóis',
  bbb: 'bê bê bê', bff: 'melhor amiga', crush: 'crush', mozão: 'mozão', mozao: 'mozão', amr: 'amor', mor: 'mor', bb: 'bebê',
  gnt: 'gente', gt: 'gente', gnte: 'gente', pqp: 'puts', prof: 'professor', facul: 'faculdade', niver: 'aniversário',
  aniver: 'aniversário', fut: 'futebol', tlvz: 'talvez', tlz: 'talvez', ent: 'então', entao: 'então', entt: 'então',
  bm: 'bem', blzinha: 'belezinha', bjao: 'beijão', bjus: 'beijos', xau: 'tchau', tchauu: 'tchau',
  bd: 'bom dia', bn: 'boa noite', bt: 'boa tarde',
  // marcas que a voz lê "em inglês" errado
  shopee: 'Xópi', shein: 'Xiin',
};

// risadas: kkkk, kkkj, rsrs, hahaha, hehehe, huahua, ksksks, auhsuahs…
const RISADA = /^(?:k{2,}j*|(?:rs){2,}r?|r+s+r+s*|(?:ha){2,}h?|(?:he){2,}h?|(?:hua){2,}|(?:ks){2,}k?|(?:ah){3,}|(?:auh|ausha|kakak|kaka)\p{L}*|j{3,})$/iu;

/**
 * Prepara um texto para ser FALADO: risadas viram "risos", letras esticadas voltam ao normal
 * ("simmmm" → "sim", "nãooo" → "não") e abreviações viram palavras ("vc" → "você").
 */
export function expandirGirias(texto) {
  const t = String(texto).replace(/(^|[^\p{L}])[nN][º°]\s*/gu, '$1número '); // "nº 5" → "número 5"
  return t.split(/(\p{L}+)/u).map((p, i) => {
    if (i % 2 === 0) return p; // não é palavra (espaço, pontuação, número)
    if (RISADA.test(p)) return 'risos';
    // letra MAIÚSCULA sozinha não é abreviação ("tamanho P", "plano C", "faz o L")
    if (p.length === 1 && p !== p.toLowerCase()) return p;
    let w = p.replace(/(\p{L})\1{2,}/gu, '$1'); // "simmmm" → "sim", "boaaaa" → "boa"
    const exp = ABREVIACOES[w.toLowerCase()];
    if (exp === undefined) return w;
    // mantém a maiúscula inicial ("Vc vem?" → "Você vem?")
    return w[0] === w[0].toUpperCase() && w[0] !== w[0].toLowerCase() ? exp[0].toUpperCase() + exp.slice(1) : exp;
  }).join('').replace(/\b(risos)(?:[\s,.!]+risos)+\b/giu, '$1'); // "kkk kkk" → um "risos" só
}
