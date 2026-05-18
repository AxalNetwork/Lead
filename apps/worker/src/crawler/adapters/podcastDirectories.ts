// Public podcast directory adapter — Apple Podcasts, Spotify (episode
// pages), Podchaser.

import type { SiteAdapter, AdapterResult } from "./types";
import { pickMeta, pickTitle } from "./_util";

export const podcastDirectories: SiteAdapter = {
  id: "podcast_directories",
  priority: 65,
  hosts: ["podcasts.apple.com", "open.spotify.com", "www.podchaser.com", "podchaser.com"],
  url_patterns: [
    /\/podcast\//i, /\/episode\//i, /\/show\//i, /\/creators\//i,
  ],
  profile_types_emitted: ["podcast_host"],
  extract(html, url): AdapterResult {
    const title = pickMeta(html, "og:title") || pickTitle(html);
    const desc = pickMeta(html, "og:description") || pickMeta(html, "description") || "";
    const image = pickMeta(html, "og:image");
    const isEpisode = /\/episode/i.test(url);
    return {
      adapter_id: "podcast_directories",
      confidence: title ? 0.55 : 0.25,
      candidates: [{
        profile_type: isEpisode ? null : "podcast_host",
        confidence: title ? 0.55 : 0.25,
        name: title || null,
        url,
        data: {
          podcast_name: title,
          description: desc,
          artwork: image,
          podcast_url: url,
          is_episode: isEpisode,
        },
      }],
      child_urls: [],
    };
  },
};
