export type WatchStatus = 'unwatched' | 'watched' | 'watch_later';
export type SavedMediaType = 'reel' | 'post';
export type SavedCollectionSource = 'instagram' | 'bot';

export interface Creator {
  id: string;
  instagram_user_id: string;
  username: string;
  display_name?: string | null;
  profile_picture_url?: string | null;
  created_at: string;
  updated_at: string;
  saved_count?: number;
}

export interface SavedReel {
  id: string;
  instagram_media_id: string;
  shortcode: string;
  reel_url: string;
  media_type?: SavedMediaType;
  creator_id: string;
  caption?: string | null;
  thumbnail_url?: string | null;
  taken_at: string;
  saved_at?: string | null;
  first_detected_at: string;
  effective_saved_at?: string | null;
  save_order_rank: number;
  watch_status: WatchStatus;
  duration_seconds?: number | null;
  reminder_interval_hours?: number | null;
  reminder_interval_seconds?: number | null;
  reminders_sent_count?: number;
  last_reminded_at?: string | null;
  next_reminder_at?: string | null;
  awaiting_reminder_choice_until?: string | null;
  is_saved_on_instagram?: boolean;
  instagram_sender_id?: string | null;
  is_unavailable: boolean;
  created_at: string;
  updated_at: string;
  creator?: Creator;
}

export type DateFilterPreset =
  | 'all'
  | 'today'
  | 'yesterday'
  | '7d'
  | '30d'
  | '3m'
  | '6m'
  | 'year'
  | 'custom';

export interface ReelQueryFilters {
  creatorId?: string;
  instagramSenderId?: string | null;
  datePreset?: DateFilterPreset;
  startDate?: string;
  endDate?: string;
  watchStatus?: WatchStatus | 'all';
  mediaType?: SavedMediaType | 'all';
  source?: SavedCollectionSource | 'all';
  search?: string;
  sortBy?: 'newest_saved' | 'oldest_saved' | 'newest_published' | 'oldest_published';
  page?: number;
  limit?: number;
}

export interface LibraryStats {
  totalReels: number;
  savedOnInstagramCount: number;
  botSentCount: number;
  reelsCount: number;
  postsCount: number;
  totalCreators: number;
  savedThisWeek: number;
  savedThisMonth: number;
  unwatchedCount: number;
  watchedCount: number;
  watchLaterCount: number;
  topCreators: {
    id: string;
    username: string;
    display_name?: string | null;
    profile_picture_url?: string | null;
    count: number;
  }[];
}

export interface RawInstagramSavedItem {
  media: {
    id: string;
    code: string;
    taken_at: number;
    product_type?: string;
    media_type?: number;
    caption?: { text: string };
    user: {
      pk: string | number;
      username: string;
      full_name?: string;
      profile_pic_url?: string;
    };
    image_versions2?: {
      candidates?: { url: string; width: number; height: number }[];
    };
    video_duration?: number;
  };
}

export type Result<T, E = Error> = 
  | { success: true; data: T } 
  | { success: false; error: E };

export function ok<T>(data: T): Result<T, never> {
  return { success: true, data };
}

export function err<E>(error: E): Result<never, E> {
  return { success: false, error };
}

export interface BatchReelsResult {
  newlyImported: number;
  alreadyPresent: number;
  savedAtBackfilled: number;
  promotedToSaved: number;
  failedCount: number;
  failedShortcodes: string[];
}
