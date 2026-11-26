import test from 'node:test';
import assert from 'node:assert/strict';
import { validarConsulta, consultarRecebidas, expandirIdsConsulta } from '../src/consulta-whatsapp.js';
const jid='553100000000@s.whatsapp.net', lid='123456@lid', other='5531999999999@s.whatsapp.net', group='123@g.us', archived='5531888888888@s.whatsapp.net';
const msg=(id, remoteJid, text, extra={})=>({key:{id,remoteJid,fromMe:false,...extra.key},pushName:extra.pushName||'Empresa Exemplo Comercial',messageTimestamp:extra.timestamp||1000,message:{conversation:text,...extra.message},...extra.fields});
const msgs={a:msg('a',jid,'Bom dia'),b:msg('b',jid,'Email'),c:msg('c',jid,'Atendente'),d:msg('d',lid,'Contato alternativo',{key:{remoteJidAlt:jid}}),e:msg('e',other,'Outro contato',{pushName:'Fornecedor'}),f:msg('f',group,'Grupo'),g:msg('g',archived,'Arquivada'),h:msg('h',jid,'Temporaria',{message:{ephemeralMessage:{message:{conversation:'Segredo'}}}}),i:msg('i',jid,'Enviada',{key:{fromMe:true}})};
const cache={msgs,porChat:{[jid]:['a','b','c','h','i'],[lid]:['d'],[other]:['e'],[group]:['f'],[archived]:['g']}};
const consultar=f=>consultarRecebidas(cache,validarConsulta(f),{decodificar:x=>x,idsDoContato:j=>[j],estaArquivada:ids=>ids.includes(archived),nomesDoContato:()=>[]});
test('busca por nome, acentos e termos',()=>assert.equal(consultar({contato:'empresa comercial'}).total_encontradas,4));
test('telefone internacional e DDD',()=>{for(const f of [{telefone:'+55 31 0000-0000'},{telefone:'3100000000'},{contato:'(31) 0000-0000'}]){const r=consultar(f);assert.equal(r.total_encontradas,4);assert(r.mensagens.every(x=>x.numero==='+553100000000'));}});
test('ultimas N, ordem e paginacao',()=>{const r=consultar({contato:'Empresa Exemplo',limite:2,ordem:'cronologica'});assert.deepEqual(r.mensagens.map(x=>x.texto),['Atendente','Contato alternativo']);assert.equal(r.proximo_deslocamento,2);assert.deepEqual(consultar({contato:'Empresa Exemplo',limite:2,deslocamento:2}).mensagens.map(x=>x.texto),['Bom dia','Email']);});
test('filtros combinados e exclusoes',()=>{assert.equal(consultar({telefone:'3100000000',palavra_chave:'email'}).total_encontradas,1);assert.equal(consultar({contato:'Empresa Exemplo',telefone:'31999999999'}).total_encontradas,0);assert(!consultar({contato:'Empresa Exemplo'}).mensagens.some(x=>['Grupo','Arquivada','Temporaria','Enviada'].includes(x.texto)));});
test('mapeamento LID confirmado nos dois sentidos',()=>{
  const m=(id,rev)=>rev?(id==='123456'?'553100000000':null):(id==='553100000000'?'123456':null);
  assert.deepEqual(expandirIdsConsulta([lid],m),[lid,jid]);
  assert.deepEqual(expandirIdsConsulta([jid],m),[jid,lid]);
  assert.deepEqual(expandirIdsConsulta([lid],(id,rev)=>rev?'553100000000':null),[lid]);
});
test('validacao',()=>{for(const f of [{},{ordem:'cronologica'},{telefone:'123'},{telefone:'3100000000',limite:31},{contato:'Empresa Exemplo',deslocamento:-1}])assert.throws(()=>validarConsulta(f));});
