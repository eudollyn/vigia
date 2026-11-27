import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// ids fictícios (os reais ficam só no .env)
process.env.VIGIA_IMOVEIS_GRUPO = '120000000000000000@g.us';
process.env.VIGIA_IMOVEIS_INSTI = '15550000000@s.whatsapp.net';
const { criarPonteImoveis, linksImoveis, GRUPO_IMOVEIS, INSTI_IMOVEIS } = await import('../src/ponte-imoveis.js');

test('ponte imobiliaria isolada: ida, volta, duplicatas, terceiros, historico, desativacao', async () => {
  const pasta=fs.mkdtempSync(path.join(os.tmpdir(),'vigia-imoveis-'));
  const ts=Math.floor(Date.now()/1000), id='0123456789abcdef', enviados=[];
  const enviar=async (jid,texto)=>enviados.push({jid,texto});
  const criar=()=>criarPonteImoveis({pasta,gerarId:()=>id,agora:()=>ts*1000});
  let ponte=criar();
  const url='https://mg.olx.com.br/belo-horizonte/imoveis/casa-123';
  const ev={tipo:'notify',jid:GRUPO_IMOVEIS,ts,deMim:false,texto:'texto privado '+url+'?utm_source=whatsapp https://evil.example/imoveis/123',enviar};
  try {
    assert.deepEqual(linksImoveis(ev.texto),[url]);
    assert.deepEqual(linksImoveis('https://olx.com.br.evil.example/imoveis/123 https://secret:pass@olx.com.br/imoveis/123'),[]);
    await ponte({...ev,jid:'outro@g.us'});
    await ponte({...ev,ts:ts-1});
    assert.equal(enviados.length,0);
    await ponte(ev); await ponte(ev);
    assert.equal(enviados.length,1); assert.equal(enviados[0].jid,INSTI_IMOVEIS);
    assert.ok(enviados[0].texto.includes(url)); assert.ok(!enviados[0].texto.includes('texto privado'));
    ponte=criar(); await ponte(ev);
    const resp={...ev,jid:INSTI_IMOVEIS,texto:'VIGIA-IMOVEL:'+id+'\nAnalise final de teste\nFIM-VIGIA:'+id};
    await ponte({...resp,jid:'estranho@s.whatsapp.net'});
    await ponte({...resp,deMim:true});
    await ponte({...resp,texto:'pesquisa de contator concluida'});
    await ponte({...resp,texto:'VIGIA-IMOVEL:'+id+'\nAinda trabalhando'});
    assert.equal(enviados.length,1);
    await ponte(resp); await ponte(resp);
    assert.equal(enviados.length,2); assert.equal(enviados[1].jid,GRUPO_IMOVEIS);
    assert.ok(enviados[1].texto.includes('Analise final de teste'));
    await ponte({...ev,deMim:true,texto:enviados[1].texto});
    assert.equal(enviados.length,2);
    fs.writeFileSync(path.join(pasta,'vigia-imoveis.desativado'),'');
    await ponte({...ev,texto:url+'4'}); assert.equal(enviados.length,2);
  } finally { fs.rmSync(pasta,{recursive:true,force:true}); }
});
