# npm Windows command fixtures

`npm-bundled-npx.cmd` is npm 11.17.0's published `bin/npx.cmd`, also used by the Node 24.19.0 Windows distribution. npm 10.9.9 uses the same layout.

`npm-legacy-npx.cmd` is npm 9.6.4's published `bin/npx.cmd`, the npm version listed in the [Node 20.0.0 release](https://nodejs.org/en/blog/release/v20.0.0). It queries the global prefix through `npm-cli.js prefix -g` instead of `npm-prefix.js`.

The dispatcher tests read these batch files as data and replace their Node entry points with recording JavaScript. They verify both bundled and separately configured global npm selection without executing CMD or mutating a real npm installation. Native PowerShell execution and the real package lifecycle remain in the Windows CI matrix.
