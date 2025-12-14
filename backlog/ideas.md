# Changelog API

What if we could track all changes?

- parse CHANGELOG.md using LLM
- parse (closed) issues using LLM
- parse (merged) PR's using LLM
- parse direct changes to default branch in chunks of LLM-comprehensible size
- every day look for closed issues marked as resolved, merged prs, and changelog for the past day
- use LLM to compress timerange into a summary or highlights of the timerange in various sizes (with references).

# Porting repos at scale to other frameworks/languages

Porting a repo to other language can already be done. However, it's hard to do.

First priority is the UX simplicity.

Afterwards, improve how it's done...

Once we have testing at scale, ports will be verifyable.

# Translating repos or comments to other languages

https://github.com/CodeFromAnywhere/translate-codebase

# Using various strategies to solve issues for repos on GitHub

First step is the groundwork: the infra to make an issue instantly detected and starting a workflow. This creates a very visible uithub.

Just like cursor, the human is the verifyer, but since it's now a PR we don't need speed.

To improve it bigtime, we need verification through deployments and tests... Then it will be a true gamechanger to make this an open framework.
