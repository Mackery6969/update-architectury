# update-architectury

Dependabot can't update Architectury: `maven.architectury.dev` sits behind Cloudflare's bot protection, which blocks Dependabot's requests. This action does Dependabot's job for Architectury's Gradle plugins and libraries. It opens the same pull requests, answers the same comment commands, and follows the same lifecycle (supersede, skip on close, rebase on conflict, close when no longer needed).

It runs on the default `GITHUB_TOKEN`, needs no checkout, and has no dependencies.

## Setup

1. Copy [`examples/architectury-updates.yml`](examples/architectury-updates.yml) to `.github/workflows/` in your mod's repository. Change `push.branches` if your default branch isn't `main`, and `dispatch-workflows` to your CI workflow's file name.
2. In **Settings → Actions → General → Workflow permissions**, turn on **Allow GitHub Actions to create and approve pull requests**. Without it GitHub refuses to let the workflow open pull requests.
3. If Dependabot also updates your Gradle build, tell it to leave Architectury alone so the two don't compete:

   ```yaml
   # .github/dependabot.yml, in the gradle entry
   ignore:
     - dependency-name: "architectury-plugin"
     - dependency-name: "dev.architectury*"
   ```

Run the workflow once from the Actions tab to get the first pull requests right away.

### CI on the pull requests

GitHub doesn't start workflows for pull requests opened with `GITHUB_TOKEN`. Two ways around that:

- **`dispatch-workflows`** (used in the example): after every push to an update branch, the action starts the listed workflows on it. They need a `workflow_dispatch` trigger, and the job needs `actions: write`. Their checks show up on the pull request like normal ones.
- **`token`**: pass a personal access token or GitHub App token with contents, pull requests and issues write access. Pull requests opened with it trigger workflows normally.

When neither is set, each pull request says that CI won't start on its own.

## What gets updated

- **Plugins**: `architectury-plugin` and every `dev.architectury.*` plugin ID (such as `dev.architectury.loom`), in `plugins {}` blocks, `pluginManagement` and version catalogs.
- **Libraries**: every `dev.architectury:*` artifact (the API for each loader, `architectury-loom`, `architectury-transformer`, ...).

Versions are found wherever they are written: inline (`id("dev.architectury.loom") version "1.14.473"`), in `gradle.properties` (`"dev.architectury:architectury-fabric:${rootProject.architectury_api_version}"`), in `ext`/`extra`/`val` variables, and in `gradle/libs.versions.toml` (including `version.ref`). Groovy and Kotlin DSL both work. Artifacts that share one version property, like the API's per-loader artifacts, are updated together in one pull request named after the property. That's how Dependabot handles Maven properties.

Dynamic versions (`1.+`, `latest.release`, ranges) are left alone. Pre-releases (`-SNAPSHOT`, `-beta`, `-PR.x`) are only proposed when you already use one.

## How it behaves

| When | What happens |
| --- | --- |
| New version | One pull request per dependency on `architectury-updates/gradle/<dependency>-<version>`, titled `Bump <dependency> from <old> to <new>`, labelled `dependencies` and `java`, with release notes quoted from Architectury's GitHub releases and an `updated-dependencies` commit trailer. |
| Even newer version | A new pull request; the old one is closed with "Superseded by #N." |
| You close a pull request | That version is skipped; the next release gets a new pull request. |
| You update by hand | The pull request is closed: "Looks like … is up-to-date now, so this is no longer needed." |
| Conflicts with the base branch | The update is recreated on top of it, unless someone else pushed to the branch. |
| Commit style | Follows `commit-message-prefix`; without it, conventional-commit repositories get `build(deps): bump …`. |
| Limit | At most `open-pull-requests-limit` (5) open pull requests. |

The state Dependabot keeps on its servers lives in a hidden `<!-- architectury-updates:metadata … -->` comment at the end of each pull request description. Don't remove it, or the bot loses track of that pull request.

## Commands

Comment on one of the bot's pull requests. Only people with push access can use them.

| Command | Effect |
| --- | --- |
| `@architectury-updates rebase` | Rebase the pull request (refused if someone else pushed to it) |
| `@architectury-updates recreate` | Recreate it, overwriting any edits |
| `@architectury-updates merge` | Merge once CI passes (GitHub auto-merge) |
| `@architectury-updates squash and merge` | Squash and merge once CI passes |
| `@architectury-updates cancel merge` | Cancel a requested merge |
| `@architectury-updates reopen` | Reopen a closed pull request, restoring its branch |
| `@architectury-updates close` | Close it and skip this version |
| `@architectury-updates ignore this major version` | Close it and skip every version in this major (also `minor`) |
| `@architectury-updates ignore this dependency` | Close it and stop updating this dependency |
| `@architectury-updates ignore <dependency> major version` | The same for one dependency of a multi-dependency pull request (also `minor version`, or no suffix for all versions) |
| `@architectury-updates unignore <dependency> [<condition>]` | Remove ignore conditions added with commands, then check for updates |
| `@architectury-updates show <dependency> ignore conditions` | List the ignore conditions that apply |

Reopening a pull request lifts the ignore conditions it added, as with Dependabot. `merge` relies on GitHub's auto-merge, so **Allow auto-merge** must be on and the branch needs a required status check. If the checks have already passed, it merges right away.

## Inputs

| Input | Default | |
| --- | --- | --- |
| `token` | `GITHUB_TOKEN` | Token for the GitHub API |
| `directory` | `/` | Gradle build to update; files below it are scanned too |
| `target-branch` | default branch | Branch to open pull requests against |
| `open-pull-requests-limit` | `5` | Maximum open pull requests |
| `labels` | `dependencies, java` | `dependencies` and `java` are created if missing; other missing labels are skipped |
| `assignees` | | Users to assign |
| `reviewers` | | Users or `org/team` to request reviews from |
| `milestone` | | Milestone number |
| `commit-message-prefix` | | Such as `build` → `build: bump …` |
| `commit-message-include` | | `scope` adds `(deps)` after the prefix |
| `rebase-strategy` | `auto` | `disabled` turns off automatic rebasing |
| `ignore` | | Ignore conditions in `dependabot.yml`'s format, see below |
| `allow` | | Only update dependencies matching these `dependency-name` patterns |
| `dispatch-workflows` | | Workflow files to start on update branches |
| `registry` | `https://maven.architectury.dev/` | Maven repository to read versions from |
| `branch-prefix` | `architectury-updates` | Prefix of update branches (the workflow's `if:` uses it too) |
| `branch-separator` | `/` | Separator in branch names |
| `dry-run` | `false` | Log what would happen without changing anything |

`ignore` takes the same list as Dependabot's `ignore` option:

```yaml
ignore: |
  # The API's major version follows the Minecraft version; stay on this one.
  - dependency-name: "dev.architectury:architectury*"
    update-types: ["version-update:semver-major"]
  - dependency-name: "dev.architectury.loom"
    versions: [">= 1.18"]
```

## Differences from Dependabot

- `@architectury-updates` isn't a GitHub account, so mentioning it notifies no one.
- No compatibility scores, security updates or `groups`. Artifacts that share a version property are still updated together.
- One `directory` per step. For several separate builds, add a step per directory.
- With `GITHUB_TOKEN`, a merge done by auto-merge doesn't trigger other workflows (such as ones on `push`), because GitHub attributes it to the token.

## Development

```sh
npm test
```

To see what the action would do to a repository without touching it:

```sh
env "INPUT_TOKEN=$(gh auth token)" "INPUT_DRY-RUN=true" GITHUB_REPOSITORY=owner/repo node src/index.js
```
