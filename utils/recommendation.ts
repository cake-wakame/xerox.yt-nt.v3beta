
import type { Video, Channel } from '../types';
import { searchVideos, getChannelVideos } from './api';

// 文字列からハッシュタグや重要そうなキーワードを抽出する
const extractKeywords = (text: string): string[] => {
    if (!text) return [];
    const hashtags = text.match(/#[^\s#]+/g) || [];
    const brackets = text.match(/[\[【](.+?)[\]】]/g) || [];
    const rawText = text.replace(/[\[【].+?[\]】]/g, '').replace(/#[^\s#]+/g, '');
    const words = rawText.replace(/[!-/:-@[-`{-~]/g, ' ').split(/\s+/);
    const cleanHashtags = hashtags.map(t => t.trim());
    const cleanBrackets = brackets.map(t => t.replace(/[\[【\]】]/g, '').trim());
    const cleanWords = words.filter(w => w.length > 1 && !/^(http|www|com|jp)/.test(w));
    return [...cleanHashtags, ...cleanBrackets, ...cleanWords];
};

const shuffleArray = <T,>(array: T[]): T[] => {
    const newArray = [...array];
    for (let i = newArray.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
    }
    return newArray;
};

const parseDurationToSeconds = (isoDuration: string): number => {
    if (!isoDuration) return 0;
    const regex = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/;
    const matches = isoDuration.match(regex);
    if (!matches) return 0;
    const h = parseInt(matches[1] || '0', 10);
    const m = parseInt(matches[2] || '0', 10);
    const s = parseInt(matches[3] || '0', 10);
    return h * 3600 + m * 60 + s;
};

// 採点付き動画型
interface ScoredVideo extends Video {
    score: number;
    debugReason?: string[];
}

interface RecommendationSource {
    searchHistory: string[];
    watchHistory: Video[];
    subscribedChannels: Channel[];
    preferredGenres: string[];
    preferredChannels: string[];
    preferredDurations?: string[];
    preferredFreshness?: string;
    discoveryMode?: string;
    ngKeywords?: string[];
    // New preferences
    prefMood?: string;
    prefDepth?: string;
    prefVocal?: string;
    prefEra?: string;
    prefRegion?: string;
    prefLive?: string;
    prefInfoEnt?: string;
    prefPacing?: string;
    prefVisual?: string;
    prefCommunity?: string;
    page: number;
}

// --- SCORING ENGINE ---
// 各動画に対して、ユーザーの好みに基づいて点数を付けるシステム
const calculateScore = (
    video: Video, 
    source: RecommendationSource
): { score: number, reasons: string[] } => {
    let score = 0;
    const reasons: string[] = [];
    const lowerTitle = video.title.toLowerCase();
    const lowerDesc = (video.descriptionSnippet || '').toLowerCase();
    const lowerChannel = video.channelName.toLowerCase();
    const fullText = `${lowerTitle} ${lowerDesc} ${lowerChannel}`;
    
    // 1. NG Filter (Instant disqualification)
    if (source.ngKeywords) {
        for (const ng of source.ngKeywords) {
            if (fullText.includes(ng.toLowerCase())) {
                return { score: -10000, reasons: [`NG Keyword: ${ng}`] };
            }
        }
    }

    // 2. Duration Scoring (High Weight: +50)
    if (source.preferredDurations && source.preferredDurations.length > 0) {
        const sec = parseDurationToSeconds(video.isoDuration);
        let durationMatch = false;
        
        if (source.preferredDurations.includes('short') && sec > 0 && sec < 240) durationMatch = true;
        if (source.preferredDurations.includes('medium') && sec >= 240 && sec <= 1200) durationMatch = true;
        if (source.preferredDurations.includes('long') && sec > 1200) durationMatch = true;

        if (durationMatch) {
            score += 50;
            reasons.push('Duration Match');
        } else if (sec > 0) {
            // Length mismatch penalty
            score -= 20; 
        }
    }

    // 3. Preferred Channels (+30)
    if (source.preferredChannels.some(c => lowerChannel.includes(c.toLowerCase()))) {
        score += 30;
        reasons.push('Preferred Channel');
    }

    // 4. Subscribed Channels (+15)
    if (source.subscribedChannels.some(c => c.id === video.channelId || c.name.toLowerCase() === lowerChannel)) {
        score += 15;
        reasons.push('Subscribed Channel');
    }

    // 5. Keyword Matching (+10 per match)
    source.preferredGenres.forEach(genre => {
        if (fullText.includes(genre.toLowerCase())) {
            score += 10;
            reasons.push(`Genre Match: ${genre}`);
        }
    });

    // 6. Context/Mood Matching (+5 per match)
    // シンプルなキーワードマッチングで雰囲気をスコアリング
    const moodKeywords: Record<string, string[]> = {
        relax: ['relax', 'chill', 'bgm', 'healing', 'sleep', '癒し', '作業用', '睡眠'],
        energetic: ['hype', 'party', 'dance', 'excited', '高音質', '神回'],
        casual: ['short', 'funny', 'meme', '切り抜き', 'まとめ', '爆笑'],
        deep: ['documentary', 'history', 'analysis', '解説', '考察', '講座'],
        instrumental: ['instrumental', 'no talking', 'off vocal', 'bgm', 'asmr'],
        vocal: ['cover', 'talk', 'radio', '雑談', '歌ってみた'],
        retro: ['classic', '80s', '90s', 'retro', '懐かしい', '名作'],
        modern: ['2024', '2025', 'latest', 'trend', '最新', '流行'],
        live: ['live', 'stream', 'archive', '配信'],
        solo: ['solo', 'playing', 'play', 'ぼっち'],
        collab: ['collab', 'with', 'feat', 'コラボ']
    };

    const checkContext = (prefVal: string | undefined, key: string) => {
        if (prefVal && prefVal !== 'any' && moodKeywords[prefVal]) {
            if (moodKeywords[prefVal].some(k => fullText.includes(k))) {
                score += 8;
                reasons.push(`Context: ${prefVal}`);
            }
        }
    };

    checkContext(source.prefMood, 'mood');
    checkContext(source.prefDepth, 'depth');
    checkContext(source.prefVocal, 'vocal');
    checkContext(source.prefEra, 'era');
    checkContext(source.prefLive, 'live');
    checkContext(source.prefCommunity, 'community');

    // 7. Freshness Bonus
    if (source.preferredFreshness === 'new') {
        if (video.uploadedAt.includes('分前') || video.uploadedAt.includes('時間前') || video.uploadedAt.includes('日前') || video.uploadedAt.includes('hours ago')) {
            score += 10;
            reasons.push('Fresh');
        }
    }

    // 8. Random Noise (for diversity)
    score += Math.random() * 5;

    return { score, reasons };
};


export const getDeeplyAnalyzedRecommendations = async (sources: RecommendationSource): Promise<Video[]> => {
    const { 
        searchHistory, watchHistory, subscribedChannels, 
        preferredGenres, preferredChannels, 
        preferredFreshness = 'balanced', discoveryMode = 'balanced',
        prefMood, prefDepth, prefVocal, prefEra, prefRegion, prefLive, prefInfoEnt, prefPacing, prefVisual, prefCommunity,
        page 
    } = sources;
    
    const queries: Set<string> = new Set();
    
    // ---------------------------------------------------------
    // 1. Query Generation (Generate broad candidates)
    // ---------------------------------------------------------

    // Helper to add context to search queries
    const getContextKeywords = () => {
        const kws: string[] = [];
        if (prefMood === 'relax') kws.push('relaxing', 'bgm', 'chill');
        if (prefMood === 'energetic') kws.push('energetic', 'best moments');
        if (prefDepth === 'deep') kws.push('解説', 'documentary');
        if (prefVisual === 'avatar') kws.push('Vtuber');
        if (prefVisual === 'real') kws.push('vlog');
        return kws;
    };
    
    const contextSuffix = ' ' + shuffleArray(getContextKeywords()).slice(0, 1).join(' ');
    const freshnessSuffix = preferredFreshness === 'new' ? ' new' : '';

    // A. From Explicit Genres
    preferredGenres.forEach(g => queries.add(`${g}${contextSuffix}${freshnessSuffix}`));
    
    // B. From Preferred Channels
    preferredChannels.forEach(c => queries.add(`${c}${contextSuffix}`));

    // C. From Watch History (Analyze recent interests)
    if (discoveryMode !== 'discovery') {
        const recentHistory = watchHistory.slice(0, 5);
        recentHistory.forEach(v => {
             const keywords = extractKeywords(v.title);
             if (keywords.length > 0) {
                 // Pick dominant keyword
                 queries.add(`${keywords[0]}${contextSuffix}`);
             }
        });
    }

    // D. From Subscriptions (if balanced or subscribed mode)
    if (discoveryMode !== 'discovery') {
        // Subscriptions are handled by direct ID fetching below, but add some keywords too
        const randomSub = subscribedChannels[Math.floor(Math.random() * subscribedChannels.length)];
        if (randomSub) queries.add(`${randomSub.name}${contextSuffix}`);
    }

    // E. Fallback / Discovery
    if (queries.size === 0 || discoveryMode === 'discovery') {
        queries.add(`Japan trending${contextSuffix}`);
        queries.add(`Music${contextSuffix}`);
        queries.add(`Gaming${contextSuffix}`);
    }

    // Limit queries per page to avoid API rate limits
    const uniqueQueries = Array.from(queries).slice(0, 5); // Fetch max 5 distinct queries per load
    
    // ---------------------------------------------------------
    // 2. Fetching (Parallel Requests)
    // ---------------------------------------------------------
    
    const fetchPromises: Promise<any>[] = [];

    // Search Queries
    uniqueQueries.forEach(q => {
        fetchPromises.push(searchVideos(q).then(res => res.videos).catch(() => []));
    });

    // Direct Channel Feeds (High reliability source)
    if (discoveryMode !== 'discovery' && subscribedChannels.length > 0) {
        // Pick 3 random subscribed channels to mix in
        const subsToFetch = shuffleArray(subscribedChannels).slice(0, 3);
        subsToFetch.forEach(sub => {
            fetchPromises.push(
                getChannelVideos(sub.id).then(res => 
                    res.videos.map(v => ({...v, channelName: sub.name, channelAvatarUrl: sub.avatarUrl, channelId: sub.id}))
                ).catch(() => [])
            );
        });
    }

    const results = await Promise.allSettled(fetchPromises);
    let rawCandidates: Video[] = [];
    results.forEach(res => {
        if (res.status === 'fulfilled' && Array.isArray(res.value)) {
            rawCandidates.push(...res.value);
        }
    });

    // Deduplicate
    const seenIds = new Set<string>();
    const uniqueCandidates: Video[] = [];
    for (const v of rawCandidates) {
        if (!seenIds.has(v.id)) {
            seenIds.add(v.id);
            uniqueCandidates.push(v);
        }
    }

    // ---------------------------------------------------------
    // 3. Scoring & Ranking (The Core Logic)
    // ---------------------------------------------------------

    const scoredVideos: ScoredVideo[] = uniqueCandidates.map(video => {
        const { score, reasons } = calculateScore(video, sources);
        return { ...video, score, debugReason: reasons };
    });

    // Filter out negative scores (NG items)
    const validVideos = scoredVideos.filter(v => v.score > -1000);

    // Sort by Score Descending
    validVideos.sort((a, b) => b.score - a.score);

    // Return top results (e.g. Top 40)
    // Mix in a little bit of randomness for lower ranked items to keep it fresh?
    // For now, strict score ordering is requested ("dedicated system").
    
    return validVideos.slice(0, 50);
};
