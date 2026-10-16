<!-- Moved verbatim from AGENTS.md on 2026-10-17 (AGENTS.md is now a map). -->

# Visual evidence, PR bodies, definition of done

### Visual evidence

A **short screen recording is the default**; a screenshot suffices only when the change is static (renamed label, new field present). Record the actual interaction on a running app using the verify skill and seeded/fixture data so reviewers see what CI would verify.

Committed visual-regression baselines under `tests/visual/baselines/fixtures` are test oracles rendered from fixture data only (not PR evidence) and are allowed; captures of deployed origins are never committed.

**Recorder:** Playwright `recordVideo` / `video: 'on'` against the live-verify instance — one test or clip per claim. Scripts wait on asserted UI states, never sleeps.

**Format:** Encode as H.264 in an MP4 container, not Playwright's default VP8-in-WebM. GitHub, Linear, and phones preview MP4; WebM often does not.

```bash
ffmpeg -i clip.webm \
  -c:v libx264 -preset medium -crf 23 -pix_fmt yuv420p -movflags +faststart \
  clip.mp4
```

**Embed in the PR:** Check the installed CLI and the actual attachment flag before posting:

```bash
gh --version
gh pr comment --help | rg -- '--attach|--body-file'
gh pr comment --body-file proof.md --attach proof.mp4
```

`proof.md` is an example body file containing the exact claim and code path; `proof.mp4` is an example artifact path. `gh pr comment` resolves the pull request from the current branch. GitHub CLI v2.99.0+ supports repeatable `--attach` for issue/PR create, edit, and comment commands. Use `--attach 'screenshot.png#Alt text'` for image alt text; video attachments have no alt-text suffix. The command uses the OAuth token from `gh auth login` or a classic PAT and requires repository write access; GitHub Enterprise Server is not supported. If the version or help check fails, upgrade `gh` through the approved package-management path or use GitHub's browser upload flow. Do not use undocumented CLI subcommands or hand-written upload requests. See [GitHub CLI: Media in issues, pull requests, and comments](https://github.blog/changelog/2026-09-01-github-cli-media-in-issues-pull-requests-and-comments/) for the supported behavior and limits. Reference the proof in the linked Linear issue when one exists, then read the posted PR or comment back and confirm the attachment renders in the intended context; command success alone is not proof.

Label each clip with the exact claim it proves and which code path. Use **Before / After** pairs for fixes.

**Refactors are not exempt.** A refactor claimed inert arguably needs footage more than a feature: tests can stay green while visible behavior moves. Never label passing test output as "Screenshots" or "Evidence" of user-visible behavior.

### PR bodies and definition of done

PR bodies should carry: **problem**, **why** (including what was ruled out), **user impact** ("nothing" is valid when justified), **evidence** (commands with real exit codes plus visual proof when UI changes), and **known gaps**.

Never judge a gate through a pipe: `cmd | tail` reports `tail`'s exit status, not `cmd`'s.

If a PR closes only part of a Linear ticket, add a `## Partial` section listing acceptance criteria closed vs remaining. Do not let GitHub–Linear automation mark the whole issue Done.

**Done** means every acceptance criterion is met, not that the PR merged. After merge, Linear status must match remaining ACs.

### Playwright assertions (e2e)

Where Playwright drives UI proof, scope assertions to visible elements (`:visible`, roles, labels). Do not treat hidden SSR duplicates as data. Run `bun run fix` on e2e specs you touch (Lefthook/Ultracite).
