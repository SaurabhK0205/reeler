import type {
  Creator,
  SavedReel,
  ReelQueryFilters,
  LibraryStats,
  WatchStatus,
  DateFilterPreset
} from '../types.ts';
import { getSupabase, isSupabaseConfigured } from './client.ts';

// In-Memory store for offline/demo/development fallback
class InMemoryStore {
  creators: Map<string, Creator> = new Map();
  reels: Map<string, SavedReel> = new Map();

  async upsertCreator(data: {
    instagram_user_id: string;
    username: string;
    display_name?: string | null;
    profile_picture_url?: string | null;
  }): Promise<Creator> {
    let existing: Creator | undefined;
    for (const c of this.creators.values()) {
      if (c.instagram_user_id === data.instagram_user_id) {
        existing = c;
        break;
      }
    }

    const now = new Date().toISOString();
    if (existing) {
      existing.username = data.username;
      existing.display_name = data.display_name ?? existing.display_name;
      existing.profile_picture_url = data.profile_picture_url ?? existing.profile_picture_url;
      existing.updated_at = now;
      return existing;
    }

    const newCreator: Creator = {
      id: `creator_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      instagram_user_id: data.instagram_user_id,
      username: data.username,
      display_name: data.display_name,
      profile_picture_url: data.profile_picture_url,
      created_at: now,
      updated_at: now,
    };
    this.creators.set(newCreator.id, newCreator);
    return newCreator;
  }

  async upsertSavedReel(data: {
    instagram_media_id: string;
    shortcode: string;
    reel_url: string;
    creator_id: string;
    caption?: string | null;
    thumbnail_url?: string | null;
    taken_at: string;
    saved_at?: string | null;
    first_detected_at: string;
    save_order_rank: number;
    watch_status?: WatchStatus;
    duration_seconds?: number | null;
    reminder_interval_hours?: number | null;
    next_reminder_at?: string | null;
    is_saved_on_instagram?: boolean;
    instagram_sender_id?: string | null;
    awaiting_reminder_choice_until?: string | null;
  }, options?: { ignoreDuplicates?: boolean; skipReturn?: boolean }): Promise<SavedReel | null> {
    let existing: SavedReel | undefined;
    for (const r of this.reels.values()) {
      if (r.instagram_media_id === data.instagram_media_id || r.shortcode === data.shortcode) {
        existing = r;
        break;
      }
    }

    const now = new Date().toISOString();

    if (existing) {
      if (options?.ignoreDuplicates) {
        return options.skipReturn ? null : existing;
      }
      existing.caption = data.caption ?? existing.caption;
      existing.thumbnail_url = data.thumbnail_url ?? existing.thumbnail_url;
      existing.save_order_rank = data.save_order_rank;
      if (data.watch_status) existing.watch_status = data.watch_status;
      if (data.next_reminder_at !== undefined) existing.next_reminder_at = data.next_reminder_at;
      if (data.awaiting_reminder_choice_until !== undefined) existing.awaiting_reminder_choice_until = data.awaiting_reminder_choice_until;
      if (data.reminder_interval_hours) existing.reminder_interval_hours = data.reminder_interval_hours;
      existing.updated_at = now;
      return options?.skipReturn ? null : existing;
    }

    const newReel: SavedReel = {
      id: `reel_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      instagram_media_id: data.instagram_media_id,
      shortcode: data.shortcode,
      reel_url: data.reel_url,
      creator_id: data.creator_id,
      caption: data.caption,
      thumbnail_url: data.thumbnail_url,
      taken_at: data.taken_at,
      saved_at: data.saved_at,
      first_detected_at: data.first_detected_at,
      save_order_rank: data.save_order_rank,
      watch_status: data.watch_status || 'unwatched',
      duration_seconds: data.duration_seconds,
      reminder_interval_hours: data.reminder_interval_hours ?? 10,
      reminders_sent_count: 0,
      next_reminder_at: data.next_reminder_at,
      awaiting_reminder_choice_until: data.awaiting_reminder_choice_until,
      is_saved_on_instagram: data.is_saved_on_instagram ?? true,
      instagram_sender_id: data.instagram_sender_id,
      is_unavailable: false,
      created_at: now,
      updated_at: now,
      creator: this.creators.get(data.creator_id),
    };

    this.reels.set(newReel.id, newReel);
    return options?.skipReturn ? null : newReel;
  }

  async getReels(filters: ReelQueryFilters) {
    let list = Array.from(this.reels.values()).map(r => ({
      ...r,
      creator: this.creators.get(r.creator_id)
    }));

    // Filter by Creator
    if (filters.creatorId) {
      list = list.filter(r => r.creator_id === filters.creatorId);
    }

    // Filter by Watch Status
    if (filters.watchStatus && filters.watchStatus !== 'all') {
      list = list.filter(r => r.watch_status === filters.watchStatus);
    }

    // Filter by Date Preset or Range
    const { startDate, endDate } = resolveDateRange(filters.datePreset, filters.startDate, filters.endDate);
    if (startDate) {
      const startMs = new Date(startDate).getTime();
      list = list.filter(r => new Date(r.first_detected_at).getTime() >= startMs);
    }
    if (endDate) {
      const endMs = new Date(endDate).getTime();
      list = list.filter(r => new Date(r.first_detected_at).getTime() <= endMs);
    }

    // Search query
    if (filters.search?.trim()) {
      const q = filters.search.toLowerCase().trim();
      list = list.filter(r => {
        const captionMatch = r.caption?.toLowerCase().includes(q) ?? false;
        const usernameMatch = r.creator?.username.toLowerCase().includes(q) ?? false;
        const nameMatch = r.creator?.display_name?.toLowerCase().includes(q) ?? false;
        return captionMatch || usernameMatch || nameMatch;
      });
    }

    // Sorting
    const sort = filters.sortBy || 'newest_saved';
    list.sort((a, b) => {
      if (sort === 'newest_saved') return a.save_order_rank - b.save_order_rank; // 1 = newest
      if (sort === 'oldest_saved') return b.save_order_rank - a.save_order_rank;
      if (sort === 'newest_published') return new Date(b.taken_at).getTime() - new Date(a.taken_at).getTime();
      if (sort === 'oldest_published') return new Date(a.taken_at).getTime() - new Date(b.taken_at).getTime();
      return 0;
    });

    const total = list.length;
    const page = Math.max(1, filters.page || 1);
    const limit = Math.max(1, Math.min(100, filters.limit || 24));
    const offset = (page - 1) * limit;
    const paged = list.slice(offset, offset + limit);

    return { reels: paged, total, page, limit };
  }

  async getCreators(): Promise<Creator[]> {
    const counts = new Map<string, number>();
    for (const r of this.reels.values()) {
      counts.set(r.creator_id, (counts.get(r.creator_id) || 0) + 1);
    }

    const list = Array.from(this.creators.values()).map(c => ({
      ...c,
      saved_count: counts.get(c.id) || 0
    }));

    list.sort((a, b) => (b.saved_count || 0) - (a.saved_count || 0));
    return list;
  }

  async getStats(): Promise<LibraryStats> {
    const allReels = Array.from(this.reels.values());
    const now = Date.now();
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

    let savedThisWeek = 0;
    let savedThisMonth = 0;
    let unwatchedCount = 0;
    let watchedCount = 0;
    let watchLaterCount = 0;

    for (const r of allReels) {
      const detectedMs = new Date(r.first_detected_at).getTime();
      if (detectedMs >= sevenDaysAgo) savedThisWeek++;
      if (detectedMs >= thirtyDaysAgo) savedThisMonth++;

      if (r.watch_status === 'unwatched') unwatchedCount++;
      else if (r.watch_status === 'watched') watchedCount++;
      else if (r.watch_status === 'watch_later') watchLaterCount++;
    }

    const creators = await this.getCreators();
    const topCreators = creators.slice(0, 5).map(c => ({
      id: c.id,
      username: c.username,
      display_name: c.display_name,
      profile_picture_url: c.profile_picture_url,
      count: c.saved_count || 0
    }));

    return {
      totalReels: allReels.length,
      totalCreators: this.creators.size,
      savedThisWeek,
      savedThisMonth,
      unwatchedCount,
      watchedCount,
      watchLaterCount,
      topCreators
    };
  }

  async updateWatchStatus(id: string, status: WatchStatus): Promise<SavedReel | null> {
    const reel = this.reels.get(id);
    if (!reel) return null;
    reel.watch_status = status;
    if (status === 'watched') {
      reel.next_reminder_at = null;
    }
    reel.updated_at = new Date().toISOString();
    return { ...reel, creator: this.creators.get(reel.creator_id) };
  }
}

const memoryStore = new InMemoryStore();

function resolveDateRange(preset?: DateFilterPreset, customStart?: string, customEnd?: string) {
  if (preset === 'custom' || (!preset && (customStart || customEnd))) {
    return { startDate: customStart, endDate: customEnd };
  }

  if (!preset || preset === 'all') {
    return { startDate: undefined, endDate: undefined };
  }

  const now = new Date();
  const start = new Date(now);

  switch (preset) {
    case 'today':
      start.setHours(0, 0, 0, 0);
      break;
    case 'yesterday': {
      start.setDate(now.getDate() - 1);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setHours(23, 59, 59, 999);
      return { startDate: start.toISOString(), endDate: end.toISOString() };
    }
    case '7d':
      start.setDate(now.getDate() - 7);
      break;
    case '30d':
      start.setDate(now.getDate() - 30);
      break;
    case '3m':
      start.setMonth(now.getMonth() - 3);
      break;
    case '6m':
      start.setMonth(now.getMonth() - 6);
      break;
    case 'year':
      start.setFullYear(now.getFullYear(), 0, 1);
      start.setHours(0, 0, 0, 0);
      break;
  }

  return { startDate: start.toISOString(), endDate: undefined };
}

export class Repository {
  static async upsertCreator(data: {
    instagram_user_id: string;
    username: string;
    display_name?: string | null;
    profile_picture_url?: string | null;
  }): Promise<Creator> {
    if (!isSupabaseConfigured()) {
      return memoryStore.upsertCreator(data);
    }

    const supabase = getSupabase();
    const { data: creator, error } = await supabase
      .from('creators')
      .upsert(
        {
          instagram_user_id: data.instagram_user_id,
          username: data.username,
          display_name: data.display_name,
          profile_picture_url: data.profile_picture_url,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'instagram_user_id' }
      )
      .select()
      .single();

    if (error || !creator) {
      throw new Error(`Supabase upsertCreator failed: ${error?.message || 'unknown error'}`);
    }

    return creator as Creator;
  }

  static async upsertSavedReel(data: {
    instagram_media_id: string;
    shortcode: string;
    reel_url: string;
    creator_id: string;
    caption?: string | null;
    thumbnail_url?: string | null;
    taken_at: string;
    saved_at?: string | null;
    first_detected_at: string;
    save_order_rank: number;
    watch_status?: WatchStatus;
    duration_seconds?: number | null;
    reminder_interval_hours?: number | null;
    reminder_interval_seconds?: number | null;
    next_reminder_at?: string | null;
    awaiting_reminder_choice_until?: string | null;
    is_saved_on_instagram?: boolean;
    instagram_sender_id?: string | null;
  }, options?: { ignoreDuplicates?: boolean; skipReturn?: boolean }): Promise<SavedReel | null> {
    if (!isSupabaseConfigured()) {
      return memoryStore.upsertSavedReel(data, options);
    }

    const supabase = getSupabase();
    const intervalSeconds = data.reminder_interval_seconds ?? (data.reminder_interval_hours ? data.reminder_interval_hours * 3600 : 36000);
    const query = supabase
      .from('saved_reels')
      .upsert(
        {
          instagram_media_id: data.instagram_media_id,
          shortcode: data.shortcode,
          reel_url: data.reel_url,
          creator_id: data.creator_id,
          caption: data.caption,
          thumbnail_url: data.thumbnail_url,
          taken_at: data.taken_at,
          saved_at: data.saved_at,
          first_detected_at: data.first_detected_at,
          save_order_rank: data.save_order_rank,
          watch_status: data.watch_status || 'unwatched',
          duration_seconds: data.duration_seconds,
          reminder_interval_hours: Math.round(intervalSeconds / 3600),
          reminder_interval_seconds: intervalSeconds,
          next_reminder_at: data.next_reminder_at,
          awaiting_reminder_choice_until: data.awaiting_reminder_choice_until ?? null,
          is_saved_on_instagram: data.is_saved_on_instagram ?? true,
          instagram_sender_id: data.instagram_sender_id,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'instagram_media_id', ignoreDuplicates: options?.ignoreDuplicates ?? false }
      );

    const { data: reel, error } = options?.skipReturn
      ? await query
      : await query.select('*, creator:creators(*)').maybeSingle();

    if (error) {
      if (
        options?.ignoreDuplicates &&
        (error.code === '23505' ||
          error.message?.includes('duplicate key') ||
          error.message?.includes('shortcode') ||
          error.message?.includes('instagram_media_id'))
      ) {
        if (options.skipReturn) {
          return null;
        }
        const { data: existing, error: fetchErr } = await supabase
          .from('saved_reels')
          .select('*, creator:creators(*)')
          .or(`instagram_media_id.eq.${data.instagram_media_id},shortcode.eq.${data.shortcode}`)
          .maybeSingle();
        if (existing) return existing as SavedReel;
        if (fetchErr) throw new Error(`Supabase fetch conflicting reel failed: ${fetchErr.message}`);
      }
      throw new Error(`Supabase upsertSavedReel failed: ${error.message}`);
    }

    if (options?.skipReturn) {
      return null;
    }

    if (!reel && options?.ignoreDuplicates) {
      const { data: existing, error: fetchErr } = await supabase
        .from('saved_reels')
        .select('*, creator:creators(*)')
        .or(`instagram_media_id.eq.${data.instagram_media_id},shortcode.eq.${data.shortcode}`)
        .maybeSingle();
      if (existing) return existing as SavedReel;
      if (fetchErr) throw new Error(`Supabase fetch existing reel failed: ${fetchErr.message}`);
    }

    if (!reel) {
      throw new Error('Supabase upsertSavedReel returned no record');
    }

    return reel as SavedReel;
  }

  static async getReelsDueForReminder(): Promise<SavedReel[]> {
    const now = new Date().toISOString();

    if (!isSupabaseConfigured()) {
      return Array.from(memoryStore.reels.values())
        .filter(r => r.watch_status === 'watch_later' && r.next_reminder_at && r.next_reminder_at <= now)
        .map(r => ({ ...r, creator: memoryStore.creators.get(r.creator_id) }));
    }

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('saved_reels')
      .select('*, creator:creators(*)')
      .eq('watch_status', 'watch_later')
      .lte('next_reminder_at', now);

    if (error) {
      throw new Error(`Failed to fetch reminder due reels: ${error.message}`);
    }

    return (data || []) as SavedReel[];
  }

  static async updateReminderSchedule(id: string, nextReminderAt: string, intervalSeconds?: number): Promise<void> {
    const now = new Date().toISOString();
    if (!isSupabaseConfigured()) {
      const reel = memoryStore.reels.get(id);
      if (reel) {
        reel.next_reminder_at = nextReminderAt;
        reel.awaiting_reminder_choice_until = null;
        if (intervalSeconds) {
          reel.reminder_interval_seconds = intervalSeconds;
          reel.reminder_interval_hours = Math.round(intervalSeconds / 3600);
        }
      }
      return;
    }

    const supabase = getSupabase();
    const updatePayload: Record<string, any> = {
      next_reminder_at: nextReminderAt,
      watch_status: 'watch_later',
      awaiting_reminder_choice_until: null,
      updated_at: now,
    };
    if (intervalSeconds) {
      updatePayload.reminder_interval_seconds = intervalSeconds;
      updatePayload.reminder_interval_hours = Math.round(intervalSeconds / 3600);
    }

    await supabase.from('saved_reels').update(updatePayload).eq('id', id);
  }

  static async getActiveAwaitingReelForSender(senderId: string): Promise<SavedReel | null> {
    if (!isSupabaseConfigured()) {
      const match = Array.from(memoryStore.reels.values())
        .filter(r => r.instagram_sender_id === senderId && r.watch_status === 'watch_later' && r.awaiting_reminder_choice_until)
        .sort((a, b) => new Date(b.updated_at || b.created_at).getTime() - new Date(a.updated_at || a.created_at).getTime())[0];
      return match ? { ...match, creator: memoryStore.creators.get(match.creator_id) } : null;
    }

    const supabase = getSupabase();
    const { data } = await supabase
      .from('saved_reels')
      .select('*, creator:creators(*)')
      .eq('instagram_sender_id', senderId)
      .eq('watch_status', 'watch_later')
      .not('awaiting_reminder_choice_until', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    return (data as SavedReel) || null;
  }

  static async getLastReelForInstagramSender(senderId: string): Promise<SavedReel | null> {
    if (!isSupabaseConfigured()) {
      const match = Array.from(memoryStore.reels.values())
        .filter(r => r.instagram_sender_id === senderId)
        .sort((a, b) => new Date(b.updated_at || b.created_at).getTime() - new Date(a.updated_at || a.created_at).getTime())[0];
      return match || null;
    }

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('saved_reels')
      .select('*, creator:creators(*)')
      .eq('instagram_sender_id', senderId)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) {
      // Fallback: return the most recent reel overall
      const { data: fallback } = await supabase
        .from('saved_reels')
        .select('*, creator:creators(*)')
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      return fallback as SavedReel || null;
    }

    return data as SavedReel;
  }

  static async recordReminderSent(id: string, nextReminderAt: string | null): Promise<void> {
    const now = new Date().toISOString();

    if (!isSupabaseConfigured()) {
      const reel = memoryStore.reels.get(id);
      if (reel) {
        reel.reminders_sent_count = (reel.reminders_sent_count || 0) + 1;
        reel.last_reminded_at = now;
        reel.next_reminder_at = nextReminderAt;
      }
      return;
    }

    const supabase = getSupabase();
    // fetch current count
    const { data: current } = await supabase.from('saved_reels').select('reminders_sent_count').eq('id', id).single();
    const newCount = (current?.reminders_sent_count || 0) + 1;

    await supabase
      .from('saved_reels')
      .update({
        reminders_sent_count: newCount,
        last_reminded_at: now,
        next_reminder_at: nextReminderAt,
        updated_at: now,
      })
      .eq('id', id);
  }

  static async getReels(filters: ReelQueryFilters): Promise<{ reels: SavedReel[]; total: number; page: number; limit: number }> {
    if (!isSupabaseConfigured()) {
      return memoryStore.getReels(filters);
    }

    const supabase = getSupabase();
    const page = Math.max(1, filters.page || 1);
    const limit = Math.max(1, Math.min(100, filters.limit || 24));
    const offset = (page - 1) * limit;

    let query = supabase
      .from('saved_reels')
      .select('*, creator:creators(*)', { count: 'exact' });

    if (filters.creatorId) {
      query = query.eq('creator_id', filters.creatorId);
    }

    if (filters.watchStatus && filters.watchStatus !== 'all') {
      query = query.eq('watch_status', filters.watchStatus);
    }

    const { startDate, endDate } = resolveDateRange(filters.datePreset, filters.startDate, filters.endDate);
    if (startDate) {
      query = query.gte('first_detected_at', startDate);
    }
    if (endDate) {
      query = query.lte('first_detected_at', endDate);
    }

    if (filters.search?.trim()) {
      const q = filters.search.trim();
      query = query.ilike('caption', `%${q}%`);
    }

    const sort = filters.sortBy || 'newest_saved';
    if (sort === 'newest_saved') query = query.order('save_order_rank', { ascending: true });
    else if (sort === 'oldest_saved') query = query.order('save_order_rank', { ascending: false });
    else if (sort === 'newest_published') query = query.order('taken_at', { ascending: false });
    else if (sort === 'oldest_published') query = query.order('taken_at', { ascending: true });

    query = query.range(offset, offset + limit - 1);

    const { data, count, error } = await query;
    if (error) {
      throw new Error(`Supabase getReels failed: ${error.message}`);
    }

    return {
      reels: (data || []) as SavedReel[],
      total: count || 0,
      page,
      limit,
    };
  }

  static async getCreators(): Promise<Creator[]> {
    if (!isSupabaseConfigured()) {
      return memoryStore.getCreators();
    }

    const supabase = getSupabase();
    const { data: creators, error } = await supabase
      .from('creators')
      .select('*, saved_reels(count)');

    if (error) {
      throw new Error(`Supabase getCreators failed: ${error.message}`);
    }

    const result: Creator[] = (creators || []).map((c: any) => ({
      id: c.id,
      instagram_user_id: c.instagram_user_id,
      username: c.username,
      display_name: c.display_name,
      profile_picture_url: c.profile_picture_url,
      created_at: c.created_at,
      updated_at: c.updated_at,
      saved_count: c.saved_reels?.[0]?.count || 0,
    }));

    result.sort((a, b) => (b.saved_count || 0) - (a.saved_count || 0));
    return result;
  }

  static async getReelsByCreatorUsername(username: string): Promise<{ creator: Creator | null; reels: SavedReel[] }> {
    const cleanUsername = username.replace(/^@/, '').trim().toLowerCase();
    if (!cleanUsername) return { creator: null, reels: [] };

    if (!isSupabaseConfigured()) {
      let matchedCreators = Array.from(memoryStore.creators.values()).filter(
        c => c.username.toLowerCase() === cleanUsername
      );
      if (matchedCreators.length === 0) {
        matchedCreators = Array.from(memoryStore.creators.values()).filter(
          c => c.username.toLowerCase().includes(cleanUsername) || (c.display_name && c.display_name.toLowerCase().includes(cleanUsername))
        );
      }
      if (matchedCreators.length === 0) return { creator: null, reels: [] };

      const creatorIds = new Set(matchedCreators.map(c => c.id));
      const primaryCreator = matchedCreators.find(c => c.display_name && c.profile_picture_url)
        || matchedCreators.find(c => c.display_name)
        || matchedCreators[0];

      const reels = Array.from(memoryStore.reels.values())
        .filter(r => creatorIds.has(r.creator_id))
        .sort((a, b) => new Date(b.created_at || b.first_detected_at).getTime() - new Date(a.created_at || a.first_detected_at).getTime())
        .map(r => ({ ...r, creator: primaryCreator }));

      return { creator: primaryCreator, reels };
    }

    const supabase = getSupabase();
    // 1. Try exact match first across all creator records with this username
    let { data: creators } = await supabase
      .from('creators')
      .select('*')
      .ilike('username', cleanUsername);

    // 2. If no exact match, try partial match on username or display_name
    if (!creators || creators.length === 0) {
      const { data: partialCreators } = await supabase
        .from('creators')
        .select('*')
        .or(`username.ilike.%${cleanUsername}%,display_name.ilike.%${cleanUsername}%`)
        .limit(10);
      creators = partialCreators || [];
    }

    if (!creators || creators.length === 0) {
      return { creator: null, reels: [] };
    }

    // Pick best primary creator record for display information
    const primaryCreator = creators.find(c => c.display_name && c.profile_picture_url)
      || creators.find(c => c.display_name)
      || creators[0];

    const creatorIds = creators.map(c => c.id);

    // Fetch all reels linked to any matching creator ID, sorted freshest first
    const { data: reels, error: rErr } = await supabase
      .from('saved_reels')
      .select('*, creator:creators(*)')
      .in('creator_id', creatorIds)
      .order('created_at', { ascending: false });

    if (rErr) {
      console.error(`[Repository] Error fetching reels for creator ${primaryCreator.id}:`, rErr.message);
      return { creator: primaryCreator as Creator, reels: [] };
    }

    const mappedReels = (reels || []).map(r => ({
      ...r,
      creator: r.creator || primaryCreator,
    })) as SavedReel[];

    return { creator: primaryCreator as Creator, reels: mappedReels };
  }

  static async getStats(): Promise<LibraryStats> {
    if (!isSupabaseConfigured()) {
      return memoryStore.getStats();
    }

    const supabase = getSupabase();
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const [totalReelsRes, creatorsRes, weekRes, monthRes, unwatchedRes, watchedRes, watchLaterRes] = await Promise.all([
      supabase.from('saved_reels').select('*', { count: 'exact', head: true }),
      Repository.getCreators(),
      supabase.from('saved_reels').select('*', { count: 'exact', head: true }).gte('first_detected_at', sevenDaysAgo),
      supabase.from('saved_reels').select('*', { count: 'exact', head: true }).gte('first_detected_at', thirtyDaysAgo),
      supabase.from('saved_reels').select('*', { count: 'exact', head: true }).eq('watch_status', 'unwatched'),
      supabase.from('saved_reels').select('*', { count: 'exact', head: true }).eq('watch_status', 'watched'),
      supabase.from('saved_reels').select('*', { count: 'exact', head: true }).eq('watch_status', 'watch_later'),
    ]);

    const topCreators = creatorsRes.slice(0, 5).map(c => ({
      id: c.id,
      username: c.username,
      display_name: c.display_name,
      profile_picture_url: c.profile_picture_url,
      count: c.saved_count || 0
    }));

    return {
      totalReels: totalReelsRes.count || 0,
      totalCreators: creatorsRes.length,
      savedThisWeek: weekRes.count || 0,
      savedThisMonth: monthRes.count || 0,
      unwatchedCount: unwatchedRes.count || 0,
      watchedCount: watchedRes.count || 0,
      watchLaterCount: watchLaterRes.count || 0,
      topCreators,
    };
  }

  static async updateWatchStatus(id: string, status: WatchStatus): Promise<SavedReel | null> {
    if (!isSupabaseConfigured()) {
      return memoryStore.updateWatchStatus(id, status);
    }

    const supabase = getSupabase();
    const updatePayload: Record<string, any> = {
      watch_status: status,
      updated_at: new Date().toISOString(),
    };
    if (status === 'watched') {
      updatePayload.next_reminder_at = null;
    }

    const { data, error } = await supabase
      .from('saved_reels')
      .update(updatePayload)
      .eq('id', id)
      .select('*, creator:creators(*)')
      .single();

    if (error || !data) {
      throw new Error(`Failed to update watch status: ${error?.message}`);
    }

    return data as SavedReel;
  }

  static async markWatchedForInstagramSender(senderId: string): Promise<SavedReel[]> {
    const now = new Date().toISOString();
    if (!isSupabaseConfigured()) {
      const updated: SavedReel[] = [];
      for (const reel of memoryStore.reels.values()) {
        if (reel.watch_status === 'watch_later' && (!senderId || reel.instagram_sender_id === senderId)) {
          reel.watch_status = 'watched';
          reel.next_reminder_at = null;
          reel.awaiting_reminder_choice_until = null;
          reel.updated_at = now;
          updated.push({ ...reel, creator: memoryStore.creators.get(reel.creator_id) });
        }
      }
      return updated;
    }

    const supabase = getSupabase();
    // 1. Try finding reels explicitly matching instagram_sender_id
    const { data: activeReels } = await supabase
      .from('saved_reels')
      .select('*, creator:creators(*)')
      .eq('instagram_sender_id', senderId)
      .eq('watch_status', 'watch_later');

    if (activeReels && activeReels.length > 0) {
      await supabase
        .from('saved_reels')
        .update({
          watch_status: 'watched',
          next_reminder_at: null,
          awaiting_reminder_choice_until: null,
          updated_at: now,
        })
        .eq('instagram_sender_id', senderId)
        .eq('watch_status', 'watch_later');
      return activeReels as SavedReel[];
    }

    // 2. Fallback: match any active watch_later reel
    const { data: latest } = await supabase
      .from('saved_reels')
      .select('*, creator:creators(*)')
      .eq('watch_status', 'watch_later')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latest) {
      await supabase
        .from('saved_reels')
        .update({
          watch_status: 'watched',
          next_reminder_at: null,
          awaiting_reminder_choice_until: null,
          updated_at: now,
        })
        .eq('id', latest.id);
      return [latest as SavedReel];
    }

    return [];
  }

  static async getReelsAwaitingChoiceDue(): Promise<SavedReel[]> {
    const now = new Date().toISOString();
    if (!isSupabaseConfigured()) {
      return Array.from(memoryStore.reels.values())
        .filter(r => r.watch_status === 'watch_later' && r.awaiting_reminder_choice_until && r.awaiting_reminder_choice_until <= now)
        .map(r => ({ ...r, creator: memoryStore.creators.get(r.creator_id) }));
    }

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('saved_reels')
      .select('*, creator:creators(*)')
      .eq('watch_status', 'watch_later')
      .not('awaiting_reminder_choice_until', 'is', null)
      .lte('awaiting_reminder_choice_until', now);

    if (error || !data) return [];
    return data as SavedReel[];
  }

  static async activateDefaultReminder(id: string, defaultHours: number = 10): Promise<{ reel: SavedReel; targetTime: Date }> {
    const now = new Date();
    const targetTime = new Date(now.getTime() + defaultHours * 3600 * 1000);
    const targetIso = targetTime.toISOString();

    if (!isSupabaseConfigured()) {
      const reel = memoryStore.reels.get(id);
      if (reel) {
        reel.awaiting_reminder_choice_until = null;
        reel.reminder_interval_hours = defaultHours;
        reel.reminder_interval_seconds = defaultHours * 3600;
        reel.next_reminder_at = targetIso;
        reel.updated_at = now.toISOString();
        return { reel: { ...reel, creator: memoryStore.creators.get(reel.creator_id) }, targetTime };
      }
      throw new Error('Reel not found in memory store');
    }

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('saved_reels')
      .update({
        awaiting_reminder_choice_until: null,
        reminder_interval_hours: defaultHours,
        reminder_interval_seconds: defaultHours * 3600,
        next_reminder_at: targetIso,
        updated_at: now.toISOString(),
      })
      .eq('id', id)
      .select('*, creator:creators(*)')
      .single();

    if (error || !data) {
      throw new Error(`Failed to activate default reminder: ${error?.message}`);
    }

    return { reel: data as SavedReel, targetTime };
  }
}
