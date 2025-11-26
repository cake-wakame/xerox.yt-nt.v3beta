
import React, { createContext, useState, useEffect, useContext, ReactNode, useCallback } from 'react';

export type Theme = 'light' | 'dark' | 'light-glass' | 'dark-glass';

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export const ThemeProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const [theme, _setTheme] = useState<Theme>('light-glass');

    const setTheme = useCallback((newTheme: Theme) => {
        _setTheme(newTheme);
        try {
            localStorage.setItem('theme', newTheme);
        } catch (e) {
            console.error("Could not save theme to localStorage", e);
        }
    }, []);

    useEffect(() => {
        try {
            const storedTheme = localStorage.getItem('theme') as Theme | null;
            if (storedTheme && ['light', 'dark', 'light-glass', 'dark-glass'].includes(storedTheme)) {
                _setTheme(storedTheme);
            }
        } catch (e) {
            console.error("Could not read theme from localStorage", e);
        }
    }, []);

    useEffect(() => {
        const root = document.documentElement;
        root.className = ''; // Clear all theme classes first
        root.classList.add(theme);
    }, [theme]);
    
    // FIX: Rewrote JSX to React.createElement to be valid in a .ts file, and added React import.
    return React.createElement(ThemeContext.Provider, { value: { theme, setTheme } }, children);
}

export const useTheme = (): ThemeContextType => {
    const context = useContext(ThemeContext);
    if (!context) {
        throw new Error('useTheme must be used within a ThemeProvider');
    }
    return context;
};
