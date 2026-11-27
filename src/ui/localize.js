export function localize(messages) {
  document.documentElement.lang = messages.language;
  for (const element of document.querySelectorAll("[data-message]")) {
    element.textContent = messages.get(element.dataset.message);
  }
  document.title = messages.get(document.documentElement.dataset.title);
}
