import React, { useState, useCallback, useEffect } from 'react';
import * as ReactRouterDOM from 'react-router-dom';
import Header from './components/Header';
import Sidebar from './components/Sidebar';
import BottomNavigation from './components/BottomNavigation';
import HomePage from './pages/HomePage';
import SearchResultsPage from './pages/SearchResultsPage';
import ChannelPage from './pages/ChannelPage';
import YouPage from './pages/YouPage';
import PlaylistPage from './pages/PlaylistPage';
import ShortsPage from './pages/ShortsPage';
import SubscriptionsPage from './pages/SubscriptionsPage';
import HistoryPage from './pages/HistoryPage';
import VideoPlayerPage from './pages/VideoPlayerPage';
import { useTheme } from './hooks/useTheme';
import { AiProvider } from './contexts/AiContext';

const { Routes, Route, useLocation } = ReactRouterDOM;

const App: React.FC = () => {
  const { theme } = useTheme();
  const location = useLocation();
  const isPlayerPage = location.pathname.startsWith('/watch');
  const isShortsPage = location.pathname === '/shorts';

  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(!isPlayerPage);

  useEffect(() => {
    if (isPlayerPage) {
        setIsSidebarOpen(false);
    } else if (!isShortsPage) {
        setIsSidebarOpen(true);
    }
  }, [location.pathname, isPlayerPage, isShortsPage]);

  const toggleSidebar = useCallback(() => {
    setIsSidebarOpen(prev => !prev);
  }, []);

  const getMargin = () => {
    if (isShortsPage) return ''; 
    if (isSidebarOpen) return 'md:ml-60'; 
    if (isPlayerPage && !isSidebarOpen) return ''; 
    return 'md:ml-[72px]';
  };

  const mainContentMargin = getMargin();
  const mainContentPadding = isShortsPage ? '' : 'p-0 md:p-6 pb-16 md:pb-6'; 
  
  const shouldShowSidebar = () => {
    if (isShortsPage) return false;
    if (isPlayerPage && !isSidebarOpen) return false; 
    return true;
  };

  const appBgClass = theme.includes('glass') ? 'bg-transparent' : 'bg-yt-white dark:bg-yt-black';

  return (
    <AiProvider>
        <div className={`min-h-screen ${appBgClass}`}>
        <Header 
            toggleSidebar={toggleSidebar} 
        />
        <div className="flex">
            {shouldShowSidebar() && <Sidebar isOpen={isSidebarOpen} />}
            <main key={location.pathname} className={`flex-1 mt-14 ${mainContentMargin} ${mainContentPadding} transition-all duration-300 ease-in-out ml-0 overflow-x-hidden animate-fade-in-main`}>
            <Routes>
                <Route path="/" element={<HomePage />} />
                <Route path="/watch/:videoId" element={<VideoPlayerPage />} />
                <Route path="/results" element={<SearchResultsPage />} />
                <Route path="/channel/:channelId" element={<ChannelPage />} />
                <Route path="/you" element={<YouPage />} />
                <Route path="/playlist/:playlistId" element={<PlaylistPage />} />
                <Route path="/shorts" element={<ShortsPage />} />
                <Route path="/subscriptions" element={<SubscriptionsPage />} />
                <Route path="/history" element={<HistoryPage />} />
                <Route path="*" element={<HomePage />} />
            </Routes>
            </main>
        </div>
        <BottomNavigation />
        </div>
    </AiProvider>
  );
};

export default App;