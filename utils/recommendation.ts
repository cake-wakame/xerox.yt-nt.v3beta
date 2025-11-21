
import type { Video, Channel } from '../types';
import { searchVideos, getVideoDetails, getChannelVideos, getRecommendedVideos } from './api';

// --- Constants & Types ---

// ニュース・政治・不快コンテンツのNGワード（ユーザー体験保護のため維持）
const NOISE_BLOCK_KEYWORDS = [
    'ニュース', 'News', '報道', '政治', '首相', '大統領', '内閣', 
    '事件', '事故', '逮捕', '裁判', '速報', '会見', '訃報', '地震', 
    '津波', '災害', '炎上', '物申す', '批判', '晒し', '閲覧注意',
    '衆院選', '参院選', '選挙', '与党', '野党', '政策',
    'NHK', '日テレ', 'FNN', 'TBS', 'ANN', 'テレ東'
];

interface RecommendationSource {
    searchHistory: string[];
    watchHistory: Video[];
    subscribedChannels: Channel[];
    preferredGenres: string[]; // ユーザーが明示的に指定したタグ
    preferredChannels: string[];
    ngKeywords: string[];
    ngChannels: string[];
    page: number;
}

// --- Helpers ---

const shuffleArray = <T,>(array: T[]): T[] => {
    const newArray = [...array];
    for (let i = newArray.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
    }
    return newArray;
};

const containsJapanese = (text: string): boolean => {
    return /[一-龠]+|[ぁ-ゔ]+|[ァ-ヴー]+/.test(text);
};

// Duration parser (ISO to seconds)
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

// --- Main Validation Logic ---

const isValidRecommendation = (video: Video, source: RecommendationSource): boolean => {
    const lowerTitle = video.title.toLowerCase();
    const lowerChannel = video.channelName.toLowerCase();
    const fullText = `${lowerTitle} ${lowerChannel}`;

    // 1. Xerox Filter (アプリのブランド保護)
    if (fullText.includes('xerox') && video.channelId !== 'UCCMV3NfZk_NB-MmUvHj6aFw') {
        return false;
    }

    // 2. Noise/News Filter
    if (NOISE_BLOCK_KEYWORDS.some(word => fullText.includes(word.toLowerCase()))) {
        return false;
    }

    // 3. User Block Settings
    if (source.ngKeywords?.some(ng => fullText.includes(ng.toLowerCase()))) {
        return false;
    }
    if (source.ngChannels?.includes(video.channelId)) {
        return false;
    }

    // 4. Japanese Content Priority for Home Feed
    // (英語の学習動画などを除き、基本は日本語圏の動画を表示するほうが自然)
    // ただし、ユーザーが登録しているチャンネル等は許可
    const isSubscribed = source.subscribedChannels.some(c => c.id === video.channelId);
    if (!isSubscribed && !containsJapanese(fullText) && !containsJapanese(video.descriptionSnippet || '')) {
        // 完全に外国語の動画はおすすめから少し弾く（精度向上のため）
        // ただし音楽(Music/MV)などは許可したいが、判定が難しいため、ここでは簡易的に弾く
        // return false; // 厳しくしすぎるとコンテンツが減るため一旦コメントアウト
    }

    return true;
};

// --- Core Recommendation Engine ---

/**
 * YouTubeの「関連動画」アルゴリズムを擬似的に再現する。
 * ユーザーの履歴に基づいて「次にこれを見るべき」動画を取得する。
 */
export const getDeeplyAnalyzedRecommendations = async (sources: RecommendationSource): Promise<Video[]> => {
    const { 
        watchHistory, 
        searchHistory, 
        subscribedChannels, 
        preferredGenres,
        page 
    } = sources;

    let candidates: Video[] = [];
    const promises: Promise<Video[]>[] = [];

    // ------------------------------------------------------------
    // Strategy 1: "Continue Watching" Context (関連動画ウォーク)
    // 直近で見た動画の「関連動画」を取得する。これがYouTubeの精度に最も近い。
    // ------------------------------------------------------------
    if (watchHistory.length > 0) {
        // 最新の履歴からいくつかピックアップ（ランダム性を持たせてマンネリ防止）
        // ページが進むごとに、より古い履歴も参照する
        const historyDepth = Math.min(watchHistory.length, 5);
        const targetIndices = new Set<number>();
        
        // 常に最新1件は参照
        targetIndices.add(0); 
        // 追加でランダムに1~2件参照
        if (historyDepth > 1) targetIndices.add(Math.floor(Math.random() * historyDepth));
        
        targetIndices.forEach(index => {
            const video = watchHistory[index];
            if (video && video.id) {
                promises.push(
                    getVideoDetails(video.id)
                        .then(details => details.relatedVideos || [])
                        .catch(() => [])
                );
            }
        });
    }

    // ------------------------------------------------------------
    // Strategy 2: "Your Interests" (検索履歴ベース)
    // 過去に検索したワードで再検索し、新しい動画を探す
    // ------------------------------------------------------------
    if (searchHistory.length > 0) {
        // ランダムに1つキーワードを選ぶ
        const keyword = searchHistory[Math.floor(Math.random() * searchHistory.length)];
        // ページネーション: 深いページほど検索結果の奥を表示するわけではないが、
        // 検索クエリを変えることで多様性を出す
        promises.push(
            searchVideos(keyword, '1') // 検索は常に1ページ目で良い（精度高）
                .then(res => res.videos)
                .catch(() => [])
        );
    }

    // ------------------------------------------------------------
    // Strategy 3: "Explicit Preferences" (タグ・登録チャンネル)
    // ユーザーが明示的に「好き」と言ったもの
    // ------------------------------------------------------------
    
    // 好きなジャンル（タグ）がある場合
    if (preferredGenres.length > 0) {
        const genre = preferredGenres[Math.floor(Math.random() * preferredGenres.length)];
        promises.push(
            searchVideos(genre, '1')
                .then(res => res.videos)
                .catch(() => [])
        );
    }

    // 登録チャンネルからの新着（ホーム画面に混ぜる）
    if (subscribedChannels.length > 0) {
        // ランダムに3チャンネル選んで最新動画を取得
        const randomSubs = shuffleArray(subscribedChannels).slice(0, 3);
        randomSubs.forEach(sub => {
            promises.push(
                getChannelVideos(sub.id)
                    .then(res => res.videos.slice(0, 5)) // 最新5件くらい
                    .catch(() => [])
            );
        });
    }

    // ------------------------------------------------------------
    // Strategy 4: "General Popularity" (急上昇・フォールバック)
    // 履歴が少ない場合や、多様性のために急上昇を混ぜる
    // ------------------------------------------------------------
    if (watchHistory.length < 5 || page === 1) {
        promises.push(
            getRecommendedVideos() // API側の急上昇(Trending)
                .then(res => res.videos)
                .catch(() => [])
        );
    }

    // 全リクエストの解決
    const results = await Promise.all(promises);
    results.forEach(videos => candidates.push(...videos));

    // ------------------------------------------------------------
    // Filtering & Deduplication
    // ------------------------------------------------------------
    const uniqueVideos: Video[] = [];
    const seenIds = new Set<string>();
    
    // 既に履歴にある動画は、おすすめから除外するか？
    // YouTubeは「もう一度見る」を出すが、ここでは新しい発見を優先して除外気味にする
    // ただし、直近10件以外は許容する
    const recentHistoryIds = new Set(watchHistory.slice(0, 10).map(v => v.id));

    // シャッフルしてからフィルタリング（偏りを防ぐ）
    candidates = shuffleArray(candidates);

    for (const video of candidates) {
        if (!video.id) continue;
        if (seenIds.has(video.id)) continue;
        if (recentHistoryIds.has(video.id)) continue; // 直近見た動画は出さない

        if (isValidRecommendation(video, sources)) {
            seenIds.add(video.id);
            uniqueVideos.push(video);
        }
    }

    return uniqueVideos;
};
