# Arquitetura

To Letterboxd usa Manifest V3 e JavaScript sem dependências. O manifesto carrega um script de conteúdo nas páginas de pesquisa compatíveis, um service worker para o menu e a resolução de títulos e uma interface local para preferências.

- `src/content/` identifica resultados IMDb, metadados de filmes e páginas do Letterboxd que o Google já mostra. A aba lê as configurações ao abrir e ao voltar pelo histórico. Ela mantém uma conexão com o service worker apenas durante uma consulta de filme. Um IMDb isolado dá origem ao seu próprio atalho.
- `src/background/` processa cliques no menu, valida a origem das mensagens e concentra o acesso ao token e ao cache. Resoluções equivalentes em andamento compartilham o trabalho. A saída de todos os interessados cancela a consulta pendente.
- `src/core/` valida links e IDs, normaliza títulos para comparação, verifica os metadados do TMDB e escolhe o destino. Um link de filme identificado, um redirecionamento por ID e uma identidade confirmada via TMDB têm estados distintos.
- `src/resolving/` abre na aba escolhida quando é preciso consultar o TMDB. A página oferece busca imediata e tem um prazo total de cinco segundos contado desde o clique. A navegação final substitui essa página na mesma aba. Se o service worker reiniciar enquanto a aba aguarda, ela tenta reconectar dentro do prazo.

As preferências são armazenadas localmente. O cache de sessão sobrevive à suspensão do service worker. Entradas vencidas deixam de ser usadas e são removidas nas próximas gravações. O cache persistente usa o mesmo limite e depende de ativação no popup.
