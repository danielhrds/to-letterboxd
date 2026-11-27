# To Letterboxd

Extensão independente para abrir filmes no Letterboxd a partir da Pesquisa Google ou de texto selecionado no Chrome. Quando a identidade do filme fica incerta, a extensão abre a busca de filmes do Letterboxd.

## Instalação

1. Use o Chrome 123 ou posterior. Para instalar pelo ZIP, extraia o conteúdo para uma pasta.
2. Acesse `chrome://extensions` e ative **Modo do desenvolvedor**.
3. Selecione **Carregar sem compactação** e escolha a pasta que contém `manifest.json`.

A extensão funciona sem configuração inicial. O popup oferece controles independentes para o menu de contexto, o painel de filmes, os atalhos IMDb e o resultado dedicado. As integrações com a Pesquisa Google são compatíveis com `www.google.com` e `www.google.com.br`. A interface segue o idioma do Chrome e está disponível em português brasileiro e inglês.

## Resolução por título com TMDB

1. Abra [Configurações de API do TMDB](https://www.themoviedb.org/settings/api) e copie seu **API Read Access Token**.
2. No popup, abra **Configurações avançadas**, cole o token e selecione **Salvar e ativar**.
3. Conceda acesso ao host da API quando o Chrome solicitar. Use **Testar conexão** para verificar o token ou **Remover token** para apagar a credencial e revogar a permissão.

Um ano entre parênteses ajuda a distinguir homônimos, por exemplo `Oldboy (2003)`. O modo **Buscar imediatamente** envia o texto selecionado direto à pesquisa do Letterboxd. URLs e IDs reconhecidos funcionam independentemente do TMDB.

## Limites

Um ID válido pode apontar para um título que o Letterboxd não lista. Em links por ID, é o Letterboxd que decide o destino. O painel do Google também oferece a busca por título quando usa esse tipo de link. Layouts incomuns do Google podem deixar o painel indisponível. Avaliações e sinopses ficam fora da interface da extensão.

## Desenvolvimento

Use `npm test` com Node.js 20 ou posterior. Para executar a suíte com o Chrome, confira [Testes](docs/testing.md). A extensão pode ser carregada direto da pasta do repositório.

- [Arquitetura](docs/architecture.md)
- [Provedores](docs/providers.md)
- [Privacidade e permissões](PRIVACY.md)
- [Atribuições](THIRD_PARTY_NOTICES.md)
