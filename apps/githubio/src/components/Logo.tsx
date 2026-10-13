import React from 'react';

interface LogoProps {
  className?: string;
  showText?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

export function Logo({ className = '', showText = true, size = 'md' }: LogoProps) {
  const iconSizes = {
    sm: 'w-7 h-7',
    md: 'w-9 h-9',
    lg: 'w-12 h-12'
  };

  const textSizes = {
    sm: 'text-xl',
    md: 'text-2xl',
    lg: 'text-3xl'
  };

  return (
    <div className={`flex items-center gap-3 select-none ${className}`}>
      {/* Faceted Shield Emblem */}
      <div className={`relative ${iconSizes[size]} shrink-0 flex items-center justify-center`}>
        <svg viewBox="0 0 100 100" className="w-full h-full drop-shadow-[0_0_12px_rgba(56,189,248,0.4)]" fill="none">
          <defs>
            <linearGradient id="shieldGradComp" x1="10%" y1="0%" x2="90%" y2="100%">
              <stop offset="0%" stopColor="#38bdf8" />
              <stop offset="50%" stopColor="#6366f1" />
              <stop offset="100%" stopColor="#0284c7" />
            </linearGradient>
            <linearGradient id="coreGradComp" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#ffffff" />
              <stop offset="40%" stopColor="#38bdf8" />
              <stop offset="100%" stopColor="#818cf8" />
            </linearGradient>
          </defs>

          {/* Outer Shield with Gradient Border */}
          <polygon
            points="50,8 86,25 86,56 50,91 14,56 14,25"
            fill="#090d16"
            stroke="url(#shieldGradComp)"
            strokeWidth="4"
            strokeLinejoin="round"
          />

          {/* Inner Inset Shield */}
          <polygon
            points="50,18 76,31 76,51 50,76 24,51 24,31"
            fill="#0f172a"
            stroke="#38bdf8"
            strokeWidth="1.2"
            strokeOpacity="0.4"
            strokeLinejoin="round"
          />

          {/* Circuit Routing Lines */}
          <path d="M 50 18 L 50 35 M 26 33 L 42 42 M 74 33 L 58 42 M 28 55 L 42 62 M 72 55 L 58 62" stroke="#38bdf8" strokeWidth="1.8" strokeLinecap="round" opacity="0.65" />

          {/* E-Nexus Core */}
          <path d="M 40 37 L 62 37" stroke="url(#coreGradComp)" strokeWidth="4.5" strokeLinecap="round" />
          <path d="M 40 48 L 57 48" stroke="url(#coreGradComp)" strokeWidth="4.5" strokeLinecap="round" />
          <path d="M 40 59 L 62 59" stroke="url(#coreGradComp)" strokeWidth="4.5" strokeLinecap="round" />
          <path d="M 40 37 L 40 59" stroke="url(#coreGradComp)" strokeWidth="4.5" strokeLinecap="round" />

          {/* Glowing Vertex Dots */}
          <circle cx="50" cy="8" r="3" fill="#38bdf8" />
          <circle cx="86" cy="25" r="3" fill="#6366f1" />
          <circle cx="86" cy="56" r="3" fill="#38bdf8" />
          <circle cx="50" cy="91" r="3" fill="#6366f1" />
          <circle cx="14" cy="56" r="3" fill="#38bdf8" />
          <circle cx="14" cy="25" r="3" fill="#6366f1" />
        </svg>
      </div>

      {/* Typography */}
      {showText && (
        <div className="flex flex-col leading-none">
          <span className={`font-black tracking-tighter text-white ${textSizes[size]}`}>
            ELUV<span className="text-sky-400">I</span><span className="text-indigo-400">X</span>
          </span>
          {size !== 'sm' && (
            <span className="text-[9px] font-bold tracking-[0.2em] text-sky-400/80 uppercase mt-0.5">
              Sovereign AI Router
            </span>
          )}
        </div>
      )}
    </div>
  );
}
export default Logo;
