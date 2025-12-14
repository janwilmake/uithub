# Compare

https://github.com/CodeFromAnywhere/claudeflair/pull/11.diff
https://github.com/CodeFromAnywhere/claudeflair/pull/11.patch

Test compare and improve so it works for all comparison ways.

Create a test for this.

Ensure this can also respond in markdown style

# Mass compare endpoint

`https://uithub.com/codefromanywhere/compare/FROM_DATE[/UNTIL_DATE]`

API endpoint that runs compare between 2 datetimes for all repos by a given owner

To optimise efficiency here, we can first get the last change for any default_branch for all repos, and filter out the ones where that is before the from-date.

Respond with JSON, YAML, and Markdown

👀 This will allow asking an LLM questions like `What did I do in june 2024?`

# Transfer script

Single API endpoint where I can submit 2 github PAT and it will tranfser all repos under 1 to the other. Allow to keep privacy same, make all public or make all private. Choose to delete all, delete none, delete public, or delete private.

Useful for very specific usecase but it's great to reveal as api anyway: 'github mass transfer'

My usecases:

- back up: move all my repos to a new github user, put to private
- translate: move all my repos to a new github user but add portuguese comments to every file (https://github.com/CodeFromAnywhere/translate-codebase)

# Improve and cache `github-og-image`

Add github icon to the github-og-image. It's not visible somehow

Make header bigger so twitter shows numbers better

Needs to be cached to 24 hours at least.

Could make a big difference for crawlers showing the thing or not.
