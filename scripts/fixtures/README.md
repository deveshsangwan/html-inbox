# Browser library fixtures

The default browser suites intercept the supported Tailwind classic, classic plugin, and v4 browser script URLs, plus the Mermaid v11 module entry point and a descendant module import. They return the small JavaScript fixtures in this directory. Assertions check script execution, injected styles, module imports with CORS, and rendering inside the served document sandbox under the generated CSP.

These fixtures test the allowed source and browser policy contracts. They do not establish compatibility with current upstream Tailwind or Mermaid releases.

To check the current CDN libraries through both the local viewer and a generated static snapshot, build the CLI and enable the optional live test:

```sh
corepack pnpm build
HTML_INBOX_LIVE_CDN=1 node --test --test-name-pattern="live CDN" scripts/viewer-browser.test.mjs
```

On Windows PowerShell, set `$env:HTML_INBOX_LIVE_CDN = "1"` before the Node command. The live check needs access to the CDN hosts and fails on loading or rendering errors. Normal `verify` and CI do not require CDN access.
