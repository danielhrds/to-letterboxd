import { readSettings, SETTINGS_KEY } from "../core/settings.js";
import { localize } from "../ui/localize.js";

localize();
const data = await chrome.storage.local.get(SETTINGS_KEY);
document.documentElement.dataset.theme = readSettings(data[SETTINGS_KEY]).theme;
