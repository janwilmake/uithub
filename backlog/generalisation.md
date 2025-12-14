if i add these as workers or vercel functions, it would allow me to move more and more to cloudflare and it would allow better debugging of pipelines because every step in the pipeline is logged

- upload any file -> url
- url of a zip or tar.gz -> fileobject
- fileobject url -> zip url

if we have this, we can just plug the github zips into the second one. on top of that, we can build tools like renamify (https://www.producthunt.com/products/renamify#renamify) more easily
