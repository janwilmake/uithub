# Process .gitattributes

After some research I found that https://github.com/public-apis/public-apis doesn't give the README file (280kb) because of their .gitattributes setting

If present we need to process it (see https://claude.ai/chat/1ad5ee29-7ea4-4dce-a61f-02a2aa582189)

1. point to the raw githubusercontent url for files which are ignored from the ZIP
2. If any LFS pointer files are present, this will hint us there are other bigger files. Use https://uithub.com/{owner}/{repo}/raw/{branch}/{...path}

And make the raw endpoint: https://uithub.com/{owner}/{repo}/raw/{branch}/{...path}

```ts
const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
const apiResponse = await fetch(apiUrl, {
  headers: {
    Accept: "application/vnd.github.raw",
  },
});
```

Confirm that it works without api key... Also allow passing an API key header/cookie/queryparameter
