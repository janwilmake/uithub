# Backlog (Optional stuff)

## Analytics

Show subscribers in analytics, also add `user.isSubscribed`

If I do this nicely I can see all in a single table: Just ask Claude based on analytics OpenAPI

- Table with scores over months per user
  - Table with scores over days per user
    - Table with scores over dayparts per user

## Dashboard

Add small dashboard showing API key, requests, subscription status, link to cancellation, etc. This is primarily needed for devs so they can embed uithub for something.

Endpoint to make a new payment link (Allow for discounts for larger prices). Tie #credits and githubUserId to the metadata

Form in dashboard to choose amount of $ to n of credits, that creates payment link

## Good for API use

- Ask JP guy to include a github PAT so it can be tied to his username
- For browser-first things that request markdown/json, ensure to resond with `{"error":"You have used up all your requests, please go to https://uithub.com to get more."}` so all users get that after their own ratelimit.

## Extract the analytics and paywall

It'd be great to put this into a small package on JSR so I can reuse this across workers. In the end most of my workers have no user state, so even user-state can be abstracted away with this, potentially.

# Pricepoint

Is pricing for regular requests not too expensive? Maybe should make it 10x cheaper: 0.1 cent per request. This is more similar to e.g. scrapingbee. However, let's see first with this pricing (5000x that of upstash)

The reason it's good is:

- we're giving the first $10/month at a 10x cheaper rate
- we need room to give massive discounts to enterprise; b2c doesn't need to be cheap at scale, as they won't have scale
- 1 cent per additional request is fair, won't cost a dollar for an entire day of regular use. and you won't normally get to this much traffic unless you're really building something bigger
- $10/month now gives 10k requests which is 333 per day on average, which should be more than sufficient.
