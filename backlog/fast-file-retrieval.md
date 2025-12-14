# Static Hosting Performance

🤔 After trying this it quickly becomes evident that the speed is not satisfactory. Of course we could conclude we need it to be hosted in a assets worker but that would make it way less scalable. There are several other ways to improve speed though, so let's do it.

🤔 After trying it a bit more, it becomes evident the solution isn't scalable to large repos. oven-sh/bun just crashes... But that's also not my target now, is it?

Immediate things I think it would be better:

- For any website visited I could do an API call to check the latest update on that branch each minute in a `waitUntil`. That would make things much more up-to-date.
- Add KV cache layer onto individual github files at https://subdomain.githuq.com/{path} with a timeout of 1 day or so.
- Add a way to force refresh `?refresh=true` that forces re-retrieval of uithub zip.

# Fast File Retrieval

A core problem that is also core to uithub is fast file retrieval. How I solve it now is by always getting the latest zip directly from GitHub. This is slow for big zipfiles. At a minimum, the latency is transfering the zip to my location which can only go with a 100mb/s or so I think.

Building a service on top of GitHub is hard because it's hard to know whether or not their zip files are updated. For my own repos I can use a webhook to refresh stuff, for public repos I can use github events. **The webhooks take maximum several seconds**, p95 is under a second. It's not instant. The events for public repos are delayed [at least 5 minutes](https://github.blog/changelog/2018-08-01-new-delay-public-events-api/) and may be [up to 6 hours](https://github.blog/changelog/2018-08-01-new-delay-public-events-api/).

When someone pushes something to GitHub, that is the source of truth. If that person is authenticated with my services, I can be sure to have the newest version within a few seconds, as I can immediately propegate it to my own services. However, for public events, that is not possible, and I cannot guarantee things to be up-to-date if I don't use the original zip.

For the purpose of uithub, it's quite feasible still to use the zip for most smaller repos, but for larger ones, it's kind of annoying, as it can take dozens of seconds with ease.

If we want to cache things, we have multiple options. The question is how long we'd want to cache because it would take a large amount of storage. For something like uithub and also for viewing a website quickly, I think maybe redis is great.

Pricing for Upstash Redis is $0.25 per GB-month. If we would just store something for an hour each time, and we do that 100 times a day with repos 1GB each, 100GB-hour, 0.13GB-month, so 3.4 cent per day, €1 per month. That's a lot. But what if we just store it for 10 minutes? Or just 1 extra each time you reload the page? Reduced cost a lot, small reduction in usability. This seems interesting. I'm basically buying myself a working memory for the edge. $0.000005 or 172k GB-minutes for $1. If 1 user needs 1GB, that's basically 172k user-minutes for $1. Nice to calculate it like that. 29 user-hours for 1 cent. If you look at it like that, and we can actually use the redis in this way, it's damn cheap.

So how do we actually get it like that?

- Max commands per second: 1000
- Max request size: 1mb
- Max record size: 100mb
- Max data size: 10gb
- Oh wait.... max 200GB bandwidth after which i pay 0.03-0.10 per gb. this is the bottleneck that makes it incredibly expensive.

Ok... So Cloudflare KV is also expensive... It's 0.50 per GB-month. But R2 is $0.015 per GB month! But R2 takes 30 seconds to propagate I read somewhere. Is this true?

ARGGHHHHHH all these different factors make this a very complex problem! In the end there are just so many variables... The implementation also depends a lot on the usecase... Maybe I should read about it a bit about other people's experiences. I wish there was just a way that you could just write down your usecase and the AI would automatically find the best implementation with all this experimentation, etc. We're almost there!...

# Making zip subset retrieval faster

[About zip archives](https://docs.github.com/en/repositories/working-with-files/using-files/downloading-source-code-archives#stability-of-source-code-archives). Maybe I can do this:

- If I place the retrieval where the zip is.
- If I have the earliest possible filter
- If I use another language to do this such as rust

My original source is Github. The zip comes from there which is usually pretty fast.

After some tests, I found that retrieving a file from a zip can be incredibly fast. It takes less than a second to get https://uithub.com/file/facebook/react/blob/main/README.md and 2 seconds to get https://uithub.com/file/facebook/react/blob/main/compiler/packages/make-read-only-util/src/__tests__/makeReadOnly-test.ts even though the zipfile is an insane 600MB or so, compressed.

Doing some more tests from iad1 (us-east) I found that retrieving the zip via a fetch takes 50ms for small zips (claudeflair) versus 300ms for large ones (oven-sh/bun). However, parsing through the entire zip takes an additional 10ms for small zips (bun) versus 10 seconds for large ones (oven-sh/bun). After retrying I can see the zip of bun only takes 80ms to retrieve (may be cached by vercel or github), while the parsing of the zip still takes 8.7s for the image. However, if we encounter the file earlier, we now return early, which is a great advantage for things like `README.md`. This is all in production on max 3GB ram.

# TODO

Zipfiles of a repo vary widely in size, from several KB to several GBs and beyond. This makes it hard to have a uniform solution.

Depending on the needs i need to make uithub or githuq or githus faster. What these needs are isn't entirely clear yet. For now at least it works well enough without cache with small repos. Let's just keep it like that.
