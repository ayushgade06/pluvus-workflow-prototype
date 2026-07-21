# CSV Creator Import (PLU-109)

How to prepare a creator list, and what the importer does with it.

Upload lives in the **Enroll** tab of a published workflow: *Upload CSV* → review the
preview → *Import*. Nothing is written to the roster until you confirm.

---

## Quick reference

Only **`email`** is required. Everything else is optional, and any column the importer
does not recognise is kept verbatim so no data is lost.

| Field | Recognised column names (any one) |
|---|---|
| **`email`** *(required)* | `email`, `email_address`, `e-mail`, `mail` |
| `name` | `name`, `full_name`, `creator_name`, `display_name`, `first_name` |
| `handle` | `handle`, `username`, `user`, `@` |
| `platform` | `platform`, `channel`, `network`, `social_platform` |
| `niche` | `niche`, `category`, `vertical`, `topic` |
| `profileUrl` | `url`, `link`, `profile_url`, `profile`, `profile_link` |
| `followerCount` | `followers`, `follower_count`, `subscribers`, `audience`, `reach` |
| `engagementRate` | `engagement`, `engagement_rate`, `engagement_percent` |
| `location` | `location`, `country`, `city`, `region` |
| `language` | `language`, `lang` |
| `bio` | `personal_intro`, `bio`, `biography`, `about`, `description` |
| *anything else* | kept verbatim under its original header |

**Matching is fuzzy and order-independent.** Headers are lowercased with spaces,
underscores and hyphens stripped, so `Email Address`, `email_address` and `E-Mail` are all
the same column. You can reorder columns freely.

A minimal working file:

```csv
email,name,platform,niche,Followers
jane@example.com,Jane Doe,Instagram,Fitness,120k
```

`sample-creators.csv` in the repo root is a valid template.

---

## File rules

- **UTF-8.** A leading byte-order mark is stripped automatically.
- **Delimiter is auto-detected** — tab, comma, or semicolon. A `.csv` file that is
  actually tab-separated (common in vendor exports) works without renaming.
- **Row 1 must be the header row** and must contain a recognisable email column. If it
  does not, the whole upload is rejected up front rather than partly imported.
- Standard CSV quoting is honoured: `"Patel, Riya"`, newlines inside quotes, and `""` for
  a literal quote character.
- Blank lines are skipped; every cell is trimmed.
- Up to **25 MB** per upload (roughly 5,000 rows of an 80-column export).

### Numbers

Audience counts may be written any of these ways: `120k`, `1.2M`, `1,200`, `54000`.
Percentages may include the sign: `4.2%` or `4.2`.

A **blank** count is stored as *unknown*, not as zero — so creators with no audience data
sort to the bottom of the list rather than looking like they have no followers.

---

## Vendor exports (per-network columns)

Creator-discovery tools export one block of columns per social network and **no**
`platform`, `handle`, or `niche` column at all. Those are derived instead:

| Derived | How |
|---|---|
| `platform` | The network with the **largest audience** |
| `handle` | That same network's `*_username` |
| `profileUrl` | That same network's `*_link` (or `*_url`) |
| `engagementRate` | That same network's `*_engagement_percent` |
| `followerCount` | The **maximum** across all networks |
| `niche` | `youtube_topic_details` → `hashtags_used` → `type_of_profile` |
| `bio` | `personal_intro` → the primary network's `*_biography` |

Recognised networks: `instagram_*`, `tiktok_*`, `youtube_*`, `twitter_*` (or `x_*`),
`twitch_*`, plus `patreon_link` and `onlyfans_link`.

Because `platform`, `handle`, `profileUrl`, and `engagementRate` all come from the *same*
winning network, they can never disagree with each other.

Everything else is retained in three structured fields:

- **`platformStats`** — per-network metrics (`followers`, `engagementPct`, `avgLikes`,
  `avgComments`, `postCount`, `lastPostDate`, `postingFrequency`)
- **`socialLinks`** — every network URL, plus `patreon`, `onlyfans`, `links_in_bio`,
  `external_urls`
- **`signals`** — `has_brand_deals`, `promotes_affiliate_links`, `has_merch`,
  `has_link_in_bio`, `type_of_profile`, income ranges

`sample-creators-vendor.tsv` is an 81-column example.

> `promotes_affiliate_links` is worth filtering on — a creator already running affiliate
> links is a warmer lead for a hybrid campaign.

### Privacy

Vendor exports often include `contact_phone_number` and `onlyfans_*` data. These are
stored (they are legitimate CRM data) but are **never** sent to the AI that drafts
outreach email. Only `name`, `platform`, `niche`, `handle`, and `bio` reach a model
provider — enforced by an allowlist in `server/src/validation/llmSafeCreator.ts` and
asserted by its test. `gender` is imported but must not drive targeting logic.

---

## How repeat uploads behave

Each upload becomes a separate, named **import list**, so a list uploaded today stays
distinct from one uploaded yesterday. In the Enroll tab, the **Source list** dropdown
scopes the creator list to a single import.

Creators themselves are deduplicated **globally by email**, case-insensitively — so
`Jane@x.com` and `jane@x.com` are the same person, and someone appearing in three uploads
is still one creator with three list memberships.

Re-importing an existing creator **enriches, never overwrites**:

- Fields arriving with a value are updated; existing values are never blanked.
- **`name` is the exception** — the existing roster name wins, so a name you corrected by
  hand is not clobbered by the next export.
- `socialLinks` / `platformStats` / `signals` merge **per key**, so an export carrying
  only TikTok data cannot wipe the Instagram block from an earlier import.

### Selecting from a long list

With a source list selected, the **Select** menu offers:

| Scope | Selects |
|---|---|
| Select all in this list | Every creator in the import |
| **Select only the new ones** | Only those this import added — skips creators you already had |
| Select those not yet enrolled here | Only those without an instance in this workflow |

Each row is badged **NEW**, **DUPLICATE** (with the other list's name), and **ENROLLED**,
so duplicates are visible *before* you click rather than discovered afterwards. Sort by
followers (default), engagement, or name.

### Rows that do not import

A row is skipped — never silently dropped — when it has no email, an unparseable email, or
an email already used by an earlier row in the same file. Each is reported with its row
number and reason in the preview, and retained in the import's audit trail with its
original cells, so a bad file stays diagnosable later.

Lists can be **renamed** or **archived** (hidden from the picker, audit kept). The original
uploaded file is retained and can be re-downloaded. A draft you discard is deleted along
with its file; a committed list cannot be deleted, only archived.
