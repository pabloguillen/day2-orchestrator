# Usage events: how day2 measures growth in your product

day2 judges experiments by what people do **in your app**: whether they sign
up and reach first value. Clicks don't count. To do that, an app reports a
few usage events to day2. An experiment's page ticket asks day2 to add this
when the app doesn't have it yet.

## The endpoint

Your app serves:

```
GET /api/day2-events?since=<ISO 8601 time>
→ 200 { "events": [ Event, … ] }
```

Optionally protect it with a token. day2 sends `Authorization: Bearer <token>`.
Return 404 (or leave the endpoint out) and day2 says "not measured", never "zero".

```ts
type Event = {
  type: string;         // "visit", "signup", "activated", or your own
  at: string;           // ISO 8601
  deviceId: string;     // anonymous, stable per browser/device — no names or emails
  acquisition?: {       // on a device's first event, when known
    campaignId?: string; // "B-3" when the visitor came through ?d2=B-3
    channel?: string;    // where they came from — see the table below
  };
};
```

## The events that matter

| Event | When |
|---|---|
| `visit` | The first time a device opens the app or site. When the URL has `?d2=<id>`, set `acquisition.campaignId` to that id. |
| `signup` | The person created an account. |
| `activated` | The person reached first value, the moment your product works for them (e.g. split their first bill). |

| `shared` | The person shared something from the app (share button, copy link). |
| `invite_sent` | The person invited someone. |
| `invite_accepted` | Someone joined through an invite. |

### Where people came from: `acquisition.channel`

On a device's first event, set the channel when you can tell:

| Channel | When |
|---|---|
| `search` | The referrer is a search engine (Google, Bing, DuckDuckGo…). |
| `ai_assistant` | The referrer is an AI assistant (chatgpt.com, perplexity.ai, claude.ai, gemini.google.com…). |
| `shared_link` | They opened a link someone shared from the app (add `?ref=share` to shared links). |
| `invite` | They came through an invite link. |
| `paid` | They came through an ad (`?d2=` present). |

day2 uses these to check, before and after, whether a change to a growth
feature helped: more people sharing or inviting, more new visitors from
shared links, search or AI assistants.

Keep the `?d2=` value through sign-up (for example in a first-party cookie)
so the sign-up and later events belong to the same device.

## How an experiment is judged

day2 takes everyone whose **first** visit was while the experiment ran. It
compares people who came through the experiment's link with everyone else:
what share of each signed up or reached first value. It calls a result only
once both groups have at least 30 people, using a Bayesian comparison. A
result is "working" when the experiment's group is better with at least
90% probability.
