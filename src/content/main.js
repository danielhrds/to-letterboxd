void import(chrome.runtime.getURL("src/content/google.js"))
  .then(module => module.start())
  .catch(() => {});
