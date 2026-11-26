# Consulta de mensagens do WhatsApp no Vigia

Atualização local para o Vigia baseada no commit [6cc43d0](https://github.com/eudollyn/vigia/commit/6cc43d0facb85044d78336ebd5234772ea6681d5).

## Instalação

1. Pare o Vigia. Guarde uma cópia dos atuais `src/conector-gpt.js` e `src/whatsapp.js` antes de substituí-los.
2. Extraia o ZIP e copie os três arquivos da pasta `src` para a pasta `src` do Vigia. Para rodar os testes, copie também `test/consulta-whatsapp.test.js`. A atualização usa as dependências já instaladas do Vigia.
3. No `.env` existente, mantenha `GPT=1` e `WHATSAPP=1` e adicione `GPT_WHATSAPP_LEITURA=1`. Se uma dessas chaves já existir, edite a linha correspondente.
4. Inicie o Vigia. Em `LINK-DO-CHATGPT.txt`, copie o endereço identificado como consulta de mensagens recebidas, incluindo o trecho `?chave=...`. Com o ngrok configurado, o Vigia gera o endereço HTTPS. Se você já usa outro túnel HTTPS para a mesma porta do MCP, use o domínio desse túnel com o caminho e a query gerados no endereço local.
5. No ChatGPT, adicione um segundo servidor MCP personalizado, com o nome **Vigia Consulta WhatsApp**, o novo endereço e a opção **Sem autenticação** do formulário. A chave presente no endereço autentica a consulta no Vigia. O app de envio pode continuar com seu endereço atual.

## Uso

> Vigia, procura no WhatsApp as mensagens da Lift de ontem que falam de cotação.

A ferramenta `consultar_mensagens_whatsapp` aceita `contato` (nome ou parte), `palavra_chave` (trecho literal), `desde` e `ate` (limites inclusivos em ISO 8601 com fuso, como `2026-11-25T00:00:00-03:00`). Informe pelo menos um desses filtros. A resposta sai das mais recentes para as mais antigas, com 10 resultados por padrão e até 30 por consulta. `ha_mais` indica que o filtro encontrou outros resultados.

A consulta usa a cópia local que o Vigia já mantém de até 30 mensagens recebidas por conversa. Ela retorna textos e legendas de conversas individuais. Grupos, conversas arquivadas, mídias, áudios e mensagens identificadas como temporárias ou de visualização única ficam fora. A consulta não acessa o socket do WhatsApp nem envia confirmação de leitura.

## Acesso e revogação

O endereço de consulta dá acesso ao conteúdo retornado. Guarde-o como uma senha e use somente HTTPS fora do computador. Se usar ngrok, deixe **Full Capture** desativado para evitar registrar chaves e conteúdo no Traffic Inspector. O túnel usado precisa encaminhar a query do endereço, e a configuração de logs deve omitir essa query. [Documentação do Traffic Inspector](https://ngrok.com/docs/obs/traffic-inspection/http-requests)

Para desligar a leitura, altere `GPT_WHATSAPP_LEITURA=0` e reinicie. Para trocar a chave, pare o Vigia, apague apenas `dados/gpt-segredo-leitura.txt` e ligue-o novamente com a leitura habilitada. Depois atualize o endereço do servidor de consulta no ChatGPT. Ao compartilhar resultados da consulta, considere que eles contêm texto recebido de terceiros.

## Testes

Na raiz do Vigia, rode `node --test test/consulta-whatsapp.test.js` com Node.js 20 ou superior. Os testes usam registros fictícios e exercitam o servidor MCP por HTTP local, inclusive a separação das credenciais e o bloqueio com a leitura desativada.

Vigia · software livre AGPL-3.0 · github.com/eudollyn/vigia
