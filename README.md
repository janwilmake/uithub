Ok so it's been a while! today i wanna bring back some version of uithub that doesn't accept bot traffic without api key

Older uithub-related code:

- https://github.com/janwilmake?tab=repositories&q=uithub
- https://github.com/janwilmake/uithub.llms
- https://github.com/janwilmake/uit
- https://github.com/janwilmake/uithub-mcp

Requirements

- Should follow MCP standard for oauth such that any client can get an API key that hides the original github key
- Should have all features the old uithub had
- Should be free and accessible but if no api key is provided, show an unclosable popup to sign w/ github first, without private repo access.
