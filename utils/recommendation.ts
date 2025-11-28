import type { Video, Channel } from '../types';
import { searchVideos, getRecommendedVideos, parseDuration } from './api';
import { extractKeywords, calculateMagnitude } from './xrai';
import type { BlockedChannel, HiddenVideo } from '../contexts/PreferenceContext';

interface RecommendationSource {
    searchHistory: string[];
    watchHistory: Video[];
    shortsHistory?: Video[];
    subscribedChannels: Channel[];
    ngKeywords: string[];
    ngChannels: BlockedChannel[];
    hiddenVideos: HiddenVideo[];
    negativeKeywords: Map<string, number>;
    page: number;
}

export interface HomeFeed {
    videos: Video[];
    shorts: Video[];
}

const shuffleArray = <T,>(array: T[]): T[] => {
    const newArray = [...array];
    for (let i = newArray.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
    }
    return newArray;
};

const cleanTitleForSearch = (title: string): string => {
    return title.replace(/【.*?】|\[.*?\]|\(.*?\)/g, '').trim().split(' ').slice(0, 4).join(' ');
};

const isShortVideo = (v: Video): boolean => {
    const seconds = parseDuration(v.isoDuration, v.duration);
    return (seconds > 0 && seconds <= 60) || v.title.toLowerCase().includes('#shorts');
};

export const getXraiRecommendations = async (sources: RecommendationSource): Promise<HomeFeed> => {
    const { 
        watchHistory, 
        subscribedChannels,
        ngKeywords,
        ngChannels,
        hiddenVideos,
        negativeKeywords
    } = sources;

    const TARGET_VIDEOS = 50;
    const TRENDING_VIDEO_RATIO = 0.40;
    const TARGET_SHORTS = 20;

    const seenIds = new Set<string>(hiddenVideos.map(v => v.id));
    const ngChannelIds = new Set(ngChannels.map(c => c.id));

    const filterAndDedupe = (videos: Video[]): Video[] => {
        return videos.filter(v => {
            if (seenIds.has(v.id)) return false;
            
            const fullText = `${v.title} ${v.channelName}`.toLowerCase();

            if (ngKeywords.some(ng => fullText.includes(ng.toLowerCase()))) return false;
            if (ngChannelIds.has(v.channelId)) return false;

            const vKeywords = [...extractKeywords(v.title), ...extractKeywords(v.channelName)];
            let negativeScore = 0;
            vKeywords.forEach(k => {
                if (negativeKeywords.has(k)) {
                    negativeScore += (negativeKeywords.get(k) || 0);
                }
            });
            if (negativeScore > 2) return false;
            
            seenIds.add(v.id);
            return true;
        });
    };

    // 1. Fetch Personalized Seeds
    let personalizedSeeds: string[] = [];
    if (watchHistory.length > 0) {
        const historySample = shuffleArray(watchHistory).slice(0, 5);
        personalizedSeeds = historySample.map(v => `${cleanTitleForSearch(v.title)} related`);
    } else if (subscribedChannels.length > 0) {
        const subSample = shuffleArray(subscribedChannels).slice(0, 3);
        personalizedSeeds = subSample.map(c => `${c.name} videos`);
    } else {
        personalizedSeeds = ["Music", "Gaming", "Vlog"];
    }

    // 2. Fetch Content
    const trendingPromise = getRecommendedVideos().then(res => res.videos).catch(() => []);
    const searchPromises = personalizedSeeds.map(query => 
        searchVideos(query, '1').then(res => ({ videos: res.videos, shorts: res.shorts })).catch(() => ({ videos: [], shorts: [] }))
    );
    
    const [trendingContent, personalizedResults] = await Promise.all([trendingPromise, Promise.all(searchPromises)]);

    // 3. Separate ALL content into videos and shorts FIRST
    const allTrendingVideos: Video[] = [];
    const allTrendingShorts: Video[] = [];
    for (const v of trendingContent) {
        if (isShortVideo(v)) {
            allTrendingShorts.push(v);
        } else {
            allTrendingVideos.push(v);
        }
    }

    const allPersonalizedVideos: Video[] = [];
    const allPersonalizedShorts: Video[] = [...personalizedResults.flatMap(r => r.shorts)];
    const personalizedVideosFromSearch = personalizedResults.flatMap(r => r.videos);
    for (const v of personalizedVideosFromSearch) {
        if (isShortVideo(v)) {
            allPersonalizedShorts.push(v);
        } else {
            allPersonalizedVideos.push(v);
        }
    }

    // 4. Filter and Dedupe
    const cleanTrendingVideos = filterAndDedupe(allTrendingVideos);
    const cleanPersonalizedVideos = filterAndDedupe(allPersonalizedVideos);
    const cleanTrendingShorts = filterAndDedupe(allTrendingShorts);
    const cleanPersonalizedShorts = filterAndDedupe(allPersonalizedShorts);

    // 5. Mix Videos
    const numTrending = Math.floor(TARGET_VIDEOS * TRENDING_VIDEO_RATIO);
    const numPersonalized = TARGET_VIDEOS - numTrending;
    
    const finalVideos = shuffleArray([
        ...shuffleArray(cleanTrendingVideos).slice(0, numTrending),
        ...shuffleArray(cleanPersonalizedVideos).slice(0, numPersonalized)
    ]);

    // 6. Mix Shorts
    const finalShorts = shuffleArray([
        ...shuffleArray(cleanTrendingShorts),
        ...shuffleArray(cleanPersonalizedShorts)
    ]).slice(0, TARGET_SHORTS);

    return { videos: finalVideos, shorts: finalShorts };
};


export const getXraiShorts = async (sources: RecommendationSource & { seenIds?: string[] }): Promise<Video[]> => {
    const { 
        watchHistory, 
        shortsHistory,
        subscribedChannels,
        hiddenVideos,
        ngChannels,
        ngKeywords,
        negativeKeywords,
        seenIds = []
    } = sources;

    // --- User Profile Construction (Simplified Two-Tower concept) ---
    // User Vector: Map<Keyword, Weight>
    const userVector = new Map<string, number>();
    const addWeight = (text: string, weight: number) => {
        extractKeywords(text).forEach(k => userVector.set(k, (userVector.get(k) || 0) + weight));
    };

    // Signal weights based on "YouTube Shorts Recommendation Analysis"
    // - Subscribed channels (Explicit intent): High
    subscribedChannels.forEach(c => addWeight(c.name, 5.0));
    
    // - Shorts history (Implicit intent, short-term): Medium-High
    //   Recently watched shorts have higher influence (simulating Recency bias)
    (shortsHistory || []).slice(0, 30).forEach((v, i) => {
        const recencyDecay = Math.exp(-i / 10);
        addWeight(v.title, 3.0 * recencyDecay);
        addWeight(v.channelName, 4.0 * recencyDecay);
    });

    // - Watch history (Long-form, implicit): Medium
    watchHistory.slice(0, 20).forEach((v, i) => {
        const recencyDecay = Math.exp(-i / 10);
        addWeight(v.title, 1.5 * recencyDecay);
        addWeight(v.channelName, 2.0 * recencyDecay);
    });

    const userMag = calculateMagnitude(userVector); // Pre-calculate magnitude for cosine similarity

    // --- Candidate Generation ---
    // Fetch a mix of Popular (Trending) and Collaborative (Search based on profile seeds)
    const popularPromise = getRecommendedVideos().then(res => res.videos.filter(isShortVideo)).catch(() => []);
    
    // Generate seeds from top keywords in User Vector
    const topKeywords = [...userVector.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(e => e[0]);
    const seeds = topKeywords.length > 0 ? topKeywords.map(k => `${k} #shorts`) : ["Funny #shorts", "Trending #shorts"];

    // Limit seeds to prevent excessive API calls
    const limitedSeeds = seeds.slice(0, 3);
    const candidatePromises = limitedSeeds.map(query => 
        searchVideos(query, '1').then(res => [...res.videos, ...res.shorts].filter(isShortVideo)).catch(() => [])
    );

    const [popularShortsRaw, ...personalizedCandidatesNested] = await Promise.all([popularPromise, ...candidatePromises]);
    const candidates = [...popularShortsRaw, ...personalizedCandidatesNested.flat()];

    // --- Filtering & Ranking ---
    const allSeenIds = new Set([
        ...(shortsHistory || []).map(v => v.id),
        ...hiddenVideos.map(v => v.id),
        ...seenIds
    ]);
    const ngChannelIds = new Set(ngChannels.map(c => c.id));

    // Scoring Function
    const scoreVideo = (video: Video): number => {
        let score = 0;
        
        // 1. Content Match (Dot Product / Cosine Similarity approximation)
        const vKeywords = [...extractKeywords(video.title), ...extractKeywords(video.channelName)];
        let dotProduct = 0;
        vKeywords.forEach(k => {
            if (userVector.has(k)) {
                dotProduct += userVector.get(k)!;
            }
        });
        // Normalize slightly to avoid just favoring long titles
        if (userMag > 0 && vKeywords.length > 0) {
            score += (dotProduct / (userMag * Math.sqrt(vKeywords.length))) * 100;
        }

        // 2. Channel Affinity
        // Boost if subscribed
        if (subscribedChannels.some(c => c.id === video.channelId)) {
            score += 50; 
        }

        // 3. Negative Signals (Hard Penalty)
        let negScore = 0;
        vKeywords.forEach(k => {
            if (negativeKeywords.has(k)) negScore += negativeKeywords.get(k)!;
        });
        score -= negScore * 20;

        // 4. Random Noise (Exploration)
        // Add a small random factor to prevent filter bubbles and static ordering
        score += Math.random() * 15;

        return score;
    };

    const uniqueCandidates = new Map<string, Video>();
    
    candidates.forEach(v => {
        // Hard Filters
        if (allSeenIds.has(v.id)) return;
        if (ngChannelIds.has(v.channelId)) return;
        const fullText = `${v.title} ${v.channelName}`.toLowerCase();
        if (ngKeywords.some(ng => fullText.includes(ng.toLowerCase()))) return;

        // Deduplicate (Keep first seen or logic could be improved to keep higher quality metadata)
        if (!uniqueCandidates.has(v.id)) {
            uniqueCandidates.set(v.id, v);
        }
    });

    const scoredCandidates = Array.from(uniqueCandidates.values()).map(v => ({
        video: v,
        score: scoreVideo(v)
    }));

    // Sort by Score Descending
    scoredCandidates.sort((a, b) => b.score - a.score);

    // Apply Post-Ranking Rules (Diversity)
    // Avoid same channel appearing consecutively
    const finalFeed: Video[] = [];
    const channelCooldown = new Map<string, number>();

    for (const item of scoredCandidates) {
        if (item.score < -50) continue; // Drop very negative scores

        const cId = item.video.channelId;
        const cooldown = channelCooldown.get(cId) || 0;
        
        if (cooldown === 0) {
            finalFeed.push(item.video);
            channelCooldown.set(cId, 3); // Must wait 3 videos before showing this channel again
            
            // Decrease cooldowns for others
            for (const [key, val] of channelCooldown.entries()) {
                if (key !== cId && val > 0) channelCooldown.set(key, val - 1);
            }
        }
    }

    // Fallback if filtering removed too many
    if (finalFeed.length < 5 && popularShortsRaw.length > 0) {
        const fallbacks = popularShortsRaw.filter(v => !allSeenIds.has(v.id)).slice(0, 10);
        // Combine ensuring unique IDs
        const existingIds = new Set(finalFeed.map(v => v.id));
        for (const fb of fallbacks) {
            if (!existingIds.has(fb.id)) {
                finalFeed.push(fb);
                existingIds.add(fb.id);
            }
        }
    }

    return finalFeed;
};
