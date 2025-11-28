import React from 'react';
// FIX: Use named import for Link from react-router-dom
import { Link } from 'react-router-dom';
import type { Video } from '../types';

interface ShortsCardProps {
  video: Video;
}

const ShortsCard: React.FC<ShortsCardProps> = ({ video }) => {
  return (
    <Link to={`/watch/${video.id}`} className="w-44 flex-shrink-0 group">
      <div className="relative rounded-xl overflow-hidden">
        <img 
          src={video.thumbnailUrl} 
          alt={video.title} 
          className="w-full h-auto aspect-[9/16] object-cover group-hover:scale-105 transition-transform duration-300" 
        />
      </div>
      <div className="mt-2 pr-2">
        <h3 className="text-black dark:text-white text-base font-medium leading-snug break-words max-h-12 overflow-hidden line-clamp-2">
          {video.title}
        </h3>
        <p className="text-yt-light-gray text-sm mt-1">{video.views}</p>
      </div>
    </Link>
  );
};

export default ShortsCard;