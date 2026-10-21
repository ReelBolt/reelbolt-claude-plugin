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

1. refuses to run if the mirror checkout has uncommitted changes;
2. copies this directory over the mirror, leaving its `.git` alone;
3. commits the result and pushes it to the mirror's `origin`.

## Check for drift

```bash
./publish.sh --check /path/to/reelbolt-claude-plugin
```

It prints every difference and exits non-zero when the mirror is stale, so it can be used as a
pre-release gate.
