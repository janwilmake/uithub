<!-- the first goal should be the resolver workflow and having it syncable to githuq via some issue watcher. afterwards i can start expanding my reach by finding repos with high potential-->

# Find effective general coding context for any repo automatically

Lots of codebases have irrelevant generated files that bloat up the repo to a point that it's not possible anymore to use it effectively with an LLM. The problem is that there's no real systematic approach to figure out which files are relevant generally and which generally aren't. There are always exceptions, there are always issues. As an example, the repo json-schema-to-typescript counts almost 10M tokens while the actual source is just 16k or 60k tokens depending on how you look at it (as can be seen in https://uithub.com/bcherny/json-schema-to-typescript/tree/master/src?lines=true or https://uithub.com/bcherny/json-schema-to-typescript/tree/master?lines=true&ext=ts). uithub has already got a hidden feature that looks at a `.genignore` file and if it exists, it removes these files from the context. However, nobody uses that. An interesting thing I could try is to automatically generate a .genignore file and load it from an external URL for any repo. It can probably accurately be generated based on the tree with tokensize info. If we do this, I'm sure we can drastically reduce context size for the majority of repos in public, while keeping the context quality high. It also doesn't need to be that expensive if we cache it in a 'good-enough' way.

TODO:

- create 'genignore' worker
- buy and connect genignore.com
- have it take /[owner]/[repo]/[tree/branch]?apiKey=xxx as path
- have it respond with hardcoded, cached, or generated `.genignore` contents
- hardcoded from raw.githubusercontent
- cache = r2 or kv
- generation is claude prompt based on tree in md
- after this is automatically made available at every repo, use this by default for uithub and add a disableGenignore queryparam
- in the github-dataset, track total repo tokensize + genignored tokensize (for top starred repos)

This will start giving me insights in how much of actual codebases we can work with. This could be a gamechanger for big refactors and ports...

# Bounty and Open Source Repo List

Put together a list of lists. Every list can be sourced by someone else and turned into a list of URLs of repos with a simple parser.

There aren't any lists on github of repos with bounties

Bounty program Apps:

- https://www.bountyhub.dev
- https://algora.io
- https://www.boss.dev/issues/open

However, we can also assume any open source repo with funding or revenue would give us money if we speed up their development.

- Scrape the bounty program app apis or websites and get to a list of owners and repos with that
- Scrape https://www.ycombinator.com/companies/industry/open-source and find the belonging github owners
- Scrape https://www.ycombinator.com/companies (5000+) and figure out if they have a github repo and have the owner.
- Scrape github's biggest open source repos and figure out if they belong to companies with revenue or funding.

Obviously this will take some time to get to this in an automated way... But it's much faster to start manually creating a single list in a repo readme: https://github.com/CodeFromAnywhere/awesome-bounty-repos

From here, we need to get to determine which repos are properly suitable for us to navigate in and build proper issue validation.

After I nailed this these filters, I can start cloning repos and solving issues in my cloned repos, and make PRs.

If I add a feature with a "TIP JAR" to every PR I made with a suggested price, the algo can start optimising maximising profit and minimising cost, in other words maximising EV.

Maybe this is too ambitious still, because the repos are actually very large, issues can be complex, and priorisation is hard. Maybe it's better to first focus on my own code of which I know much better how to solve issues.
