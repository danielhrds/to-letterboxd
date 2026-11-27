# To Letterboxd

An independent Chrome extension for opening films on Letterboxd.

## Features

- Adds Letterboxd shortcuts to IMDb results and film panels on Google Search.
- Adds a Letterboxd result when Google identifies a film and its Letterboxd page is missing.
- Opens selected film titles from the right-click menu and falls back to Letterboxd search when the match is unclear.
- Lets you choose English or Brazilian Portuguese, switch themes, and turn features on or off.

## Install and use

1. Open `chrome://extensions` in Chrome 123 or later and turn on **Developer mode**.
2. Click **Load unpacked** and select the folder containing `manifest.json`. Extract the ZIP first if you're using it.
3. Click a Letterboxd shortcut on Google, or select a film title and choose **Open on Letterboxd** from the right-click menu.

To update, replace the files in the installed folder and click **Reload** in `chrome://extensions`. Leave the extension installed to keep your settings. If you're upgrading from 0.2.13 or earlier, load the new build, disable the old copy, and save your TMDB token once on the new copy.

## Optional TMDB setup

The extension works best with a TMDB **API Read Access Token**. It helps match films from titles alone and provides posters for Google search cards when available.

Open **TMDB and cache** in the popup, paste your token, and click **Save and enable**. Adding the year helps distinguish remakes such as `Oldboy (2003)` and `Oldboy (2013)`. [TMDB API settings](https://www.themoviedb.org/settings/api)

[Privacy](PRIVACY.md) · [Third-party notices](THIRD_PARTY_NOTICES.md)
