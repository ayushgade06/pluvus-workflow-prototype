// ---------------------------------------------------------------------------
// Creator DTO — the single shape the web app sees
// ---------------------------------------------------------------------------
// Shared by GET /creators and the import routes so the enroll picker can render
// a creator identically no matter which endpoint it arrived from.
//
// Note what is NOT here: metadata, signals, platformStats, socialLinks. Those
// carry raw vendor columns (including a phone number and adult-platform data)
// and have no business in a list view. Add them to a dedicated detail endpoint
// if they are ever needed, deliberately.

import type { Creator } from "../db/schema.js";

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
  };
}
