import { messagesFor } from "../core/messages.js";
import { readSettings, SETTINGS_KEY } from "../core/settings.js";
import { localize } from "../ui/localize.js";

const data = await chrome.storage.local.get(SETTINGS_KEY).catch(() => ({}));
const settings = readSettings(data[SETTINGS_KEY]);
document.documentElement.dataset.theme = settings.theme;
localize(await messagesFor(settings.language));
