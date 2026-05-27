# GitHub Pages Frontend

This folder is the static PWA frontend for GitHub Pages.

Apps Script remains the backend for Sheets, Drive media, triggers, and push sends. GitHub Pages owns the app origin, manifest, and OneSignal service worker.

## Files

- `index.html` loads the static app.
- `app.js` is generated from the Apps Script `app.html` client code.
- `styles.css` is generated from `styles.html`.
- `app-config.js` contains the deployed Apps Script `/exec` URL and public OneSignal IDs.
- `manifest.json`, `sw.js`, and `assets/icon.svg` are the PWA files GitHub Pages serves from the same origin.

## Setup

1. Deploy the Apps Script web app as a new version.
2. Copy the deployed `/exec` URL into `app-config.js` as `web_app_url`.
3. In Apps Script, run `setupFrontendTokens()`.
4. Copy Max's token and Rui's token somewhere private. Each person pastes their own token the first time they open the GitHub Pages app.
5. Set `config.github_pages_url` in the sheet to the final GitHub Pages URL.
6. In OneSignal, configure the Web Push site URL to the GitHub Pages URL, not the Apps Script URL.
7. Upload or configure the service worker path as `sw.js` with scope `./`.
8. Publish this folder through GitHub Pages.
9. On iPhone, delete the old Home Screen app, open the GitHub Pages URL, add it to Home Screen, open from Home Screen, then tap Enable notifications.

## Static Frontend Limitation

The current static bridge uses JSONP to avoid Apps Script CORS restrictions. Normal text/status/bucket/reunion/push registration calls work through this bridge. Large uploads such as photos or voice notes may exceed URL limits and should move to a small proxy/API host if they need to be reliable from GitHub Pages.
