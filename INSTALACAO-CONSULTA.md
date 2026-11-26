# Consulta do WhatsApp pelo ChatGPT (somente leitura)

## Ligar

1. Node.js 22.13+ (usa o SQLite embutido no Node; sem dependência nova).
2. `.env`: `GPT=1`, `WHATSAPP=1`, `GPT_WHATSAPP_LEITURA=1`. Reinicie o Vigia.
3. Na primeira vez ele cria `dados/whatsapp-mensagens.db` e migra `recebidas.json`, `contatos.json`, arquivadas/silenciadas e os avisos de `historico.jsonl` (origem `aviso_legado`, horário aproximado, sem duplicar).
4. Copie o endereço de consulta (`…/mcp-leitura?chave=…`) de `LINK-DO-CHATGPT.txt` e adicione/atualize no ChatGPT como servidor MCP (Sem autenticação; a chave do endereço é a senha). Se o app já existia, use **Atualizar/Reconectar** para ler a nova lista de ferramentas.

## Ferramentas

`consultar_mensagens_whatsapp`, `buscar_mensagens_whatsapp`, `consultar_historico_conversa`, `listar_conversas_whatsapp`, `listar_contatos_whatsapp`, `listar_grupos_whatsapp`, `consultar_anexos_whatsapp`, `obter_anexo_whatsapp`, `sincronizar_historico_whatsapp`, `verificar_status_whatsapp`. Filtros opcionais (contato parcial sem acento, telefone em qualquer formato, palavra-chave, `data_inicial`/`data_final`, direção, tipo, grupos, arquivadas, limite até 100, ordem, cursor; aceita os antigos `desde`/`ate`/`deslocamento`). Horários em America/Sao_Paulo.

Cada resposta traz `situacao` (`ok`, `sem_mensagens`, `contato_nao_encontrado`, `nao_sincronizado`, `historico_incompleto`, `falha_conexao`), `historico_incompleto`, `cobertura`, `conexao`, `total`, `has_more`, `cursor`.

## Limitações

- O WhatsApp não entrega o histórico completo a um aparelho já conectado. O banco tem o que o Vigia gravou desde que passou a gravar, o cache migrado e o que o celular devolver em `sincronizar_historico_whatsapp` (sem garantia, celular online, precisa de uma mensagem da conversa como ponto de partida).
- Anexos antigos podem ter expirado no servidor. Visualização única fica sem conteúdo. "Não lidas" só quando o WhatsApp informa.

## Segurança

Endereço de consulta separado do de envio (uma chave não abre a outra; sem chave → 404). Consultas não enviam nem marcam como lido. Log só com nome da ferramenta e contagens. `dados/` e `.env` fora do Git. Com ngrok, deixe Full Capture desligado.

## Testes

`npm test` — dados fictícios, banco em memória e servidor MCP por HTTP local.

Vigia · software livre AGPL-3.0 · github.com/eudollyn/vigia
