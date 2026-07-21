// ---------------------------------------------------------------------------
// Creator DTO — the single shape the web app sees
// ---------------------------------------------------------------------------
// Shared by GET /creators and the import routes so the enroll picker can render
// a creator identically no matter which endpoint it arrived from.
//
// Note what is NOT here: metadata, signals, socialLinks. Those carry raw vendor
// columns (including a phone number and adult-platform links) and have no
// business in a list view. Add them to a dedicated detail endpoint if they are
// ever needed, deliberately.
//
// `platforms` IS included, as a narrow projection of platformStats rather than
// the raw blob: it holds only the five mainstream networks' audience numbers
// (Patreon/OnlyFans are link-only and never appear in platformStats). The table
// shows a creator's biggest network only, so without this the UI could not tell
// you that a creator is cross-platform — and their best-engaging network is
// frequently not their biggest.

import type { Creator } from "../db/schema.js";
import {
  summarizePlatforms,
  type CreatorPlatformSummary,
} from "../validation/creatorFields.js";

export interface CreatorDto {
  id: string;
  name: string;
  email: string;
  handle: string | null;
  platform: string | null;
  niche: string | null;
  profileUrl: string | null;
  /** Null means UNKNOWN, not zero — the picker sorts these last. */
  followerCount: number | null;
  engagementRate: number | null;
  location: string | null;
  language: string | null;
  /** Every network with audience data, biggest first. Often more than one. */
  platforms: CreatorPlatformSummary[];
}

export function toCreatorDto(c: Creator): CreatorDto {
  return {
    id: c.id,
    name: c.name,
    email: c.email,
    handle: c.handle,
    platform: c.platform,
    niche: c.niche,
    profileUrl: c.profileUrl,
    followerCount: c.followerCount,
    engagementRate: c.engagementRate,
    location: c.location,
    language: c.language,
    platforms: summarizePlatforms(c.platformStats),
  };
}
