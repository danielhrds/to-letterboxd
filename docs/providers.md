# Provedores

## Letterboxd

O Letterboxd documenta os redirecionamentos `/imdb/{id}` e `/tmdb/{id}`. Ambos foram conferidos pelos exemplos oficiais, que apontam para a página de *The Killing of a Sacred Deer*. A busca de filmes usa `/search/films/{consulta}/`. [Central de ajuda do Letterboxd](https://letterboxd.com/faq/) · [Exemplo de busca](https://letterboxd.com/search/films/Interstellar/)

A extensão lê links disponíveis na página de pesquisa e abre redirecionamentos oficiais por ID. Ela dispensa acesso em segundo plano ao domínio do Letterboxd, então não consegue recuperar automaticamente uma navegação por ID se o site não encontrar o filme. Um título reconhecido no TMDB mantém a disponibilidade no Letterboxd como desconhecida. [Dados de filmes do Letterboxd](https://letterboxd.com/about/film-data/)

## TMDB

A extensão usa o token pessoal de leitura no cabeçalho `Authorization`. O teste de conexão chama `GET /3/authentication`. A resolução usa `GET /3/search/movie`, com idioma e ano principal quando disponíveis. Até duas páginas são lidas por consulta. [Autenticação de aplicativo](https://developer.themoviedb.org/docs/authentication-application) · [Busca de filmes](https://developer.themoviedb.org/reference/search-movie)

Quando os resultados não têm evidência suficiente, `GET /3/movie/{id}` pode acrescentar títulos alternativos, traduções, créditos de direção e datas regionais. A extensão investiga até seis candidatos. Ela compara títulos por igualdade após normalizar Unicode, diacríticos latinos e pontuação. Ano e diretor podem descartar candidatos. Para uma diferença de um ano sem candidatos com a data principal solicitada, a data regional precisa aparecer nos dados do TMDB. [Detalhes do filme](https://developer.themoviedb.org/reference/movie-details) · [Encontrar dados](https://developer.themoviedb.org/docs/finding-data)

Quando a busca no idioma do navegador não encontra correspondência, a extensão tenta em inglês. No modo inteligente do menu de contexto, um título selecionado na busca do Google pode reaproveitar o link ou ID do filme já identificado naquela aba.

Uma seleção com título e ano pode desempatar correspondências pelo total de votos do TMDB. O primeiro precisa ter pelo menos 20 votos e o triplo dos votos do segundo. Um filme que corresponde sozinho ao título e ao ano abre com qualquer contagem de votos. [Especificação da API do TMDB](https://developer.themoviedb.org/openapi/tmdb-api.json)
