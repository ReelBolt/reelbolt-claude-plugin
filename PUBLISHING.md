# Publishing this plugin

**The source of truth is `plugins/reelbolt/` in ReelBolt's source repository.** The copy in
`github.com/vecchiotom/reelbolt-claude-plugin` is a published mirror: do not edit it there, because
the next publish overwrites it. Open an issue instead.

## Publish a change

From `plugins/reelbolt/` in the ReelBolt source repository, with the mirror checked out locally:

```bash
./publish.sh /path/to/reelbolt-claude-plugin
```

The script:

1. refuses if this directory has uncommitted or ignored files — only the **committed** tree is
   published, so an untracked `.env` or scratch file cannot reach the public repository;
2. refuses if the mirror checkout is dirty, has commits that were never pushed, or its `origin` is
   not the public mirror;
3. builds the payload with `git archive`, refuses the obvious credential shapes, and copies it over
   the mirror;
4. stages exactly the payload's paths (never `git add -A` on the checkout), commits, and pushes.

Commits in the public mirror are authored as `Tommaso Celano <vecchiotom@users.noreply.github.com>`,
so a personal mailbox never appears in the public history. Override with
`REELBOLT_PLUGIN_COMMIT_NAME` and `REELBOLT_PLUGIN_COMMIT_EMAIL` if that is wrong.

## Check for drift

```bash
./publish.sh --check /path/to/reelbolt-claude-plugin
```

It prints every difference and exits non-zero when the mirror's content is stale, has uncommitted
changes, or has commits that were never pushed — so it can be used as a pre-release gate.
