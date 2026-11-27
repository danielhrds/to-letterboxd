export function localize() {
  document.documentElement.lang = chrome.i18n.getUILanguage();
  for (const element of document.querySelectorAll("[data-message]")) {
    element.textContent = chrome.i18n.getMessage(element.dataset.message);
  }
  document.title = chrome.i18n.getMessage(document.documentElement.dataset.title);
}
