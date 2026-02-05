✅ add search + include + exclude glob patterns

✅ try: uithub durable object idea https://x.com/janwilmake/status/2017261179974881698

✅ uithub oauth documented

✅ uithub cli

✅ oauth consent screen

✅ uithub skill

uithub release OSS repo

- make better readme
- oss
- announcement post

improve pricing? better converting page

# Progressive disclosure

https://uithub.com/openapi.json

I want to make an api for improved progressive disclosure for codebases. the api should use chat completions with tools with:

- initially: get tree + `**/README.md` + `**/AGENT.md`
- create a set a broad bunch of files + ranges. this should add it to the system prompt and reset the rest.
- remove files that aren't useful (this shoud remove it from the set)
- add file or files to the set (this should update the system prompt)
- prune files to one or multiple ranges. this should reduce the context window

this could be an SSE API that returns events for the currently added files and ranges. the cli can then reserve one line (that gets reset) for the files/ranges intermediately.
