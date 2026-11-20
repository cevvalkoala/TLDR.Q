# TLDR.Q

A Firefox-first browser extension that summarizes the current page with a provider and model you choose. It also has a Chrome side-panel build. The extension has no runtime dependencies or build framework.

## Architecture

- `manifest.json` is the Firefox Manifest V3 manifest; `manifest.chrome.json` is the Chrome variant.
- `src/background.js` captures pages, persists and processes a sequential queue, and handles deletion. Firefox uses an event page; Chrome loads the same code in a service worker via `src/worker.js`.
- `src/providers.js` implements provider-specific discovery and summarization APIs. `src/options.*` handles configuration and optional permissions. `src/sidebar.*` displays the queue and saved results.
- `build.ps1` assembles unpacked extensions and ZIP archives. There is no compilation or network dependency for the build.

When invoked, the extension captures the page immediately, stores the snapshot in the queue, then processes items one at a time using the settings saved when processing begins. A completed or failed request no longer retains its source text. Completed summaries and titles persist in `storage.local`. New captures do not collect page URLs as metadata; existing saved URL fields are migrated away. A worker restart requeues an interrupted request; if the provider already received it, retrying may incur duplicate charges. Background lifetimes are controlled by the browser, so uninterrupted or exactly-once execution is not guaranteed. Queued work resumes when the background starts again.

## Permissions And Privacy

The extension reads the active tab's DOM using `activeTab` and `scripting` after the toolbar button or extension keyboard shortcut is invoked. It does not need a standing grant to read all websites. Refetching arbitrary page URLs would instead need host access for those websites, and could miss logged-in or dynamically rendered content. A sidebar-page click alone does not grant `activeTab` for a newly selected tab, so use the toolbar button or shortcut to add a page.

The extension declares wildcard optional HTTP and HTTPS host patterns so a user-configured API can be accessed; these declarations are not granted automatically. At runtime it requests only the configured provider's scheme and specific hostname when saving or loading models. API base URLs containing wildcards (`*`), including encoded forms, are rejected anywhere in the URL. Browser host match patterns do not distinguish ports, so a grant applies to that host and scheme on all ports, not just the configured port. Existing grants can be removed in the browser's extension permissions settings. Chrome additionally requires `sidePanel`; both builds use `storage` and `unlimitedStorage` for local history and queued content.

Firefox requests optional `authenticationInfo` data-collection consent when a configured API key is used. It checks that consent before each provider request, including paginated model discovery and queued summaries, so a revoked grant prevents subsequent requests. Keyless Ollama use does not require this optional consent. Chrome has no Firefox data-collection consent API. Revocation cannot recall a request already sent.

Both manifests disallow incognito/private browsing. The extension cannot be used in private windows, and its shortcut does nothing there; a defensive capture check also avoids scripting, provider calls, and storage writes for private tabs.

**API keys are stored unencrypted in the browser profile's extension `storage.local`.** They are not protected by an OS keychain. Anyone with sufficient access to the profile, backups, or the running user account, including malware, may recover them. Encryption with a key automatically available to the extension would not reliably protect against that attacker. Use restricted, revocable keys, and protect your device and backups. Keys are not stored in browser sync; remove or replace them in Settings when appropriate.

Page text and title are sent to the selected provider, including cloud providers, under its privacy and retention policies. The configured API key is sent to that provider for authenticated requests, including model discovery. The page URL is not transmitted, stored, or displayed as page metadata. Text or titles may themselves contain URLs, which can still be captured, sent, stored in queued text, or appear in a summary. Queued text also remains in local storage until processed or deleted. Local Ollama and Open WebUI servers receive the content too and may be configured to forward or retain it. Avoid submitting sensitive material unless you accept those risks. HTTP sends keys and content without transport encryption.

Remote configured providers require HTTPS. HTTP is allowed only for loopback addresses (`localhost`, `127.0.0.0/8`, or `[::1]`), so the local Ollama and Open WebUI defaults below remain unchanged. Remote private-network services also require HTTPS.

The page is untrusted input. Instructions in it may influence the AI despite the prompt's instruction to treat source text as data. Summaries can be incorrect or incomplete. Output is displayed as text, not HTML.

## Capture And Limitations

Capture prefers the first `article`, `main`, or `[role=main]`, otherwise the page body, and excludes common navigation and non-content elements. It uses computed display and visibility to separate block, table, flex, and grid content and skip hidden subtrees, with a tag-based fallback when computed styles are unavailable. It captures the top-level document rather than cross-origin frames. Dynamic content not yet loaded, content in images/canvas, PDF viewers, shadow DOM, and unusual layouts may not be captured correctly. The extractor is heuristic, not a full readability engine; some hidden or visually excluded text may still be included.

Page text is limited to the first 60,000 characters, with a notice when truncated. Word count is computed before truncation using whitespace; this can undercount CJK and Thai text and incorrectly trigger the short-page shortcut. With the unmodified default prompt, pages under 350 words produce a local notice instead of an API call; an edited prompt is sent as written and the model decides what to do. Context windows and input handling vary by model and provider, and smaller contexts can reject or truncate even the capped text. Restricted pages such as browser settings, extension pages, browser stores, reader view, and browser PDF viewers cannot generally be scripted. Files may require separate browser settings. Navigation before capture may revoke access.

When a provider reports that output was cut off, available partial text is kept with a warning; a reported block without summary text is an error. Other reported non-success stop reasons may produce a warning, while missing stop reasons cannot be detected. Output limits and reasoning-token use vary by provider and model; the extension does not automatically retry incomplete output.

## Configure

1. Open **Settings** in the sidebar, choose a provider, and enter its base URL and API key. A key may be blank for Ollama.
2. Click **Load models** and approve the requested host permission and, on Firefox when using a key, authentication-data consent. Select a model or type a model ID manually. Some proxies do not implement model discovery or return a different schema; manual entry can still work when their completion endpoint is compatible.
3. Edit the custom prompt if desired and save. The default asks for approximately 200 words and skips sources under 350 words.
4. Open an article and click the extension toolbar button or press its shortcut. The native sidebar opens and the page is queued. Entries show the title, status or result, any completion warning, token usage when reported, and elapsed time. Delete entries individually or use **Delete existing summaries** in Settings to cancel queued and running requests, discard pending captures, and remove the queue and history; settings and API keys remain. Cancellation cannot undo content already received by a provider.

The base URL is the API root shown below; it may be changed for a compatible endpoint. Models and endpoint availability vary by account and provider. Model discovery does not guarantee a model supports the selected completion format.

| Provider | Default base URL | API format |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | OpenAI models and chat completions |
| Anthropic | `https://api.anthropic.com/v1` | Anthropic models and messages |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta` | Gemini models and generateContent |
| OpenRouter | `https://openrouter.ai/api/v1` | OpenAI-compatible chat completions |
| Open WebUI | `http://localhost:3000/api` | OpenAI-compatible models and chat completions |
| Ollama | `http://localhost:11434` | Ollama tags and chat |

Open WebUI requires an API key enabled in its account settings and an endpoint exposing the compatible API. Ollama must be running with a model installed; its API normally does not require a key. Ollama's origin policy may reject browser-extension origins: configure `OLLAMA_ORIGINS` to allow the extension origin as appropriate for your installation, and restart the server. Exact origin syntax and behavior vary by version. Permitting all origins weakens local server access controls; do not expose Ollama unnecessarily. Ollama is asked for a context large enough for the captured text and to disable truncation, which can require substantial memory; older versions may ignore those flags. Self-hosted servers and proxies may reject extension requests due to CORS or other origin restrictions even after host permission is granted. Anthropic's adapter uses the provider's browser-access header. A wrong base path, a missing model, authentication, quota, network, and unsupported endpoint errors are reported in the UI.

## Shortcut

The suggested shortcut is `Alt+Shift+S`. Browser, OS, keyboard layout, or other extension shortcuts may conflict; the browser can reject or leave it unassigned. Firefox offers shortcut editing and removal in Settings and its extension shortcut manager. Chrome does not offer the same programmatic update API; change or remove it at `chrome://extensions/shortcuts`. Browser shortcut restrictions apply. On some versions the browser may reject programmatic sidebar opening from a shortcut even when capture works; use the toolbar button or open the sidebar from the browser UI.

## Install And Build

Firefox desktop 140 or later is required. To load the current build temporarily:

1. Open `about:debugging`, choose **This Firefox**, and select **Load Temporary Add-on**.
2. Select this repository's `manifest.json`. Open Settings from the sidebar and configure a provider.
3. Temporary add-ons are removed when Firefox exits. A persistent installation normally requires an extension signed by Mozilla; signing and distribution are separate from this build.

Chrome 116 or later:

1. Run `./build.ps1` in PowerShell from the repository root.
2. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `dist/chrome`. Pin the extension if its toolbar button is hidden.

The build creates `dist/firefox`, `dist/chrome`, `dist/tldrq-firefox.zip`, and `dist/tldrq-chrome.zip`. It copies files and does not sign either archive. `dist/firefox/manifest.json` can also be loaded as a temporary Firefox add-on. Building requires Windows PowerShell with .NET compression assemblies, not Node.js. To run automated tests when Node.js is available, run `node --test`.

## Mozilla Publication

The Firefox manifest ID remains `tldrq@example.org`. Confirm that it is unique and intended to be permanent before the first AMO submission. Changing it later changes the extension's identity and affects access to its existing storage.

The publisher must provide a privacy policy for the AMO listing that accurately describes data collection, transmission, storage, and provider handling, and must supply reviewer testing credentials through AMO's reviewer instructions or another appropriate private submission channel. Do not include API keys, credentials, or other secrets in the ZIP archive. This build targets desktop Firefox; Firefox for Android does not support its sidebar.

## Testing Checklist

- Configure each provider, test model discovery and manual entry, and exercise a bad key, unavailable server, wrong API path, denied permission, and unsupported model.
- Before Mozilla submission, test Firefox authentication-data consent for API-key use, denial and revocation before queued requests, keyless Ollama, remote HTTP rejection, and HTTP loopback access for local Ollama and Open WebUI. Verify Chrome does not invoke the Firefox consent API.
- Invoke on a long article, a short article, an unmodified default prompt, and a custom prompt; verify the native sidebar, title, usage, elapsed time, and completion warnings. Check provider payloads and saved entries for absence of page URL metadata, including migration of old URL fields.
- Queue several pages quickly, verify sequential processing, cancel an active or queued item, restart the browser, and delete one or all entries. Test deletion while capture is still pending.
- Check private windows, restricted pages, content changes, frame limitations, table and flex layouts, hidden content, a page longer than the text cap, and a conflicting shortcut. Verify private tabs produce no writes or provider calls, wildcard API URLs including encoded forms are rejected, and install-time permissions do not grant all websites.
- Test the actual Firefox and Chrome builds with the intended provider/server configuration. Browser lifecycle behavior, provider API versions, and server origin policies can differ.
