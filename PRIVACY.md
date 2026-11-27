# Privacidade

To Letterboxd não usa analytics, anúncios nem servidor próprio. As preferências e o cache ficam no Chrome. A extensão lê metadados dos resultados em `www.google.com/search` e `www.google.com.br/search`. Em outras páginas, recebe o texto selecionado apenas quando alguém escolhe **Abrir no Letterboxd** no menu de contexto.

Ao abrir uma página, o Letterboxd recebe o endereço do filme, o ID ou o texto da busca. Com o TMDB ativado, a extensão envia títulos, idioma e, quando disponível, o ano para identificar o filme. O token pessoal segue no cabeçalho de autorização e permanece no armazenamento local restrito a contextos da extensão. Esse armazenamento não é um cofre criptografado. Nenhum site ou script de conteúdo recebe o token da extensão.

O cache armazena correspondências confirmadas pelo TMDB por até 24 horas de validade, com um limite de 50 entradas por área de armazenamento. Por padrão, fica na sessão atual do navegador. O popup permite ativar o cache persistente, limpar os registros e remover o token. Restaurar os padrões desativa o TMDB e conserva a credencial.

## Permissões

| Permissão | Uso |
| --- | --- |
| `storage` | Preferências locais, credencial TMDB e cache de correspondências. |
| `contextMenus` | Item de menu para texto selecionado. |
| Pesquisa Google em `www.google.com` e `www.google.com.br` | Ler metadados e acrescentar links nos resultados. |
| `https://api.themoviedb.org/*` | Permissão opcional para testar o token e resolver filmes por título. |

A navegação usa as operações de criação e atualização de abas do Chrome. A extensão dispensa permissões de leitura de histórico, cookies e conteúdo da aba fora das páginas de pesquisa declaradas.
