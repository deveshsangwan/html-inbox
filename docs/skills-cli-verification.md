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

The prepared copy matches #65's validated version-selection and lifecycle contract: stable installed 0.2.x or exact `npx --yes html-inbox@0.2.0`, unchanged inbox environment and saved exposure, and one prefix per ordinary operation. Boot-service administration requires deliberately installed Node and CLI at stable absolute paths. Stop older viewers through their original executable before switching versions, and confirm actual shutdown. Follow the existing [service update guide](https://github.com/deveshsangwan/html-inbox/blob/44db20da1385420e817cb2bd590da92e89d1cefb/site/docs/boot-services.html#L359) for executable paths.

Documentation changes require no npm release. Updated `packages/cli/README.md` reaches npm in a normal future package release. This task does not publish npm or deploy the website.

The reviewed resource/helper artifact in [PR #70](https://github.com/deveshsangwan/html-inbox/pull/70) remains [2e415c9](https://github.com/deveshsangwan/html-inbox/commit/2e415c9), unchanged at the shared test/fixture amendment [4563987](https://github.com/deveshsangwan/html-inbox/commit/4563987). Each independently installable skill contains its own `references/cli-resolution.md` and `scripts/windows-cli.cjs`. The Windows dispatcher receives JSON through a temporary environment variable, converts numeric arguments to strings, and handles generic global and modern/legacy bundled npm shims through Node entry points without CMD. Replace the helper-path placeholder with the selected skill's absolute installed directory and retain the dispatcher for every PowerShell invocation.

Sibling #65 reports a clean round 4 independent review of these resources, including environment/exit-code handling, CRLF extraction, bundled npm selection, and the stable-path boot-admin exception. Its example validator accepts only the agreed absolute Node/CLI administrator install/uninstall examples; ordinary operations and service status use `inbox`. Released 0.2.0 service help and six parser tests also passed.

A bounded GitHub check of [CI run 37488156069](https://github.com/deveshsangwan/html-inbox/actions/runs/37488156069) at `4563987` confirmed full success across Ubuntu Node 20/24 and Windows Node 24, including browser, package, and website checks. #65 reports all 50 native resolver/dispatcher tests passed under PowerShell 7 and Windows PowerShell 5.1, covering numeric literal/variable ports, Unicode/empty arguments, and singleton arrays. The real published 0.2.0 fresh-cache detached lifecycle passed on all three platforms, including PID reuse, actual shutdown, saved LAN/port, older/unverified process safeguards, and registry failure without a success URL.

The Windows recording-Tailscale case was deliberately skipped because the recorder uses a POSIX shebang. Windows environment-override preservation was tested; complete recording-Tailscale restart and scoped route restoration passed Linux. These fixture checks do not establish a real Tailscale/Serve operation, boot-service mutation, or Cloudflare deployment.

Sibling #66 reports that [PR #69](https://github.com/deveshsangwan/html-inbox/pull/69), through `52b7842`, contains all four resource/helper files byte-identical to `2e415c9` and `4563987`, with its surrounding guidance and Resolve sections preserved. The exact `4563987` harness passed 48 checks with two native-Windows skips on Node 24.19.0/Linux against the combined source skills, and separately passed 48 checks with two skips against actual individual `skills@1.7.0` Codex copy installations. Each install contained only the selected skill; copied files matched. Earlier individual installation and CRLF Bash/PowerShell extraction checks remain valid. Its own [Verify CI run 37487162562](https://github.com/deveshsangwan/html-inbox/actions/runs/37487162562) at `52b7842` also completed successfully.

#66 also reports that the complete `2e415c9` registry smoke passed from an empty consumer with a fresh npm cache: pinned fallback, detached PID reuse, HTTP content, actual shutdown, saved LAN/port, recording Tailscale reuse and scoped restoration, older/unverified record and unrelated-process protection, and registry failure without URL or storage. These are combined-skill Linux checks. The resolver/lifecycle results above belong to the sibling implementation threads; this documentation thread performed the installer, site, and browser checks recorded here.

The supporting implementation contract and CI are validated. Keep this PR draft until #70 is integrated, #69 is rebased/integrated retaining the four resources and Resolve sections, and both supporting skills are publicly available. Integrate the documentation PR last so the website's first-use promises match the public install source.
