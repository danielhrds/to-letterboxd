# Testes

`npm test` executa os testes de normalização, URLs, fallback, seleção de filmes e o service worker com APIs do Chrome simuladas.

Para testar a instalação real em um perfil temporário do Chrome, indique o executável. Exemplo no PowerShell

```powershell
$env:TO_LETTERBOXD_CHROME = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
npm test
```

O teste abre a extensão no Chrome e carrega páginas simuladas com a URL da Pesquisa Google. Verifica atalhos fora de contêineres invertidos, card na coluna de resultados, botão abaixo do título, deduplicação e atualização de preferências ao voltar pelo histórico. Para verificar outra pasta instalável, defina também `TO_LETTERBOXD_EXTENSION_PATH`.

## Verificação externa

- A página pública do Letterboxd confirma os títulos francês, inglês e português de *The Aviator’s Wife* (1981), de Éric Rohmer. Os testes do TMDB exercitam esses títulos com respostas simuladas. [Ficha do filme](https://letterboxd.com/film/the-aviators-wife/)
- No ambiente de teste, o Letterboxd retornou HTTP 403 e o Google redirecionou a pesquisa para uma verificação com HTTP 429. Os formatos públicos foram conferidos separadamente. As integrações DOM foram testadas no Chrome com uma fixture.
- Para validar o TMDB ao vivo, conecte um token pessoal em **TMDB e cache**. Teste `La Femme de l’aviateur`, `The Aviator’s Wife` e `A Mulher do Aviador` e confira se os três levam ao filme de Rohmer. Use `Oldboy` para testar ambiguidade e os títulos com `(2003)` e `(2013)` para testar a distinção.
