# Collector seed files

The source adapters read these files through `CollectContext.seeds` (types in `../src/types.ts`, the `Seeds`
interface). A seed is a discovery hint. It is never a metric and never a claim about the whole platform. A
category in a seed is a taxonomy id: one of the 20 `TOP_LEVEL_CATEGORY_IDS`, or a subcategory from
`packages/core/src/taxonomy.ts` such as `music/kpop` or `food/mukbang`. The classifier treats it as account
evidence with weight 0.6, and title, tag and source evidence can override it.

Last built and verified: **2026-09-28**, from Asia/Seoul. All requests used polite rates: YouTube at most
2 requests per second, Dailymotion at most 4 per second, and niconico and SepiaSearch at most 1 per second.

| File | Type | Count | Used by |
|---|---|---:|---|
| `youtube-channels.json` | `YoutubeChannelSeed[]` | 391 (350 KR + 41 global) | `youtube-rss`: 1 feed request per channel per run |
| `keywords.json` | `KeywordSeed[]` | 151 (ko 131, en 12, ja 8) | `youtube-data-api` (search.list, only with `YOUTUBE_API_KEY`); can also drive Dailymotion or PeerTube keyword search |
| `dailymotion.json` | `DailymotionQuerySeed[]` | 70 | `dailymotion` (`/videos` queries, in priority order) |
| `niconico.json` | `NiconicoQuerySeed[]` | 23 | `niconico` (Snapshot Search API v2) |
| `peertube.json` | `PeertubeQuerySeed[]` | 11 | `peertube` (SepiaSearch) |
| `creators.json` | `CreatorSeed[]` | 14 | pipeline (`creators` / `creator_accounts`): cross-platform portfolios |

## youtube-channels.json

Currently active Korean channels in all 20 top-level categories, plus a comparison set of well-known
global channels (US 24, JP 7, GB 3 and 1 each from SE, NL, DE, CA, AU, CY and IN). The fields are:

- `channelId` is the canonical `UC…` id, the only field the RSS adapter needs.
- `handle` is the `@handle` the id was resolved from.
- `name` is the channel title exactly as it appears in the RSS feed `<title>`. The HTML page title can be
  localized. For example, `@MrBeast` shows as 미스터 비스트 for Korean visitors.
- `category` is a taxonomy id (top-level or subcategory).
- `country` is the channel's home market, ISO-3166 upper case. It is not viewer geography.
- `language` is a hint for the main video language. It is `null` when the latest titles were mostly not
  Korean and the spoken language was unclear, as for `@HYBELABELS`, `@BLACKPINK`, `@YGEntertainment`,
  `@THEBLACKLABEL`, `@VogueKorea` and `@mokongtv123`. `@JFlaMusic`, `@VISITKOREA`, `@koreanenglishman` and
  `@ArirangCoKrArirangNEWS` are `en`.
- `creatorId`, when present, points to `creators.json`. It is set on 20 channels.

Entries are grouped as the Korean channels first, then the global ones, each in taxonomy order.

**Korean channels per top-level category** (subcategories counted under their parent):

| beauty | fashion | food | gaming | music | entertainment | comedy | film_animation | news_politics | sports |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 14 | 15 | 16 | 13 | 33 | 39 | 11 | 16 | 21 | 22 |

| education | science_tech | travel | lifestyle | kids_family | pets_animals | autos | business_finance | health_fitness | howto_diy |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 17 | 18 | 13 | 21 | 18 | 11 | 9 | 17 | 14 | 12 |

The global set has at least one channel in every top-level category (41 in total).

Subcategories in use: `beauty/makeup`, `beauty/skincare`, `beauty/product_review`, `fashion/menswear`,
`fashion/streetwear`, `food/mukbang`, `food/cooking`, `food/restaurants`, `gaming/esports`, `gaming/mobile`,
`gaming/lets_play`, `music/kpop`, `music/trot`, `music/hiphop`, `music/live`, `music/cover`, `music/jpop`,
`entertainment/variety`, `entertainment/talk_podcast`, `entertainment/drama`, `entertainment/streamer`,
`entertainment/celebrity`, `comedy/sketch`, `film_animation/movie_review`, `film_animation/anime`,
`sports/soccer`, `sports/baseball` and `sports/basketball`. All of them existed in `taxonomy.ts` on
2026-09-28.

### How the list was built and verified

The verification scripts were throwaway Node scripts. They are not in the repo; the procedure is below.

1. **Candidates.** About 400 channel names came from knowledge of the Korean YouTube market, plus some
   generic category queries such as 뜨개질 코바늘 or 목공 DIY for thin categories. Each name was looked up on
   the YouTube search results page with the channel filter (`sp=EgIQAg%3D%3D`). From `ytInitialData`, the
   script read `channelRenderer.channelId`, the handle and the subscriber label. When a name matched several
   channels, the official or largest one was picked by hand. This page was used only to find handles, never
   for metrics.
2. **Resolve.** The script fetched `https://www.youtube.com/@<handle>` with a browser User-Agent and read
   `<link rel="canonical" href="https://www.youtube.com/channel/UC…">`. Some handles return a 303 redirect to
   a dead legacy `/customurl` that gives 404: `@MKTV`, `@LYW_official`, `@뚜식이`, `@닥터프렌즈` and
   `@onulun`. For those, the script opened `https://www.youtube.com/channel/<id>` instead and required both
   the canonical link to be the same id and `vanityChannelUrl` to be exactly that `@handle`.
3. **Verify the feed.** `https://www.youtube.com/feeds/videos.xml?channel_id=<id>` had to return HTTP 200,
   the feed `<title>` had to match the channel, and the newest entry `<published>` had to be at most 90
   days before 2026-09-28. Candidates that failed were dropped.
4. **Review content.** The latest 15 entry titles of every channel were read. Categories were corrected
   where a channel's current content had drifted. For example, 회사원A `@calarygirl` now posts leisure and
   travel reviews, so it is `lifestyle`. 한동숙, 룩삼 and 따효니 are now `entertainment/streamer`. The share
   of titles containing Hangul set the `language` field.
5. **Re-check.** The final 391 feeds were fetched again on 2026-09-28. All 391 returned 200. The newest
   upload is at most 88.4 days old, with a median of 0.5 days; 348 channels uploaded within 7 days and 375
   within 30 days.

These candidates were **dropped as inactive**, with the days since the latest upload on 2026-09-28:
`@PONYMakeup` (107), `@daddoa` (1788), `@short_mouth_sun` (285), `@KOZENTOFFICIAL` (1183), `@나래식` (299),
`@studiowaffle_official` (723), `@COMEDYBIGLEAGUE` (1096), `@studio_jbbj` (354), `@winterbooks` (271),
`@여락이들` (1319), `@yonjiham` (1299), `@dudupoptoy_kr` (879), `@SuriNoel` (235), `@motorgraph` (419),
`@CARLABmedia` (1256), `@thankyoububu` (383), `@Jung_DIY` (302), `@onulun` (948) and `@emmachamberlain`
(295). These names were **not found** as a channel: 홀리, iamzzin(쨍) and 펫콕. Borderline but kept:
`@yogaboyofficial` (88 days). PewDiePie's latest upload, on 2026-09-22, is titled "Thank you and Goodbye.",
so re-check it on the next refresh.

### Adding a channel

1. Find the handle (the channel URL `youtube.com/@…`).
2. Resolve the id:
   `curl -sL -A "Mozilla/5.0 …" https://www.youtube.com/@HANDLE | grep -o '<link rel="canonical" href="[^"]*"'`.
   If this gives 404 or no canonical link, open `/channel/UC…` instead and check `"vanityChannelUrl"`.
3. Check the feed: `curl -s "https://www.youtube.com/feeds/videos.xml?channel_id=UC…"` must return 200 and
   the newest `<entry><published>` must be within 90 days.
4. Add `{ channelId, handle, name (feed <title>), category, country, language }` in its category block. Use a
   subcategory only if it exists in `taxonomy.ts`, otherwise use the top-level id. Keep `channelId` and
   `handle` unique.
5. Set `creatorId` only together with an entry in `creators.json` that lists `youtube:<channelId>`.

Cost: the RSS adapter spends 1 request per channel, so 391 requests take about 3.3 minutes at 2 requests
per second. When `maxRequests` is lower, rotate channels across runs. Do not always cut the tail, because
the global set sits at the end of the file.

## keywords.json

There are 151 search phrases. 131 are Korean and spread over all 20 top-level categories, with more for
gaming, sports, news, business, science and music. The other 20 are English and Japanese phrases about
Korean content, such as `kpop`, `mukbang`, `korean skincare`, 韓国料理 and 韓国コスメ, plus a few
general ones.

Budget note: YouTube Data API `search.list` costs 100 quota units per call, and the default quota is 10,000
units per day. Searching all 151 keywords every day would take 15,100 units, so the `youtube-data-api`
adapter should rotate through the list, for example about 60 keywords per day.

## dailymotion.json

These are 70 `/videos` queries. The channel slugs come from `https://api.dailymotion.com/channels`, which
lists 17 channels on 2026-09-28: animals, auto, people, fun, creation, school, videogames, kids,
lifestyle, shortfilms, music, news, sport, tech, travel, tv and webcam. `webcam` is not used. The file is in
**priority order**, so an adapter that stops at `maxRequests` still gets the fresh Korean results first.

| # | Queries | Why |
|---|---|---|
| 1–8 | `country=kr, language=ko`, `trending` and `recent` for news, tv, fun and sport | the only KR channel queries that return fresh uploads |
| 9–24 | `country=kr, language=ko, sort=recent, search=<16 Korean keywords>` (정치, 경제, 사건, 건강, 야구, 축구, 골프, 부동산, 주식, 여행, 예능, 드라마, 아이돌, 트로트, 게임, 먹방) | fresh uploads by topic |
| 25–40 | `country=kr, language=ko, sort=visited-week` for 16 channels | popularity baseline for KR |
| 41–56 | `country=kr, language=ko, sort=visited-today` for 16 channels | popularity baseline for KR |
| 57–60 | global `trending` for news, tv, fun and lifestyle | global comparison |
| 61–70 | global `visited-today` for 10 channels | global comparison |

All queries use `limit: 100`. On 2026-09-28, all 70 queries returned results. What was observed:

- With `country=kr`, `trending` returned results only for news (100, 89 of them from the last 7 days), tv,
  fun and sport. It returned **0 results** for the other 12 channels, so those were replaced by keyword
  searches. Re-test occasionally.
- With `country=kr`, `visited-today` and `visited-week` mostly return **old** videos, often with
  `views_last_day = 0`. For example, 0 of the top 100 KR news videos were from the last 7 days. They work
  as a stable baseline, not as "trending now". Use the source window fields (`views_last_day/week/month`)
  and not the rank.
- `trending` only returns fresh Korean items when `language=ko` is also set. `country=kr&sort=trending`
  alone returned 77 mostly non-Korean items.
- The largest KR uploaders are YTN news, 채널A (News, Life, Home, Entertainment), 톱스타뉴스, MBN,
  TVCHOSUN and 중앙일보, which is why the creator portfolios are built around these outlets.

## niconico.json

There are 23 Snapshot Search queries, all with `targets: tagsExact`, `sinceDays: 30` and `limit: 100`. They
cover ゲーム (twice, by `-viewCounter` and `-startTime`), 実況プレイ動画, 音楽, VOCALOID (twice), 歌ってみた,
踊ってみた, アニメ, 料理, 旅行, 車載動画, 動物, 科学, ニコニコ技術部, 作ってみた, 歴史, ゆっくり解説, 政治,
スポーツ, エンターテイメント, ソフトウェアトーク劇場 and Vtuber. Each tag maps to one taxonomy category.

All 23 were verified on 2026-09-28 with `filters[startTime][gte]` set to 30 days earlier, and all 23
returned hits. Totals ranged from 58 for スポーツ to 12,450 for ゲーム. The snapshot `last_modified` was
2026-09-28T07:08:32+09:00. Notes on tag choice:

- The plain tag 技術部 has no hits; the real tag is ニコニコ技術部.
- The tags ニュース, 動物 and スポーツ are heavily used by meme compilations (ホモと見る…). News uses 政治 instead
  of ニュース, and the classifier should not fully trust the seed category for 動物 and スポーツ.
- 例のアレ was left out on purpose because it is a meme genre with brand-safety problems.

## peertube.json

There are 11 SepiaSearch queries: `languageOneOf` ko, en, ja and fr with `-publishedAt`; ko, en and fr with
`-views`; and search terms `한국`, `korea`, `K-pop` and `science` (en). All returned results on 2026-09-28.
Totals were ko 1,035, en 203,914, ja 9,596 and fr 133,342 videos. Without a date filter, `-views` returns
very old videos: the newest in the ko top 100 was 504 days old. See the contract note below.

## creators.json

There are 14 cross-platform portfolios, each linking a YouTube channel in this list to a Dailymotion account
(`youtube:UC…` and `dailymotion:<owner id>`). They are included only when there was evidence, and each note
says what the evidence is:

- **Strong evidence** means an identical handle or username on both platforms, or both accounts linking to
  the organization's website. This covers YTN, 채널A, TV조선, MBN, 연합뉴스TV, Mnet (M2), JYP Entertainment,
  Arirang TV and 톱스타뉴스.
- **Medium evidence** means the same brand name on both platforms and a Dailymotion *verified partner*
  account. This covers BLACKPINK, 딩고 뮤직, 중앙일보, MBC SPORTS+ and ALL THE K-POP.
- A creator can be an organization with several channels, such as 채널A (3 YouTube channels and 5 Dailymotion
  accounts) or Arirang TV. A portfolio is not a claim that the videos are identical.
- Many of the Dailymotion accounts stopped uploading years ago, so the notes give the latest upload date.
  Accounts that uploaded on both platforms in the 7 days before 2026-09-28: YTN, 채널A and 톱스타뉴스.
- Dailymotion "Arirang News" links in its description to a *different* YouTube channel, "Arirang News
  Center", whose feed had no entries. That is why the Arirang link is at organization level.

Candidates were found with `https://api.dailymotion.com/users?search=<name>&fields=id,screenname,username,verified,videos_total`,
with the owners of Dailymotion KR results, and with `https://api.dailymotion.com/user/<id>?fields=website_url,description,created_time,verified`.
The YouTube side was checked against the channel header links. KBS, SBS, MBC, JTBC, HYBE, SMTOWN and 1theK
have no verified Dailymotion account, so they have no portfolio.

## Contract notes for the integrator

- `PeertubeQuerySeed` has no date filter, and SepiaSearch accepts `startDate`. A `sinceDays: number | null`
  field, as niconico has, would make the `-views` queries useful ("top views in the last N days").
- `YoutubeChannelSeed` could take an optional `subscribers` field (a label, not a metric) to help rank
  channels when the request budget runs short. It is not needed today.
