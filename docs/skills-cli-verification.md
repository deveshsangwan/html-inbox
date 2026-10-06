# Skills CLI verification for issue #67

Verified on 2026-10-06 with Node.js 24.19.0, npm 11.17.0, and the published `skills@1.7.0` CLI. The public HTML Inbox repository was at `44db20da1385420e817cb2bd590da92e89d1cefb`. Tests used disposable project, home, config, cache, and temporary directories inside this worktree. Child environments excluded ambient credentials and agent configuration. All scratch files were removed after verification.

## Confirmed installer contracts

| Operation | Current contract | Primary source |
| --- | --- | --- |
| Skill prerequisites | Node.js >=22.20.0 and npm | [Published package metadata](https://registry.npmjs.org/skills/1.7.0) |
| HTML Inbox runtime | Node.js >=20 | [HTML Inbox package metadata](https://registry.npmjs.org/html-inbox/0.2.0) |
| Individual installation | `--skill html-inbox` selects the main skill; the optional remote skill needs a separate selection | [Released add parser](https://github.com/vercel-labs/skills/blob/7407f3893ad4dceab546ac002c3ef806e4000c73/src/add.ts#L2429) |
| Scope and agent | Default project scope, `-g` for user scope; `--agent codex` or `--agent claude-code` selects a target | [Official install options](https://github.com/vercel-labs/skills#options) |
| Available skills | `add <source> --list` lists repository skills without installing | [Official install options](https://github.com/vercel-labs/skills#options) |
| Installed skills | `skills list` selects project scope; `skills list -g` selects global scope | [Released list implementation](https://github.com/vercel-labs/skills/blob/7407f3893ad4dceab546ac002c3ef806e4000c73/src/list.ts#L76) |
| Named updates | `skills update html-inbox -g` or `-p` updates that skill in the selected scope | [Official update reference](https://github.com/vercel-labs/skills#skills-update) |
| Other update forms | Omitting names updates all selected skills. Interactive unscoped update prompts for scope; `-y` and non-TTY runs auto-select project when project tracking exists, otherwise global | [Released scope resolver](https://github.com/vercel-labs/skills/blob/7407f3893ad4dceab546ac002c3ef806e4000c73/src/update.ts#L122) |
| Check alias | `skills check` executes the update flow and can overwrite installed files | [Released command dispatcher](https://github.com/vercel-labs/skills/blob/7407f3893ad4dceab546ac002c3ef806e4000c73/src/cli.ts#L398) |

The published CLI's `gitHead` is `7407f3893ad4dceab546ac002c3ef806e4000c73`. Source inspection used that revision, not unreleased upstream main. The upstream README currently describes plain `skills list` as combining scopes, but the published implementation, bundled help, and empty-project test agree on project-only behavior.

The updater accepts positional skill names and scope flags. It has no agent selector or documented dry-run. An unsupported `--agent codex` was treated as another skill name during testing. To preserve an explicit agent selection when reinstalling, rerun the original `skills add` command with its scope, `--skill`, and `--agent`. Keep deliberate local edits backed up before refreshing skills. [Released update parser](https://github.com/vercel-labs/skills/blob/7407f3893ad4dceab546ac002c3ef806e4000c73/src/update.ts#L65).

## Public discovery and installation evidence

The cache was warmed with `npx --yes skills --version`, which printed `1.7.0`. Every command below exited zero. No real user skill installation was changed.

| Command | Observed result |
| --- | --- |
| `npx skills add deveshsangwan/html-inbox --list` | Found exactly `html-inbox` and `html-inbox-remote`; project and home remained uninstalled |
| `npx skills add deveshsangwan/html-inbox --skill html-inbox --agent codex claude-code -y` | Installed only the main skill at project scope; Codex shared folder and Claude Code symlink verified |
| `npx skills add deveshsangwan/html-inbox --skill html-inbox -g --agent codex claude-code -y` | Installed only the main skill at global scope; both named targets completed cleanly |
| `npx skills add deveshsangwan/html-inbox --skill html-inbox -g` | Exact issue command completed in a normal-sized pseudo-terminal; main skill installed, with the per-agent exception below |
| `npx skills list --json` in the installed project | Returned the main project skill |
| `npx skills list -g --json` | Returned the global main skill |
| `npx skills list --json` in an empty project with a global install present | Returned `[]`, confirming project-only default |
| `npx skills update html-inbox -g -y` | Reported all global skills up to date |
| `npx skills update html-inbox -p -y` | Refreshed the main project skill successfully |
| `npx skills check html-inbox -p -y` after adding a disposable marker | Removed the marker and restored the original skill bytes |

The exact issue command's terminal responder selected Symlink, confirmed installation, and declined the optional `find-skills` offer. It printed these results:

```text
Found 2 skills
Selected 1 skill: html-inbox
Installed 1 skill
Failed to install 1
html-inbox → PromptScript: PromptScript does not support global skill installation
```

The main skill installation succeeded. Automatic agent selection also attempted an unsupported global PromptScript target despite exiting zero. Explicit `--agent codex claude-code -y` completed cleanly. Check per-agent results instead of treating exit status as proof that all automatically selected targets succeeded. These tests checked installed files and links; they did not launch Codex or Claude Code to verify runtime discovery.

The installed main `SKILL.md` matched public main with SHA-256 `1b83fd392391b7d198501679f26f2cd6357c64307b74087d979a52d55b8741a4`. Before the check-alias test, the modified copy hashed to `08651712f8f8a0d17ac82462a85751ee1772da75084447bd698d074ec6a954c1`; afterward, it matched the original hash again.

## Integration and release constraints

The public skill tested above still uses direct `html-inbox` commands. Successful discovery and installation do not establish skill-first CLI resolution. Keep the documentation PR draft until #65's resolver resources and #66's installed viewer guidance are available through the public install source. [Issue #67 dependencies](https://github.com/deveshsangwan/html-inbox/issues/67).

The prepared copy matches #65's validated version-selection and Linux lifecycle contract: stable installed 0.2.x or exact `npx --yes html-inbox@0.2.0`, unchanged inbox environment and saved exposure, and one prefix per ordinary operation. Boot-service administration requires deliberately installed Node and CLI at stable absolute paths. Stop older viewers through their original executable before switching versions, and confirm actual shutdown. Follow the existing [service update guide](https://github.com/deveshsangwan/html-inbox/blob/44db20da1385420e817cb2bd590da92e89d1cefb/site/docs/boot-services.html#L359) for executable paths.

Documentation changes require no npm release. Updated `packages/cli/README.md` reaches npm in a normal future package release. This task does not publish npm or deploy the website.

Sibling #65 reported validation with Node.js 20.20.2, an empty consumer and fresh npm cache: pinned package version, detached publishing, viewer reuse by PID, actual shutdown, saved LAN configuration, and a recording Tailscale override. Its negative checks preserved older/conflicting records and unrelated processes and retained npm registry-failure diagnostics without a success URL. These are sibling verification results; this documentation thread ran the installer and site checks above.

The `e73f7f1` reference writes failed PowerShell installed-probe diagnostics to stderr. A subsequent independent review found that direct PowerShell invocation of `.cmd` can let CMD reinterpret shell-significant paths and titles. #65 is preparing a self-contained Node dispatcher and another review round. The Windows resource remains pending; refresh #66 with the complete final artifact, including helper files, before considering these documentation dependencies satisfied. Sibling #65 reported 37 Bash/zsh resolver checks passing with one Windows-only skip. Native Windows execution was unavailable locally; platform cases are connected to the existing Windows CI.
